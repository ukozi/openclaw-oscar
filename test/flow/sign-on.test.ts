import { afterEach, describe, expect, it } from 'vitest';
import { strongHash } from '../../src/oscar/auth.js';
import { BosClient } from '../../src/oscar/bos.js';
import { ByteReader, toHex } from '../../src/oscar/bytes.js';
import { openConnection } from '../../src/oscar/connection.js';
import { decodeTlvs, findTlv, hasTlv, tlvStr, tlvU8 } from '../../src/oscar/tlv.js';
import { ManualTimers, RawClient, captureLog, makeSession, settle, stopAllSessions, waitFor } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';
import type { FakeGeneration } from '../fake/oscar-server.js';

let server: FakeOscarServer;

async function boot(opts: Parameters<typeof FakeOscarServer.start>[0] = {}): Promise<FakeOscarServer> {
  server = await FakeOscarServer.start(opts);
  server.addUser('Bot One', 'botpass1');
  return server;
}

afterEach(async () => {
  await stopAllSessions();
  await server.stop();
});

const id = (s: { family: number; subtype: number }): string => `${s.family.toString(16)}/${s.subtype.toString(16)}`;

describe.each<FakeGeneration>(['v0.24', 'main'])('sign-on against %s', (generation) => {
  it('logs in with BUCP and brings BOS up in the required order', async () => {
    await boot({ generation });
    const h = makeSession(server);
    h.session.start();
    await h.online();
    // The offline retrieve goes out just after the session reports online.
    await waitFor(() => server.snacsFrom('botone').filter((s) => s.conn === 'bos').length >= 8, 'eight BOS SNACs');

    const sent = server.snacsFrom('botone');
    expect(sent.filter((s) => s.conn === 'auth').slice(0, 2).map(id)).toEqual(['17/6', '17/2']);
    expect(sent.filter((s) => s.conn === 'bos').slice(0, 8).map(id)).toEqual([
      '1/17',
      '1/6',
      '1/8',
      '2/4',
      '3/4',
      '1/2',
      '1/e',
      '4/10',
    ]);
  });
});

