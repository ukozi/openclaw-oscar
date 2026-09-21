import { describe, expect, it } from 'vitest';
import {
  applyRoomClosed,
  applyRoomJoin,
  applyRoomLeave,
  applyRoomReady,
  joinedRooms,
  pushRecentLine,
  roomKey,
  roomsExt,
  touchActivity,
} from '../../src/runtime.js';
import { KEY, ROOM, makeRt } from './rooms-fixtures.js';

describe('room state', () => {
  it('keys a room by its canonical target', () => {
    expect(roomKey(ROOM)).toBe(KEY);
    expect(roomKey({ exchange: 5, name: 'lobby' })).toBe('room:5:lobby');
  });

  it('keeps one ext object per runtime', () => {
    const rt = makeRt();
    expect(roomsExt(rt)).toBe(roomsExt(rt));
    expect(roomsExt(rt).home.status).toBe('unset');
  });

  it('ready records occupants, join times and the joined flag', () => {
    const rt = makeRt();
    const state = applyRoomReady(rt, ROOM, ['botone', 'Alice'], 'botone', 500);
    expect([...state.occupants].sort()).toEqual(['alice', 'botone']);
    expect(state.joinSeenAt.get('alice')).toBe(500);
    expect(state.selfJoinedAt).toBe(500);
    expect(state.omittedCount).toBe(0);
    expect(state.aloneSince).toBeUndefined();
    expect(rt.rooms.get(KEY)).toBe(state);
    expect(joinedRooms(rt)).toEqual([ROOM]);
  });

  it('ready with nobody else starts the alone clock', () => {
    const rt = makeRt();
    expect(applyRoomReady(rt, ROOM, ['botone'], 'botone', 500).aloneSince).toBe(500);
  });

  it('treats a raw screen name as itself when counting company', () => {
    const rt = makeRt();
    expect(applyRoomReady(rt, ROOM, ['botone'], 'BotOne', 500).aloneSince).toBe(500);
  });

  it('join and leave move the alone clock', () => {
    const rt = makeRt();
    applyRoomReady(rt, ROOM, ['botone', 'alice'], 'botone', 500);
    const left = applyRoomLeave(rt, ROOM, 'alice', 'botone', 600);
    expect(left?.aloneSince).toBe(600);
    expect(left?.occupants.has('alice')).toBe(false);
    const back = applyRoomJoin(rt, ROOM, 'Bob', 'botone', 700);
    expect(back?.aloneSince).toBeUndefined();
    expect(back?.joinSeenAt.get('bob')).toBe(700);
  });

  it('ignores roster events for a room it is not in', () => {
    const rt = makeRt();
    expect(applyRoomJoin(rt, ROOM, 'bob', 'botone', 1)).toBeUndefined();
    expect(applyRoomLeave(rt, ROOM, 'bob', 'botone', 1)).toBeUndefined();
  });

  it('a close that will rejoin keeps what must survive', () => {
    const rt = makeRt();
    roomsExt(rt).invitedBy.set(KEY, 'bob');
    const first = applyRoomReady(rt, ROOM, ['botone', 'bob'], 'botone', 500);
    first.omittedCount = 3;
    first.lastBotLine = { from: 'botone', at: 550 };
    applyRoomClosed(rt, ROOM, true);
    expect(joinedRooms(rt)).toEqual([]);
    expect(rt.rooms.get(KEY)?.occupants.size).toBe(0);
    const again = applyRoomReady(rt, ROOM, ['botone', 'bob'], 'botone', 900);
    expect(again.invitedBy).toBe('bob');
    expect(again.omittedCount).toBe(3);
    expect(again.lastBotLine).toEqual({ from: 'botone', at: 550 });
    expect(again.selfJoinedAt).toBe(900);
  });

  it('a final close forgets the room', () => {
    const rt = makeRt();
    const ext = roomsExt(rt);
    ext.invitedBy.set(KEY, 'bob');
    applyRoomReady(rt, ROOM, ['botone', 'bob'], 'botone', 500);
    ext.history.set(KEY, [{ sender: 'bob (approved)', body: 'hi' }]);
    pushRecentLine(rt, KEY, { from: 'bob', role: 'approved', text: 'hi', at: 510 });
    touchActivity(rt, KEY, 510);
    applyRoomClosed(rt, ROOM, false);
    expect(rt.rooms.has(KEY)).toBe(false);
    expect(ext.invitedBy.has(KEY)).toBe(false);
    expect(ext.history.has(KEY)).toBe(false);
    expect(ext.recentLines.has(KEY)).toBe(false);
    expect(ext.activity.has(KEY)).toBe(false);
  });

  it('keeps the last 20 recent lines', () => {
    const rt = makeRt();
    for (let i = 0; i < 25; i += 1) pushRecentLine(rt, KEY, { from: 'bob', role: 'approved', text: `l${i}`, at: i });
    const lines = roomsExt(rt).recentLines.get(KEY) ?? [];
    expect(lines).toHaveLength(20);
    expect(lines[0]?.text).toBe('l5');
  });
});
