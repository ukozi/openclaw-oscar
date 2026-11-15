import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { settle, waitFor } from 'open-oscar-client-kit/testing';
import type { FakeOscarServer } from 'open-oscar-client-kit/testing';
import { RATE_CLASS_IM, RATE_CODE_ALERT, RATE_CODE_LIMITED } from 'open-oscar-client-kit/wire';
import { clearBos, limitBos, restart, startServer } from '../fake/kit.js';
import { makeSession, stopAllSessions } from '../fake/session-harness.js';

let server: FakeOscarServer;

afterEach(async () => {
  await stopAllSessions();
  await server.stop();
});

async function boot(opts: Parameters<typeof startServer>[0] = {}, bot = true): Promise<void> {
  server = await startServer(opts);
  server.addUser('botone', 'botpass1', { bot });
}

// A TCP relay to the server; with redirect pin, BOS goes through it too.
type Relay = { port: number; toBot(): net.Socket; close(): void };
const relays: net.Server[] = [];

async function relay(to: number): Promise<Relay> {
  const sockets: net.Socket[] = [];
  const srv = net.createServer((bot) => {
    const up = net.connect(to, '127.0.0.1');
    bot.pipe(up);
    up.pipe(bot);
    for (const [a, b] of [[bot, up], [up, bot]] as const) {
      a.on('error', () => b.destroy());
      a.on('close', () => b.destroy());
    }
    sockets.push(bot, up);
  });
  relays.push(srv);
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  return {
    port: (srv.address() as AddressInfo).port,
    toBot: () => sockets.at(-2) as net.Socket,
    close: () => {
      for (const socket of sockets) socket.destroy();
      srv.close();
    },
  };
}

afterEach(() => {
  for (const srv of relays.splice(0)) srv.close();
});

describe('reconnect', () => {
  it('backs off about 2 s after a dropped socket, then signs on again with its buddies', async () => {
    await boot();
    const h = makeSession(server);
    h.session.start();
    await h.online();
    server.dropSocket('botone');
    const state = await h.phase('backoff');
    expect(state).toMatchObject({ reason: 'network', attempts: 1 });
    expect(h.session.presenceOf('alice')).toBeUndefined();
    const [delay] = h.timers.pending();
    expect(delay).toBeGreaterThanOrEqual(2000);
    expect(delay).toBeLessThanOrEqual(2400);
    await h.timers.advance(1999);
    expect(h.session.getState().phase).toBe('backoff');
    await h.timers.advance(401);
    await h.online();
    expect(server.snacsFrom('botone').filter((s) => s.family === 3 && s.subtype === 4)).toHaveLength(2);
    expect(h.states.map((s) => s.phase)).toEqual(['connecting', 'online', 'backoff', 'connecting', 'online']);
  });

  it('doubles the wait, then holds a 60 s floor after three straight failures', async () => {
    await boot();
    const h = makeSession(server);
    h.session.start();
    await h.online();
    await server.stop();
    const waits: number[] = [];
    for (let i = 1; i <= 4; i++) {
      await waitFor(() => h.session.getState().phase === 'backoff' && h.session.getState().attempts === i, `failure ${i}`);
      const [delay] = h.timers.pending();
      waits.push(delay ?? -1);
      await h.timers.advance(delay ?? 0);
    }
    expect(waits[0]).toBeGreaterThanOrEqual(2000);
    expect(waits[0]).toBeLessThanOrEqual(2400);
    expect(waits[1]).toBeGreaterThanOrEqual(4000);
    expect(waits[1]).toBeLessThanOrEqual(4800);
    expect(waits[2]).toBeGreaterThanOrEqual(60_000);
    expect(waits[2]).toBeLessThanOrEqual(72_000);
    expect(waits[3]).toBeGreaterThanOrEqual(60_000);
  });

  it('logs in afresh after a server restart, because the old cookie died with the process', async () => {
    await boot();
    const h = makeSession(server);
    h.session.start();
    await h.online();
    await restart(server);
    await h.phase('backoff');
    await h.timers.advance(2400);
    await h.online();
    expect(server.snacsFrom('botone').filter((s) => s.conn === 'auth' && s.subtype === 0x02).length).toBeGreaterThanOrEqual(2);
  });

  it('forgets earlier failures once it has stayed online for a minute', async () => {
    await boot();
    const h = makeSession(server);
    h.session.start();
    await h.online();
    server.dropSocket('botone');
    await h.phase('backoff');
    await h.timers.advance(2400);
    await h.online();
    server.dropSocket('botone');
    expect((await h.phase('backoff')).attempts).toBe(2);
    await h.timers.advance(4800);
    await h.online();
    await h.timers.advance(60_000);
    server.dropSocket('botone');
    expect((await h.phase('backoff')).attempts).toBe(1);
  });

  it('stop() signs off, goes quiet and can be started again', async () => {
    await boot();
    const h = makeSession(server);
    h.session.start();
    await h.online();
    await h.session.stop();
    expect(h.session.getState().phase).toBe('stopped');
    await waitFor(() => server.instancesOf('botone') === 0, 'server session gone');
    expect(h.timers.pending()).toEqual([]);
    h.session.start();
    await h.online();
  });

  it('stop() while the login waits for the password never leaves a live session behind', async () => {
    await boot();
    let release: (pw: string) => void = () => {};
    const h = makeSession(server, { getPassword: () => new Promise<string>((resolve) => (release = resolve)) });
    h.session.start();
    await waitFor(() => server.snacsFrom('botone').some((s) => s.conn === 'auth' && s.subtype === 0x06), 'challenge requested');
    await h.session.stop();
    release('botpass1');
    await settle(server.port);
    await h.timers.advance(200_000);
    await settle(server.port);
    expect(h.session.getState().phase).toBe('stopped');
    expect(server.instancesOf('botone')).toBe(0);
    expect(h.states.map((s) => s.phase)).toEqual(['connecting', 'stopped']);
  });

  it('stop() during the BOS bring-up closes that connection too', async () => {
    await boot();
    const h = makeSession(server, {
      buddies: () => {
        void h.session.stop();
        return [];
      },
    });
    h.session.start();
    await h.phase('stopped');
    await settle(server.port);
    expect(server.instancesOf('botone')).toBe(0);
    // The buddy list is read part-way through the bring-up: what came before it is out, client online is not.
    const bos = server.snacsFrom('botone').filter((s) => s.conn === 'bos').map((s) => `${s.family.toString(16)}/${s.subtype.toString(16)}`);
    expect(bos).toEqual(['1/17', '1/6', '1/8', '2/2', '2/4', '4/4']);
    expect(h.states.map((s) => s.phase)).toEqual(['connecting', 'stopped']);
  });

  it('stop() before the login even starts does the same', async () => {
    await boot();
    const h = makeSession(server);
    h.session.start();
    await h.session.stop();
    await settle(server.port);
    expect(h.session.getState().phase).toBe('stopped');
    expect(server.instancesOf('botone')).toBe(0);
  });

  it('stop() during backoff cancels the retry', async () => {
    await boot();
    const h = makeSession(server);
    h.session.start();
    await h.online();
    server.dropSocket('botone');
    await h.phase('backoff');
    await h.session.stop();
    await h.timers.advance(10_000);
    expect(h.session.getState().phase).toBe('stopped');
    expect(server.instancesOf('botone')).toBe(0);
  });
});