describe('sign-on details', () => {
  it('sends only the strong hash, flag 0x03, a short client id and no cookie-lifetime TLV', async () => {
    await boot();
    const h = makeSession(server);
    h.session.start();
    await h.online();
    const login = server.snacsFrom('botone').find((s) => s.conn === 'auth' && s.subtype === 0x02);
    const tlvs = decodeTlvs(login?.body ?? new Uint8Array());
    expect(tlvs.map((t) => t.tag)).toEqual([0x01, 0x25, 0x03, 0x4a]);
    expect(tlvStr(tlvs, 0x01)).toBe('botone');
    expect(toHex(findTlv(tlvs, 0x25) ?? new Uint8Array())).toBe(toHex(strongHash('botpass1', 'salt-botone')));
    expect(tlvStr(tlvs, 0x03)).toBe('openclaw-oscar');
    expect(tlvU8(tlvs, 0x4a)).toBe(0x03);
    expect(hasTlv(tlvs, 0x133a)).toBe(false);
  });

  it('announces OService 1, subscribes to every rate class, publishes the chat capability and its buddies', async () => {
    await boot();
    const h = makeSession(server, { buddies: () => ['Alice', 'bob', 'alice', ''] });
    h.session.start();
    await h.online();
    const bos = server.snacsFrom('botone').filter((s) => s.conn === 'bos');
    const body = (family: number, subtype: number): Uint8Array =>
      bos.find((s) => s.family === family && s.subtype === subtype)?.body ?? new Uint8Array();
    expect(toHex(body(1, 0x17))).toBe('0001000100020001000300010004' + '0001');
    expect(toHex(body(1, 0x08))).toBe('00010002000300040005');
    expect(toHex(findTlv(decodeTlvs(body(2, 0x04)), 0x05) ?? new Uint8Array())).toBe('748f2420628711d18222444553540000');
    const names: string[] = [];
    const r = new ByteReader(body(3, 0x04));
    while (r.remaining > 0) names.push(r.str8());
    expect(names).toEqual(['alice', 'bob']);
  });

  it('brings BOS up when HostOnline arrived before bring-up began', async () => {
    await boot();
    const { tlvs, client } = await RawClient.login(server.port, 'botone', 'botpass1');
    client.close();
    const timers = new ManualTimers();
    const conn = await openConnection({
      host: '127.0.0.1',
      port: server.port,
      tls: false,
      cookie: findTlv(tlvs, 0x06),
      log: captureLog().log,
      timers: timers.api,
    });
    await settle(server.port);
    const callbacks = { im: () => {}, presence: () => {}, rate: () => {}, channel2: () => {} };
    const bos = new BosClient(conn, { log: captureLog().log, now: timers.now, timers: timers.api, defaultPort: server.port, callbacks });
    expect(await bos.bringUp([])).toEqual({ screenName: 'Bot One', bot: false });
    conn.destroy();
    expect(timers.pending()).toEqual([]);
  });

  it('still sends BuddyAddBuddies with an empty list, or the account would never appear online', async () => {
    await boot();
    const h = makeSession(server, { buddies: () => [] });
    h.session.start();
    await h.online();
    expect(server.snacsFrom('botone').some((s) => s.family === 3 && s.subtype === 4 && s.body.length === 0)).toBe(true);
    expect(server.sessionOf('botone')?.contactsInit).toBe(true);
  });

  it('reads the canonical screen name and the bot flag from its own user info', async () => {
    server = await FakeOscarServer.start();
    server.addUser('Bot One', 'botpass1', { bot: true });
    const h = makeSession(server);
    h.session.start();
    await h.online();
    expect(h.session.selfInfo()).toEqual({ screenName: 'Bot One', bot: true });
  });

  it('reports the bot flag as off for an ordinary account', async () => {
    await boot();
    const h = makeSession(server);
    expect(h.session.selfInfo()).toBeNull();
    h.session.start();
    await h.online();
    expect(h.session.selfInfo()).toEqual({ screenName: 'Bot One', bot: false });
  });

  it('stops for good on a bad password', async () => {
    await boot();
    const h = makeSession(server, { getPassword: async () => 'wrongpass' });
    h.session.start();
    const state = await h.phase('fatal');
    expect(state.reason).toBe('bad-password');
    expect(h.timers.pending()).toEqual([]);
  });

  it('stops for good on an unknown screen name', async () => {
    await boot();
    const h = makeSession(server, { screenName: 'nobody' });
    h.session.start();
    expect((await h.phase('fatal')).reason).toBe('unknown-name');
  });

  it('never sends a screen name under two bytes', async () => {
    await boot();
    const h = makeSession(server, { screenName: 'x' });
    h.session.start();
    expect((await h.phase('fatal')).reason).toBe('unknown-name');
    expect(server.snacsFrom('x')).toEqual([]);
  });

  it('reads the password fresh for every login', async () => {
    await boot();
    let reads = 0;
    const h = makeSession(server, {
      getPassword: async () => {
        reads++;
        return 'botpass1';
      },
    });
    h.session.start();
    await h.online();
    server.dropSocket('botone', 'bos');
    await h.phase('backoff');
    await h.timers.advance(3000);
    await h.online();
    expect(reads).toBe(2);
  });

  it('keeps the password, the login hash and cookies out of the log at every level', async () => {
    await boot();
    const h = makeSession(server);
    h.session.start();
    await h.online();
    await h.session.stop();
    const text = h.logs.text();
    expect(text).toContain('oscar session state');
    expect(text).not.toContain('botpass1');
    expect(text).not.toMatch(/[0-9a-f]{32,}/i);
    expect(text).not.toMatch(/[A-Za-z0-9+/]{40,}={0,2}/);
  });
});

describe('presence', () => {
  it('sees buddies arrive, go away, come back and leave', async () => {
    await boot();
    const alice = server.peer('Alice');
    const h = makeSession(server);
    h.session.start();
    await h.online();
    expect(h.session.presenceOf('Alice')).toMatchObject({ online: true, away: false, bot: false });
    expect(h.session.presenceOf('bob')).toBeUndefined();

    alice.setAway('out');
    await expect.poll(() => h.session.presenceOf('alice')?.away).toBe(true);
    alice.setAway(null);
    await expect.poll(() => h.session.presenceOf('alice')?.away).toBe(false);
    alice.signOff();
    await expect.poll(() => h.session.presenceOf('alice')?.online).toBe(false);
    expect(h.presence.map((p) => [p.name, p.online, p.away])).toEqual([
      ['alice', true, false],
      ['alice', true, true],
      ['alice', true, false],
      ['alice', false, false],
    ]);
  });

  it('flags a bot-flagged buddy', async () => {
    await boot();
    server.addUser('bottwo', 'x', { bot: true });
    server.peer('bottwo');
    const h = makeSession(server, { buddies: () => ['bottwo'] });
    h.session.start();
    await h.online();
    expect(h.session.presenceOf('bottwo')?.bot).toBe(true);
  });

  it('adds and removes buddies when the list changes', async () => {
    await boot();
    let list = ['alice', 'bob'];
    const h = makeSession(server, { buddies: () => list });
    h.session.start();
    await h.online();
    list = ['bob', 'mallory'];
    h.session.updateBuddies();
    await expect.poll(() => server.snacsFrom('botone').filter((s) => s.family === 3).length).toBe(3);
    const [, add, del] = server.snacsFrom('botone').filter((s) => s.family === 3);
    expect([add?.subtype, new ByteReader(add?.body ?? new Uint8Array()).str8()]).toEqual([4, 'mallory']);
    expect([del?.subtype, new ByteReader(del?.body ?? new Uint8Array()).str8()]).toEqual([5, 'alice']);
  });
});
