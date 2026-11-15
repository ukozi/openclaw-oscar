import { afterEach, describe, expect, it } from 'vitest';
import { ByteReader, decodeTlvs, hasTlv } from 'open-oscar-client-kit/wire';
import { waitFor } from 'open-oscar-client-kit/testing';
import type { FakeOscarServer } from 'open-oscar-client-kit/testing';
import { startServer } from '../fake/kit.js';
import { makeSession, stopAllSessions } from '../fake/session-harness.js';
import type { Harness } from '../fake/session-harness.js';

let server: FakeOscarServer;

afterEach(async () => {
  await stopAllSessions();
  await server.stop();
});

async function boot(opts: Parameters<typeof startServer>[0]): Promise<void> {
  server = await startServer(opts);
  server.addUser('botone', 'botpass1', { bot: true });
}

function opened(h: Harness): { conn: unknown; host: unknown; port: unknown; tls: unknown }[] {
  return h.logs.lines
    .filter((l) => l.msg === 'oscar connection open')
    .map((l) => ({ conn: l.fields?.['conn'], host: l.fields?.['host'], port: l.fields?.['port'], tls: l.fields?.['tls'] }));
}

function serviceRequests(): { family: number; useSsl: boolean }[] {
  return server
    .snacsFrom('botone')
    .filter((s) => s.conn === 'bos' && s.family === 1 && s.subtype === 4)
    .map((s) => {
      const r = new ByteReader(s.body);
      return { family: r.u16(), useSsl: hasTlv(decodeTlvs(r.rest()), 0x8c) };
    });
}

const DEN = { exchange: 4 as const, name: 'den' };
const navRequests = (): { family: number; useSsl: boolean }[] => serviceRequests().filter((r) => r.family === 0x000d);
const navOpened = (h: Harness): unknown[] => opened(h).filter((o) => o.conn === 'chatnav');

describe('plaintext redirects', () => {
  it('follow goes where the server says', async () => {
    await boot({});
    const h = makeSession(server, { host: 'localhost', redirect: 'follow' });
    h.session.start();
    await h.online();
    expect(opened(h).slice(0, 2)).toEqual([
      { conn: 'auth', host: 'localhost', port: server.port, tls: false },
      { conn: 'bos', host: '127.0.0.1', port: server.port, tls: false },
    ]);
  });

  it('pin stays on the configured address whatever the server says', async () => {
    await boot({ advertisedHost: '127.0.0.1:1' });
    const h = makeSession(server, { host: 'localhost', redirect: 'pin' });
    h.session.start();
    await h.online();
    expect(opened(h)[1]).toEqual({ conn: 'bos', host: 'localhost', port: server.port, tls: false });
  });

  it('follow of a dead address backs off as a network failure', async () => {
    await boot({ advertisedHost: '127.0.0.1:1' });
    const h = makeSession(server, { redirect: 'follow' });
    h.session.start();
    expect((await h.phase('backoff')).reason).toBe('network');
  });

  it('pins when the advertised address cannot be parsed', async () => {
    await boot({ advertisedHost: ':0' });
    const h = makeSession(server, { redirect: 'follow' });
    h.session.start();
    await h.online();
    expect(opened(h)[1]).toMatchObject({ conn: 'bos', host: '127.0.0.1', port: server.port });
  });

  it('sends no TLV 0x8C on a service request', async () => {
    await boot({});
    const h = makeSession(server);
    h.session.start();
    await h.online();
    await h.session.joinRoom(DEN);
    expect(navRequests()).toEqual([{ family: 0x000d, useSsl: false }]);
    expect(navOpened(h)).toEqual([{ conn: 'chatnav', host: '127.0.0.1', port: server.port, tls: false }]);
  });

  it('rejects a room join while BOS is down, with no service request', async () => {
    await boot({});
    const h = makeSession(server);
    await expect(h.session.joinRoom(DEN)).rejects.toMatchObject({ code: 'not-online' });
    expect(serviceRequests()).toEqual([]);
  });

  it('gives up on a service request the server refuses instead of looping', async () => {
    await boot({});
    const h = makeSession(server);
    h.session.start();
    await h.online();
    server.failNext(0x0001, 0x0004, { code: 0x0005 });
    await expect(h.session.joinRoom(DEN)).rejects.toMatchObject({ code: 'unavailable' });
    expect(navRequests()).toEqual([{ family: 0x000d, useSsl: false }]);
    expect(h.session.getState().phase).toBe('online');
    await h.session.joinRoom(DEN);
    expect(navRequests()).toHaveLength(2);
  });
});

