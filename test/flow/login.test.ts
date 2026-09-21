import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { CLIENT_ID, bucpLogin, probeLogin, strongHash } from '../../src/oscar/auth.js';
import { fromHex } from '../../src/oscar/bytes.js';
import { openConnection } from '../../src/oscar/connection.js';
import type { OscarConnection } from '../../src/oscar/connection.js';
import { decodeTlvs, findTlv, tlvStr, tlvU8 } from '../../src/oscar/tlv.js';
import { ManualTimers, captureLog, settle, waitFor } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';

let server: FakeOscarServer;
const timers = new ManualTimers();

afterEach(async () => {
  await server.stop();
});

function connect(): Promise<OscarConnection> {
  return openConnection({ host: '127.0.0.1', port: server.port, tls: false, log: captureLog().log, timers: timers.api });
}

function login(name: string, password: string) {
  return connect().then((conn) => bucpLogin(conn, timers.api, name, 5190, (key) => strongHash(password, key)));
}

describe('bucpLogin', () => {
  it('returns the address, the cookie and the SSL state', async () => {
    server = await FakeOscarServer.start({ advertisedHost: 'bos.example.net:5191' });
    server.addUser('botone', 'botpass1');
    const result = await login('botone', 'botpass1');
    expect(result).toMatchObject({ ok: true, host: 'bos.example.net', port: 5191, ssl: false });
    expect(result.ok && result.cookie).toHaveLength(256);
  });

  it('falls back to the configured port when the address has none', async () => {
    server = await FakeOscarServer.start({ advertisedHost: 'bos.example.net' });
    server.addUser('botone', 'botpass1');
    expect(await login('botone', 'botpass1')).toMatchObject({ ok: true, host: 'bos.example.net', port: 5190 });
  });

  it('asks for the hash only once the challenge key is known', async () => {
    server = await FakeOscarServer.start();
    server.addUser('botone', 'botpass1');
    const keys: string[] = [];
    const conn = await connect();
    const result = await bucpLogin(conn, timers.api, 'botone', 5190, async (key) => {
      keys.push(key);
      return strongHash('botpass1', key);
    });
    expect(result.ok).toBe(true);
    expect(keys).toEqual(['salt-botone']);
    expect(conn.isOpen).toBe(false);
  });

  it('sends the single-session flag and the client id, and no other credential TLV', async () => {
    server = await FakeOscarServer.start();
    server.addUser('botone', 'botpass1');
    expect((await login('botone', 'botpass1')).ok).toBe(true);
    const sent = server.snacsFrom('botone').find((s) => s.subtype === 0x02);
    const tlvs = decodeTlvs(sent?.body ?? new Uint8Array());
    expect(tlvs.map((t) => t.tag)).toEqual([0x01, 0x25, 0x03, 0x4a]);
    expect(tlvU8(tlvs, 0x4a)).toBe(0x03);
    expect(tlvStr(tlvs, 0x03)).toBe(CLIENT_ID);
    expect(findTlv(tlvs, 0x25)).toHaveLength(16);
  });

  it('maps a bad password and an unknown name', async () => {
    server = await FakeOscarServer.start();
    server.addUser('botone', 'botpass1');
    expect(await login('botone', 'wrongpass')).toMatchObject({ ok: false, reason: 'bad-password', code: 5 });
    expect(await login('nobody', 'whatever')).toMatchObject({ ok: false, reason: 'unknown-name', code: 1 });
  });

  it('reads the limiter in its signoff shape and in its SNAC shape', async () => {
    server = await FakeOscarServer.start({ loginLimit: 1 });
    server.addUser('botone', 'botpass1');
    const fresh = await FakeOscarServer.start({ loginLimit: 0 });
    try {
      const conn = await openConnection({ host: '127.0.0.1', port: fresh.port, tls: false, log: captureLog().log, timers: timers.api });
      expect(await bucpLogin(conn, timers.api, 'botone', 5190, (key) => strongHash('botpass1', key))).toMatchObject({
        ok: false,
        reason: 'login-rate-limited',
        code: 0x1d,
      });
    } finally {
      await fresh.stop();
    }
    expect((await login('botone', 'botpass1')).ok).toBe(true);
    expect(await login('botone', 'botpass1')).toMatchObject({ ok: false, reason: 'login-rate-limited', code: 0x1d });
  });

  it('never sends a screen name under two bytes', async () => {
    server = await FakeOscarServer.start({ disableAuth: true });
    expect(await login('x', 'botpass1')).toMatchObject({ ok: false, reason: 'unknown-name' });
    expect(server.snacsFrom('x')).toEqual([]);
  });

  it('reports a server that hangs up mid-login as a network fault', async () => {
    server = await FakeOscarServer.start();
    server.addUser('botone', 'botpass1');
    const conn = await connect();
    await server.restart();
    const result = await bucpLogin(conn, timers.api, 'botone', 5190, (key) => strongHash('botpass1', key));
    expect(result).toMatchObject({ ok: false, reason: 'network' });
  });

  it('gives up after 20 s of silence', async () => {
    server = await FakeOscarServer.start();
    const mute = net.createServer((socket) => {
      socket.on('error', () => {});
      socket.write(fromHex('2a010064000400000001'));
    });
    await new Promise<void>((resolve) => mute.listen(0, '127.0.0.1', resolve));
    try {
      const local = new ManualTimers();
      const conn = await openConnection({
        host: '127.0.0.1',
        port: (mute.address() as net.AddressInfo).port,
        tls: false,
        log: captureLog().log,
        timers: local.api,
      });
      const result = bucpLogin(conn, local.api, 'botone', 5190, (key) => strongHash('botpass1', key));
      // The other two pending timers are the connection's keepalive and probe.
      await waitFor(() => local.pending().length === 3, 'the reply timer');
      expect(local.pending()).toEqual([20_000, 60_000, 90_000]);
      await local.advance(20_000);
      expect(await result).toMatchObject({ ok: false, reason: 'network', detail: 'login timed out' });
      expect(conn.isOpen).toBe(false);
      expect(local.pending()).toEqual([]);
    } finally {
      mute.close();
    }
  });
});

