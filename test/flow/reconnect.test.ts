import { afterEach, describe, expect, it } from 'vitest';
import { makeSession, settle, stopAllSessions, waitFor } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';

let server: FakeOscarServer;

afterEach(async () => {
  await stopAllSessions();
  await server.stop();
});

async function boot(opts: Parameters<typeof FakeOscarServer.start>[0] = {}): Promise<void> {
  server = await FakeOscarServer.start(opts);
  server.addUser('botone', 'botpass1', { bot: true });
}

describe('reconnect', () => {
  it('backs off about 2 s after a dropped socket, then signs on again with its buddies', async () => {
    await boot();
    const h = makeSession(server);
    h.session.start();
    await h.online();
    server.dropSocket('botone', 'bos');
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
    await server.restart();
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
    server.dropSocket('botone', 'bos');
    await h.phase('backoff');
    await h.timers.advance(2400);
    await h.online();
    server.dropSocket('botone', 'bos');
    expect((await h.phase('backoff')).attempts).toBe(2);
    await h.timers.advance(4800);
    await h.online();
    await h.timers.advance(60_000);
    server.dropSocket('botone', 'bos');
    expect((await h.phase('backoff')).attempts).toBe(1);
  });

  it('stop() signs off, goes quiet and can be started again', async () => {
    await boot();
    const h = makeSession(server);
    h.session.start();
    await h.online();
    await h.session.stop();
    expect(h.session.getState().phase).toBe('stopped');
    await waitFor(() => server.sessionOf('botone') === undefined, 'server session gone');
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
    expect(server.sessionOf('botone')).toBeUndefined();
    expect(h.states.map((s) => s.phase)).toEqual(['connecting', 'stopped']);
  });

  it('stop() as BOS bring-up begins closes that connection too', async () => {
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
    expect(server.sessionOf('botone')).toBeUndefined();
    expect(server.snacsFrom('botone').filter((s) => s.conn === 'bos')).toEqual([]);
    expect(h.states.map((s) => s.phase)).toEqual(['connecting', 'stopped']);
  });

  it('stop() before the login even starts does the same', async () => {
    await boot();
    const h = makeSession(server);
    h.session.start();
    await h.session.stop();
    await settle(server.port);
    expect(h.session.getState().phase).toBe('stopped');
    expect(server.sessionOf('botone')).toBeUndefined();
  });

  it('stop() during backoff cancels the retry', async () => {
    await boot();
    const h = makeSession(server);
    h.session.start();
    await h.online();
    server.dropSocket('botone', 'bos');
    await h.phase('backoff');
    await h.session.stop();
    await h.timers.advance(10_000);
    expect(h.session.getState().phase).toBe('stopped');
    expect(server.sessionOf('botone')).toBeUndefined();
  });
});

describe('login limiter', () => {
  it('waits at least 60 s when a first-time address is limited with a bare signoff', async () => {
    await boot({ loginLimit: 0 });
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
    server.dropSocket('botone', 'bos');
    await h.phase('backoff');
    await h.timers.advance(h.timers.pending()[0] ?? 0);
    await waitFor(() => h.session.getState().reason === 'login-rate-limited', 'limited');
    expect(h.timers.pending()[0]).toBeGreaterThanOrEqual(60_000);
  });
});