describe('TLS redirects', () => {
  it('auto pins on v0.24, which always advertises plaintext, and never leaves TLS', async () => {
    await boot({ tls: true, generation: 'v0.24', advertisedHost: '127.0.0.1:1' });
    const h = makeSession(server);
    h.session.start();
    await h.online();
    expect(opened(h).slice(0, 2)).toEqual([
      { conn: 'auth', host: '127.0.0.1', port: server.port, tls: true },
      { conn: 'bos', host: '127.0.0.1', port: server.port, tls: true },
    ]);
  });

  it('auto follows on main, which marks the redirect as SSL', async () => {
    await boot({ tls: true, generation: 'main' });
    const h = makeSession(server, { host: 'localhost' });
    h.session.start();
    await h.online();
    expect(opened(h)[1]).toEqual({ conn: 'bos', host: '127.0.0.1', port: server.port, tls: true });
  });

  it('follow on v0.24 fails the plaintext answer with reason tls and never dials it', async () => {
    const plain = await startServer({});
    try {
      await boot({ tls: true, generation: 'v0.24', advertisedHost: `127.0.0.1:${plain.port}` });
      const h = makeSession(server, { redirect: 'follow' });
      h.session.start();
      const state = await h.phase('backoff');
      expect(state.reason).toBe('tls');
      expect(state.detail).toContain(`127.0.0.1:${plain.port}`);
      expect(opened(h)).toEqual([{ conn: 'auth', host: '127.0.0.1', port: server.port, tls: true }]);
    } finally {
      await plain.stop();
    }
  });

  it('follow on main follows the SSL answer', async () => {
    await boot({ tls: true, generation: 'main' });
    const h = makeSession(server, { redirect: 'follow' });
    h.session.start();
    await h.online();
    expect(opened(h)[1]).toEqual({ conn: 'bos', host: '127.0.0.1', port: server.port, tls: true });
  });

  it('refuses a certificate it cannot verify', async () => {
    await boot({ tls: true });
    const h = makeSession(server, { caFile: undefined });
    h.session.start();
    expect((await h.phase('backoff')).reason).toBe('tls');
  });

  it('retries a service request once without TLV 0x8C when v0.24 answers 0x01/0x01, and pins', async () => {
    await boot({ tls: true, generation: 'v0.24', advertisedHost: '127.0.0.1:1' });
    const h = makeSession(server);
    h.session.start();
    await h.online();
    await h.session.joinRoom(DEN);
    expect(navRequests()).toEqual([
      { family: 0x000d, useSsl: true },
      { family: 0x000d, useSsl: false },
    ]);
    expect(navOpened(h)).toEqual([{ conn: 'chatnav', host: '127.0.0.1', port: server.port, tls: true }]);
  });

  it('asks once with TLV 0x8C on main and follows the SSL answer', async () => {
    await boot({ tls: true, generation: 'main' });
    const h = makeSession(server, { host: 'localhost' });
    h.session.start();
    await h.online();
    await h.session.joinRoom(DEN);
    expect(navRequests()).toEqual([{ family: 0x000d, useSsl: true }]);
    expect(navOpened(h)).toEqual([{ conn: 'chatnav', host: '127.0.0.1', port: server.port, tls: true }]);
  });

  it('auto pins a plaintext service answer from a server with no SSL host', async () => {
    await boot({ tls: true, generation: 'main', sslHost: false, advertisedHost: '127.0.0.1:1' });
    const h = makeSession(server);
    h.session.start();
    await h.online();
    await h.session.joinRoom(DEN);
    expect(navRequests()).toEqual([{ family: 0x000d, useSsl: true }]);
    expect(navOpened(h)).toEqual([{ conn: 'chatnav', host: '127.0.0.1', port: server.port, tls: true }]);
  });

  it('follow refuses a plaintext service answer and stays online', async () => {
    await boot({ tls: true, generation: 'main' });
    const h = makeSession(server, { redirect: 'follow' });
    h.session.start();
    await h.online();
    server.setSslHost(false);
    await expect(h.session.joinRoom(DEN)).rejects.toMatchObject({ code: 'unavailable' });
    expect(navRequests()).toEqual([{ family: 0x000d, useSsl: true }]);
    expect(navOpened(h)).toEqual([]);
    expect(h.session.getState().phase).toBe('online');
  });

  it('gives up on a service the server refuses with and without SSL instead of looping', async () => {
    await boot({ tls: true, generation: 'main', refuseSsl: true });
    const h = makeSession(server);
    h.session.start();
    await h.online();
    // Hold the first refusal back until the second is armed.
    const release = server.withhold(0x0001, 0x0001);
    const joining = h.session.joinRoom(DEN);
    const refused = expect(joining).rejects.toMatchObject({ code: 'unavailable' });
    await waitFor(() => navRequests().length === 1, 'the SSL request');
    server.failNext(0x0001, 0x0004, { code: 0x0005 });
    release();
    await refused;
    expect(navRequests()).toEqual([
      { family: 0x000d, useSsl: true },
      { family: 0x000d, useSsl: false },
    ]);
    expect(navOpened(h)).toEqual([]);
    expect(h.session.getState().phase).toBe('online');
  });
});
