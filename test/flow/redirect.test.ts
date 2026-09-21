import { afterEach, describe, expect, it } from 'vitest';
import { ByteReader } from '../../src/oscar/bytes.js';
import { RedirectRefusedError } from '../../src/oscar/connection.js';
import { decodeTlvs, hasTlv } from '../../src/oscar/tlv.js';
import { makeSession, stopAllSessions, waitFor } from '../fake/oscar-client.js';
import type { Harness } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';

let server: FakeOscarServer;

afterEach(async () => {
  await stopAllSessions();
  await server.stop();
});

async function boot(opts: Parameters<typeof FakeOscarServer.start>[0]): Promise<void> {
  server = await FakeOscarServer.start(opts);
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
    const where = await h.session.resolveService(0x000d);
    expect(where).toMatchObject({ host: '127.0.0.1', port: server.port, pinned: false });
    expect(where.cookie).toHaveLength(256);
    expect(where.expiresAt).toBe(h.timers.now() + 60_000);
    expect(serviceRequests()).toEqual([{ family: 0x000d, useSsl: false }]);
  });

  it('rejects a service request while BOS is down', async () => {
    await boot({});
    const h = makeSession(server);
    await expect(h.session.resolveService(0x000d)).rejects.toMatchObject({ code: 'not-online' });
    expect(serviceRequests()).toEqual([]);
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
    const plain = await FakeOscarServer.start({});
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
    const where = await h.session.resolveService(0x000d);
    expect(where).toMatchObject({ host: '127.0.0.1', port: server.port, pinned: true });
    expect(where.expiresAt).toBe(h.timers.now() + 60_000);
    expect(serviceRequests()).toEqual([
      { family: 0x000d, useSsl: true },
      { family: 0x000d, useSsl: false },
    ]);
  });

  it('asks once with TLV 0x8C on main and follows the SSL answer', async () => {
    await boot({ tls: true, generation: 'main' });
    const h = makeSession(server);
    h.session.start();
    await h.online();
    const where = await h.session.resolveService(0x000d);
    expect(where).toMatchObject({ host: '127.0.0.1', port: server.port, pinned: false });
    expect(serviceRequests()).toEqual([{ family: 0x000d, useSsl: true }]);
  });

  it('auto pins a plaintext service answer from a server with no SSL host', async () => {
    await boot({ tls: true, generation: 'main', sslHost: false, advertisedHost: '127.0.0.1:1' });
    const h = makeSession(server);
    h.session.start();
    await h.online();
    expect(await h.session.resolveService(0x000d)).toMatchObject({ host: '127.0.0.1', port: server.port, pinned: true });
    expect(serviceRequests()).toEqual([{ family: 0x000d, useSsl: true }]);
  });

  it('follow refuses a plaintext service answer and stays online', async () => {
    await boot({ tls: true, generation: 'main' });
    const h = makeSession(server, { redirect: 'follow' });
    h.session.start();
    await h.online();
    server.sslHost = false;
    const error = await h.session.resolveService(0x000d).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RedirectRefusedError);
    expect(error).toMatchObject({ reason: 'tls' });
    expect(serviceRequests()).toEqual([{ family: 0x000d, useSsl: true }]);
    expect(h.session.getState().phase).toBe('online');
  });

  it('gives up on a service the server does not offer instead of looping', async () => {
    await boot({ tls: true, generation: 'main' });
    const h = makeSession(server);
    h.session.start();
    await h.online();
    await expect(h.session.resolveService(0x0010)).rejects.toThrow('service request refused');
    await waitFor(() => serviceRequests().length === 2, 'two requests');
    expect(h.session.getState().phase).toBe('online');
  });
});
