import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { settle, waitFor } from 'open-oscar-client-kit/testing';
import type { FakeOscarServer, SnacRecord } from 'open-oscar-client-kit/testing';
import type { InviteEvent } from '../../src/oscar/types.js';
import { imTexts, roomPeer, startServer } from '../fake/kit.js';
import { makeSession, stopAllSessions } from '../fake/session-harness.js';

const ROOM = { exchange: 4 as const, name: 'snacroom' };
const ICON = Uint8Array.from(Buffer.from('GIF89a', 'latin1'));

const ALLOWED = new Set<string>([
  '0x17/0x6', // BUCP challenge request
  '0x17/0x2', // BUCP login
  '0x1/0x17', // client versions
  '0x1/0x6', // rate parameters query
  '0x1/0x8', // rate class subscription
  '0x1/0x2', // client online
  '0x1/0xe', // own user info query, also the liveness probe
  '0x1/0x4', // service request
  '0x2/0x2', // Locate rights query
  '0x2/0x4', // Locate info: capabilities, profile, away text
  '0x3/0x4', // session buddy list add
  '0x4/0x4', // ICBM parameter query
  '0x4/0x10', // offline message retrieval
  '0x4/0x6', // IM
  '0x4/0x14', // typing notice
  '0xd/0x8', // room create by name
  '0xe/0x5', // room line
]);

const key = (s: { family: number; subtype: number }): string => `0x${s.family.toString(16)}/0x${s.subtype.toString(16)}`;
const families = (snacs: SnacRecord[]): number[] => [...new Set(snacs.map((s) => s.family))];
const serviceRequestsFor = (server: FakeOscarServer, name: string): number[] =>
  server
    .snacsFrom(name)
    .filter((s) => s.family === 0x0001 && s.subtype === 0x0004)
    .map((s) => Buffer.from(s.body).readUInt16BE(0));

let server: FakeOscarServer;
let sent: SnacRecord[];

beforeAll(async () => {
  server = await startServer();
  server.addUser('botone', 'botpass1');
  const alice = server.peer('alice');
  alice.setIcon(ICON);
  server.peer('bob');
  const h = makeSession(server);
  const invites: InviteEvent[] = [];
  h.session.on('invite', (e) => invites.push(e));
  h.session.start();
  await h.online();
  expect(server.iconOf('alice')).not.toBeNull();
  // Two minutes online, so the liveness probe goes out and is answered.
  for (let i = 0; i < 4; i++) {
    await h.timers.advance(30_000);
    await settle(server.port);
  }

  alice.sendIm('botone', 'hello bot');
  await waitFor(() => h.ims.length === 1, 'the IM');
  await h.session.sendIm('alice', 'hello alice');
  h.session.sendTyping('alice', 'typing');
  h.session.sendTyping('alice', 'none');
  await waitFor(() => server.snacsFrom('botone').filter((s) => s.family === 4 && s.subtype === 0x14).length === 2, 'typing');
  await h.session.setAway('Working on something.');
  await h.session.setAway(null);

  const host = roomPeer(server, 'alice');
  host.joinRoom(ROOM);
  host.invite('botone', ROOM);
  await waitFor(() => invites.length === 1, 'the invitation');
  await h.session.joinInvited(invites[0] as InviteEvent);
  await h.session.sendRoom(ROOM, 'hello room');
  await h.session.leaveRoom(ROOM);
  await stopAllSessions();
  await waitFor(() => server.instancesOf('botone') === 0, 'signed off');
  expect(imTexts(alice).map((m) => m.text)).toEqual(['hello alice']);
  sent = server.snacsFrom('botone');
});

afterAll(async () => {
  await server.stop();
});

describe('the SNACs a scripted session sends', () => {
  it('sends no SNAC type outside its list', () => {
    for (const s of sent) expect(ALLOWED.has(key(s)), key(s)).toBe(true);
  });

  it('never touches the server-side buddy list or the icon service', () => {
    expect(families(sent)).not.toContain(0x13);
    expect(serviceRequestsFor(server, 'botone')).not.toContain(0x10);
  });
});
