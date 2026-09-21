import { afterEach, describe, expect, it } from 'vitest';
import { encodeImFragments } from '../../src/oscar/bos.js';
import { tlv } from '../../src/oscar/tlv.js';
import { makeSession, stopAllSessions, waitFor } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';
import type { FakeGeneration } from '../fake/oscar-server.js';

let server: FakeOscarServer;

afterEach(async () => {
  await stopAllSessions();
  await server.stop();
});

describe.each<FakeGeneration>(['v0.24', 'main'])('offline replay against %s', (generation) => {
  it('does not take a stored message from an account named like the server notice for one', async () => {
    server = await FakeOscarServer.start({ generation });
    server.addUser('botone', 'botpass1');
    const text = new Uint8Array(Buffer.from('trust me', 'utf8'));
    server.peer('OOS System Msg').sendRaw('botone', 1, [tlv.bytes(0x02, encodeImFragments(0, text)), tlv.empty(0x06)], 0n);
    expect(server.storedFor('botone')).toHaveLength(1);

    const h = makeSession(server);
    h.session.start();
    await h.online();
    await waitFor(() => h.ims.length === 2, 'the replay and the real notice');
    expect(h.ims.find((m) => m.offline)).toMatchObject({ from: 'oossystemmsg', text: 'trust me', cookie: 0n, system: false });
    expect(h.ims.filter((m) => m.system).map((m) => m.text)).toEqual(['You just received 1 IM(s) while you were offline.']);
  });

  it('asks for stored messages only after ClientOnline and marks each replay', async () => {
    server = await FakeOscarServer.start({ generation });
    server.addUser('botone', 'botpass1');
    const alice = server.peer('alice');
    alice.storeOfflineIm('botone', 'first <kept>', 7200);
    alice.storeOfflineIm('botone', 'second', 60);
    server.peer('mallory').storeOfflineIm('botone', 'psst', 30);

    const h = makeSession(server);
    h.session.start();
    await h.online();
    await waitFor(() => h.ims.length === 4, 'three replays and the server notice');

    const bos = server.snacsFrom('botone').filter((s) => s.conn === 'bos');
    const online = bos.findIndex((s) => s.family === 1 && s.subtype === 0x02);
    const retrieve = bos.findIndex((s) => s.family === 4 && s.subtype === 0x10);
    expect(online).toBeGreaterThanOrEqual(0);
    expect(retrieve).toBeGreaterThan(online);

    const notice = h.ims.find((m) => m.system);
    expect(notice).toMatchObject({ from: 'oossystemmsg', cookie: 0n, offline: false });
    expect(notice?.text).toContain('3 IM(s)');

    const replays = h.ims.filter((m) => !m.system);
    expect(replays.map((m) => [m.from, m.text, m.offline])).toEqual([
      ['alice', 'first <kept>', true],
      ['alice', 'second', true],
      ['mallory', 'psst', true],
    ]);
    const age = (i: number): number => Math.round((Date.now() - (replays[i]?.sentAt ?? 0)) / 1000);
    expect(age(0)).toBeGreaterThanOrEqual(7199);
    expect(age(0)).toBeLessThanOrEqual(7205);
    expect(age(1)).toBeLessThanOrEqual(65);
    expect(server.storedFor('botone')).toEqual([]);
  });

  it('marks live messages as not offline', async () => {
    server = await FakeOscarServer.start({ generation });
    server.addUser('botone', 'botpass1');
    const h = makeSession(server);
    h.session.start();
    await h.online();
    server.peer('alice').sendIm('botone', 'live');
    await waitFor(() => h.ims.length === 1, 'IM');
    expect(h.ims[0]).toMatchObject({ offline: false, system: false });
    expect(h.ims[0]?.sentAt).toBeUndefined();
  });
});