describe('what the status says after a drop', () => {
  it('gives the close kind as the detail after a reset connection', async () => {
    await boot();
    const r = await relay(server.port);
    const h = makeSession(server, { port: r.port, redirect: 'pin' });
    h.session.start();
    await h.online();
    r.toBot().resetAndDestroy();
    expect(await h.phase('backoff')).toMatchObject({ reason: 'network', detail: 'error' });
    r.close();
  });

  it('reports a TLS error on a live connection as network', async () => {
    await boot({ tls: true });
    const r = await relay(server.port);
    const h = makeSession(server, { port: r.port, redirect: 'pin' });
    h.session.start();
    await h.online();
    // An application-data record that cannot be decrypted.
    r.toBot().write(Buffer.from('170303001000000000000000000000000000000000', 'hex'));
    expect(await h.phase('backoff')).toMatchObject({ reason: 'network', detail: 'error' });
    r.close();
  });

  it('reports a TLS error at login as tls', async () => {
    await boot({ tls: true });
    const h = makeSession(server, { caFile: undefined });
    h.session.start();
    expect(await h.phase('backoff')).toMatchObject({ reason: 'tls' });
  });

  it('says rate limit only when the IM class was limited in the 30 s before the sign-off', async () => {
    await boot({}, false);
    const h = makeSession(server);
    h.session.start();
    await h.online();
    const detailAfterKick = async (): Promise<string | undefined> => {
      server.kick('botone');
      const state = await h.phase('backoff');
      await h.timers.advance(h.timers.pending()[0] ?? 0);
      await h.online();
      return state.detail;
    };

    // An alert on the IM class, and a limit on another class.
    for (let i = 0; i < 40 && server.rateNotices('botone').at(-1)?.code !== RATE_CODE_ALERT; i++) server.spend('botone', RATE_CLASS_IM, 1);
    const generalLimited = (): boolean => server.rateNotices('botone').some((n) => n.classId === 1 && n.code === RATE_CODE_LIMITED);
    for (let i = 0; i < 200 && !generalLimited(); i++) server.spend('botone', 1, 1);
    expect(generalLimited()).toBe(true);
    await settle(server.port);
    expect(await detailAfterKick()).toBe('signed on elsewhere or kicked');
    for (const id of [1, RATE_CLASS_IM]) server.setRateParams('botone', id, { currentLevel: 6000 });

    limitBos(server, 'botone');
    await waitFor(() => h.rates.at(-1)?.status === 'limited', 'limited');
    clearBos(server, 'botone');
    await waitFor(() => h.rates.at(-1)?.status === 'clear', 'clear');
    await h.timers.advance(30_001);
    expect(await detailAfterKick()).toBe('signed on elsewhere or kicked');

    limitBos(server, 'botone');
    await waitFor(() => h.rates.at(-1)?.status === 'limited', 'limited');
    expect(await detailAfterKick()).toBe('rate limit');
  });
});

describe('login limiter', () => {
  it('waits at least 60 s when a first-time address is limited with a bare signoff', async () => {
    await boot({ loginLimit: 0, limiterShape: 'signoff' });
    const h = makeSession(server);
    h.session.start();
    const state = await h.phase('backoff');
    expect(state.reason).toBe('login-rate-limited');
    expect(h.timers.pending()[0]).toBeGreaterThanOrEqual(60_000);
  });

  it('reads the SNAC shape the same way once the address is known to speak BUCP', async () => {
    await boot({ loginLimit: 1 });
    const h = makeSession(server);
    h.session.start();
    await h.online();
    server.dropSocket('botone');
    await h.phase('backoff');
    await h.timers.advance(h.timers.pending()[0] ?? 0);
    await waitFor(() => h.session.getState().reason === 'login-rate-limited', 'limited');
    expect(h.timers.pending()[0]).toBeGreaterThanOrEqual(60_000);
  });
});