describe('probeLogin', () => {
  it('says the server checks passwords when a random hash is refused', async () => {
    server = await FakeOscarServer.start();
    server.addUser('botone', 'botpass1');
    expect(await probeLogin(await connect(), timers.api, 'botone')).toBe('checks');
    expect(await probeLogin(await connect(), timers.api, 'nobody')).toBe('checks');
  });

  it('says it does not when the random hash is accepted, and never presents the cookie', async () => {
    server = await FakeOscarServer.start({ disableAuth: true });
    server.addUser('botone', 'botpass1');
    expect(await probeLogin(await connect(), timers.api, 'botone')).toBe('does-not-check');
    await settle(server.port);
    expect(server.sessionOf('botone')).toBeUndefined();
    expect(server.snacsFrom('botone').every((s) => s.conn === 'auth')).toBe(true);
  });

  it('uses a different random hash each time', async () => {
    server = await FakeOscarServer.start();
    server.addUser('botone', 'botpass1');
    await probeLogin(await connect(), timers.api, 'botone');
    await probeLogin(await connect(), timers.api, 'botone');
    const hashes = server
      .snacsFrom('botone')
      .filter((s) => s.subtype === 0x02)
      .map((s) => Buffer.from(s.body).toString('hex'));
    expect(hashes).toHaveLength(2);
    expect(hashes[0]).not.toBe(hashes[1]);
  });

  it('says unknown when the limiter answers', async () => {
    server = await FakeOscarServer.start({ loginLimit: 0 });
    expect(await probeLogin(await connect(), timers.api, 'botone')).toBe('unknown');
  });
});
