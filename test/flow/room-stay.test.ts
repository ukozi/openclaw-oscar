import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('openclaw/plugin-sdk/channel-inbound', () => ({ runChannelInboundEvent: vi.fn() }));
vi.mock('openclaw/plugin-sdk/reply-chunking', async () => (await import('../fake/openclaw.js')).replyChunking);

import { encodePeerId } from '../../src/names.js';
import type { RoomRef } from '../../src/names.js';
import { leaveRoomNow } from '../../src/rooms/leave.js';
import { roomKey, roomsExt } from '../../src/runtime.js';
import { roomPeer } from '../fake/kit.js';
import type { RoomPeer } from '../fake/kit.js';
import { startRoomFlow } from './rooms-harness.js';
import type { RoomFlow } from './rooms-harness.js';

const ROOM: RoomRef = { exchange: 4, name: 'testroom' };
const DEN: RoomRef = { exchange: 4, name: 'bobsden' };
const WAIT = { timeout: 20_000, interval: 20 };

let flow: RoomFlow | undefined;

afterEach(async () => {
  await flow?.stop();
  flow = undefined;
});

async function joined(f: RoomFlow, room: RoomRef): Promise<void> {
  await vi.waitFor(() => expect(roomsExt(f.rt).joined.has(roomKey(room))).toBe(true), WAIT);
}

async function seated(f: RoomFlow, room: RoomRef, name: string): Promise<void> {
  await joined(f, room);
  await vi.waitFor(() => expect(f.rt.rooms.get(roomKey(room))?.occupants.has(name)).toBe(true), WAIT);
}

let cookie = 100n;

async function turnPeer(f: RoomFlow, peer: RoomPeer, room: RoomRef, text: string): Promise<string> {
  const before = f.turns.length;
  peer.say(room, text, { cookie: cookie++ });
  await vi.waitFor(() => expect(f.turns).toHaveLength(before + 1), WAIT);
  const turn = f.turns[before];
  if (turn?.peer.kind !== 'room') throw new Error('not a room turn');
  return encodePeerId(turn.peer);
}

async function rejoined(f: RoomFlow, from: number, room: RoomRef, name: string): Promise<void> {
  await vi.waitFor(() => expect(f.closed.slice(from)).toContainEqual({ room, willRejoin: true }), WAIT);
  await seated(f, room, name);
}

describe('room stay', () => {
  it('keeps the room stay after a rejoin the bot did not choose', async () => {
    flow = await startRoomFlow({ fastReconnect: true });
    const f = flow;
    await joined(f, ROOM);
    const alice = roomPeer(f.server, 'alice');
    alice.joinRoom(ROOM);
    await seated(f, ROOM, 'alice');
    const first = await turnPeer(f, alice, ROOM, 'botone: first');
    expect(first).toMatch(/^botone#4\.testroom~[0-9a-f]+$/);

    let from = f.closed.length;
    f.server.rooms.dropChat('botone', ROOM);
    await rejoined(f, from, ROOM, 'alice');
    expect(await turnPeer(f, alice, ROOM, 'botone: after the room closed')).toBe(first);

    from = f.closed.length;
    f.server.dropSocket('botone');
    await rejoined(f, from, ROOM, 'alice');
    expect(await turnPeer(f, alice, ROOM, 'botone: after the sign-on dropped')).toBe(first);
  });

  it('starts a new room stay after the bot leaves and joins again', async () => {
    flow = await startRoomFlow({ fastReconnect: true });
    const f = flow;
    await joined(f, ROOM);
    const bob = roomPeer(f.server, 'bob');
    bob.joinRoom(DEN);
    bob.invite('botone', DEN, 'come in');
    await seated(f, DEN, 'bob');
    const first = await turnPeer(f, bob, DEN, 'anyone there?');
    expect(first).toMatch(/^botone#4\.bobsden~[0-9a-f]+$/);

    expect(await leaveRoomNow(f.rt, DEN, f.policy())).toBe('left');
    expect(f.rt.rooms.has(roomKey(DEN))).toBe(false);
    bob.invite('botone', DEN, 'come back');
    await seated(f, DEN, 'bob');
    const second = await turnPeer(f, bob, DEN, 'welcome back');
    expect(second).toMatch(/^botone#4\.bobsden~[0-9a-f]+$/);
    expect(second).not.toBe(first);
  });
});
