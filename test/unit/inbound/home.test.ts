import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('openclaw/plugin-sdk/channel-inbound', () => ({ runChannelInboundEvent: vi.fn() }));

import { copy } from '../../../src/copy.js';
import type { RootPolicy } from '../../../src/config.js';
import { attachRooms } from '../../../src/inbound/home.js';
import { roomIssues } from '../../../src/inbound/issues.js';
import { setRoomBrain } from '../../../src/inbound/room.js';
import type { RoomRef } from '../../../src/names.js';
import { applyRoomReady, roomsExt } from '../../../src/runtime.js';
import { KEY, ROOM, fakeSession, flush, line, makeRt, manualTimers, policyFixture, roomDeps } from '../rooms-fixtures.js';

const DEN: RoomRef = { exchange: 4, name: 'bobsden' };
const DEN_KEY = 'room:4:bobsden';
const detachers: (() => void)[] = [];

function setup(over: Partial<RootPolicy> = {}, online = true) {
  const fake = fakeSession();
  if (!online) fake.setPhase('connecting');
  const rt = makeRt(fake.session);
  const clock = manualTimers();
  const d = roomDeps({ now: clock.now, timers: clock.timers });
  d.setPolicy(policyFixture(over));
  const detach = attachRooms(rt, d.deps);
  detachers.push(detach);
  return { fake, rt, clock, detach, ...d };
}

afterEach(() => {
  for (const detach of detachers.splice(0)) detach();
  setRoomBrain('botone', null);
});

describe('home room', () => {
  it('joins persistently when the session comes online', async () => {
    const s = setup({}, false);
    expect(s.fake.calls.joinRoom).toEqual([]);
    s.fake.setPhase('online');
    s.fake.emit('state', { phase: 'online', since: 0, attempts: 0 });
    await flush();
    expect(s.fake.calls.joinRoom).toEqual([{ room: ROOM, persistent: true }]);
    expect(roomsExt(s.rt).home.status).toBe('pending');
    s.fake.emit('roomReady', { room: ROOM, occupants: ['BotOne', 'alice'] });
    expect(roomsExt(s.rt).home.status).toBe('joined');
    expect(s.rt.rooms.get(KEY)?.occupants.has('alice')).toBe(true);
  });

  it('joins at once when attached to a session that is already online', async () => {
    const s = setup();
    await flush();
    expect(s.fake.calls.joinRoom).toHaveLength(1);
  });

  it('does nothing without a configured room', async () => {
    const s = setup({ room: undefined });
    await flush();
    expect(s.fake.calls.joinRoom).toEqual([]);
    expect(roomsExt(s.rt).home.status).toBe('unset');
  });

  it('leaves rejoining after a reconnect to the session', async () => {
    const s = setup();
    await flush();
    s.fake.emit('roomReady', { room: ROOM, occupants: ['botone'] });
    s.fake.emit('roomClosed', { room: ROOM, willRejoin: true });
    expect(roomsExt(s.rt).home.status).toBe('pending');
    s.fake.emit('state', { phase: 'online', since: 1, attempts: 0 });
    await flush();
    expect(s.fake.calls.joinRoom).toHaveLength(1);
    s.fake.emit('roomReady', { room: ROOM, occupants: ['botone'] });
    expect(roomsExt(s.rt).home.status).toBe('joined');
  });

  it('reports a missing exchange 5 room and leaves the retry to the session', async () => {
    const ref: RoomRef = { exchange: 5, name: 'testroom' };
    const fake = fakeSession();
    fake.fail.joinRoom = Object.assign(new Error('no such room'), { code: 'no-such-room' });
    const rt = makeRt(fake.session);
    const clock = manualTimers();
    const d = roomDeps({ now: clock.now, timers: clock.timers });
    d.setPolicy(policyFixture({ room: { ref, historyFrom: 'listed', notifyOnUnlistedJoin: true } }));
    detachers.push(attachRooms(rt, d.deps));
    await flush();
    expect(roomsExt(rt).home).toEqual({ status: 'missing', detail: 'no such room' });
    fake.emit('state', { phase: 'online', since: 1, attempts: 0 });
    clock.advance(3_600_000);
    await flush();
    expect(fake.calls.joinRoom).toHaveLength(1);
    expect(clock.pending()).toBe(0);
    fake.emit('roomReady', { room: ref, occupants: ['botone'] });
    expect(roomsExt(rt).home).toEqual({ status: 'joined' });
    expect(roomIssues(rt, d.deps.policy(), 'botone')).toEqual([]);
  });

  it('reports any other failure until the room is ready', async () => {
    const fake = fakeSession();
    fake.fail.joinRoom = new Error('socket closed');
    const rt = makeRt(fake.session);
    const d = roomDeps();
    detachers.push(attachRooms(rt, d.deps));
    await flush();
    expect(roomsExt(rt).home).toEqual({ status: 'failed', detail: 'socket closed' });
    fake.emit('roomReady', { room: ROOM, occupants: ['botone'] });
    expect(roomsExt(rt).home).toEqual({ status: 'joined' });
  });

  it('asks again when the home room closes for good', async () => {
    const s = setup();
    await flush();
    s.fake.emit('roomReady', { room: ROOM, occupants: ['botone'] });
    s.fake.emit('roomClosed', { room: ROOM, willRejoin: false });
    await flush();
    expect(s.fake.calls.joinRoom).toHaveLength(2);
    expect(roomsExt(s.rt).home.status).toBe('pending');
  });
});

describe('roster upkeep', () => {
  it('follows joins and leaves and arms the alone watch for an invited room', async () => {
    const s = setup();
    s.fake.emit('roomReady', { room: DEN, occupants: ['botone', 'bob'] });
    s.fake.emit('roomJoin', { room: DEN, name: 'alice', display: 'Alice' });
    expect([...(s.rt.rooms.get(DEN_KEY)?.occupants ?? [])].sort()).toEqual(['alice', 'bob', 'botone']);
    s.fake.emit('roomLeave', { room: DEN, name: 'alice', display: 'Alice' });
    s.fake.emit('roomLeave', { room: DEN, name: 'bob', display: 'Bob' });
    expect(s.rt.rooms.get(DEN_KEY)?.aloneSince).toBe(s.clock.now());
    s.clock.advance(10 * 60_000);
    await flush();
    expect(s.fake.calls.leaveRoom).toEqual([DEN]);
  });

  it('invited-by survives a rejoin', async () => {
    const s = setup();
    s.fake.emit('invite', { from: 'bob', fromDisplay: 'Bob', room: DEN, roomCookie: '4-0-bobsden', text: '' });
    await flush();
    s.fake.emit('roomReady', { room: DEN, occupants: ['botone', 'bob'] });
    s.fake.emit('roomClosed', { room: DEN, willRejoin: true });
    s.fake.emit('roomReady', { room: DEN, occupants: ['botone', 'bob'] });
    expect(s.rt.rooms.get(DEN_KEY)?.invitedBy).toBe('bob');
    s.fake.emit('roomMessage', { ...line('bob', 'still there?'), room: DEN });
    await vi.waitFor(() => expect(s.turns).toHaveLength(1));
  });

  it('routes room messages and stranger invites', async () => {
    const s = setup();
    s.fake.emit('roomReady', { room: ROOM, occupants: ['botone', 'alice'] });
    s.fake.emit('roomMessage', line('alice', 'hello?'));
    await vi.waitFor(() => expect(s.turns).toHaveLength(1));
    s.fake.emit('invite', { from: 'mallory', fromDisplay: 'Mallory', room: DEN, roomCookie: '4-0-bobsden', text: '' });
    await flush();
    expect(s.notices).toEqual([{ name: 'mallory', display: 'Mallory' }]);
    expect(s.fake.calls.joinInvited).toEqual([]);
  });

  it('detach removes listeners and timers', async () => {
    const s = setup();
    s.fake.emit('roomReady', { room: DEN, occupants: ['botone'] });
    expect(s.clock.pending()).toBeGreaterThan(0);
    s.detach();
    expect(s.fake.listenerCount('roomMessage')).toBe(0);
    expect(s.fake.listenerCount('state')).toBe(0);
    expect(s.clock.pending()).toBe(0);
  });
});

describe('unlisted-join note', () => {
  it('tells owners once when an unlisted name joins the home room', async () => {
    const s = setup();
    s.fake.emit('roomReady', { room: ROOM, occupants: ['botone', 'alice'] });
    s.fake.emit('roomJoin', { room: ROOM, name: 'mallory', display: 'Mallory' });
    s.fake.emit('roomJoin', { room: ROOM, name: 'bob', display: 'Bob' });
    await flush();
    expect(s.ownerNotes).toEqual([copy.unlistedJoin('Mallory', 'testroom')]);
    expect(s.ownerNotes[0]).toBe('Mallory joined testroom. They are not on my lists.');
  });

  it('a rejoin does not announce occupants who were already there', async () => {
    const s = setup();
    s.fake.emit('roomReady', { room: ROOM, occupants: ['botone', 'alice'] });
    s.fake.emit('roomJoin', { room: ROOM, name: 'mallory', display: 'Mallory' });
    s.fake.emit('roomClosed', { room: ROOM, willRejoin: true });
    s.fake.emit('roomReady', { room: ROOM, occupants: ['botone', 'alice', 'mallory'] });
    s.fake.emit('roomJoin', { room: ROOM, name: 'mallory', display: 'Mallory' });
    await flush();
    expect(s.ownerNotes).toHaveLength(1);
    s.clock.advance(6 * 3_600_000);
    s.fake.emit('roomJoin', { room: ROOM, name: 'mallory', display: 'Mallory' });
    await flush();
    expect(s.ownerNotes).toHaveLength(2);
  });

  it('stays quiet for other rooms, for the bot itself and when switched off', async () => {
    const s = setup();
    s.fake.emit('roomReady', { room: DEN, occupants: ['botone', 'bob'] });
    s.fake.emit('roomJoin', { room: DEN, name: 'mallory', display: 'Mallory' });
    s.fake.emit('roomReady', { room: ROOM, occupants: ['alice'] });
    s.fake.emit('roomJoin', { room: ROOM, name: 'botone', display: 'BotOne' });
    s.setPolicy(policyFixture({ room: { ref: ROOM, historyFrom: 'listed', notifyOnUnlistedJoin: false } }));
    s.fake.emit('roomJoin', { room: ROOM, name: 'mallory', display: 'Mallory' });
    await flush();
    expect(s.ownerNotes).toEqual([]);
  });

  it('stops at the hourly cap', async () => {
    const s = setup({ contactNotice: { cooldownHours: 6, maxPerHour: 2 } });
    s.fake.emit('roomReady', { room: ROOM, occupants: ['botone'] });
    for (const name of ['mallory', 'trudy', 'victor']) s.fake.emit('roomJoin', { room: ROOM, name, display: name });
    await flush();
    expect(s.ownerNotes).toHaveLength(2);
  });

  it('flags a name with unusual letters', async () => {
    const s = setup();
    s.fake.emit('roomReady', { room: ROOM, occupants: ['botone'] });
    s.fake.emit('roomJoin', { room: ROOM, name: 'alicе', display: 'Alicе' });
    await flush();
    expect(s.ownerNotes).toEqual([`${copy.unlistedJoin('Alicе', 'testroom')} ${copy.noticeOddName()}`]);
  });
});

describe('roomIssues', () => {
  it('reports a missing exchange 5 room as an error with a fix', () => {
    const rt = makeRt();
    roomsExt(rt).home = { status: 'missing', detail: 'no such room' };
    const ref: RoomRef = { exchange: 5, name: 'lobby' };
    const policy = policyFixture({ room: { ref, historyFrom: 'listed', notifyOnUnlistedJoin: true } });
    expect(roomIssues(rt, policy, 'botone')).toEqual([
      {
        kind: 'config',
        severity: 'error',
        message: 'home room lobby does not exist on exchange 5',
        fix: 'ask the server operator to create the public room, or set channels.oscar.room.exchange to 4',
      },
    ]);
  });

  it('reports a home room that will not join as a warning', () => {
    const rt = makeRt();
    roomsExt(rt).home = { status: 'failed', detail: 'socket closed' };
    expect(roomIssues(rt, policyFixture(), 'botone')).toEqual([
      {
        kind: 'runtime',
        severity: 'warning',
        message: 'home room testroom is not joined: socket closed',
        fix: 'the join is retried automatically; check the server log',
      },
    ]);
  });

  it('lists unlisted occupants per joined room as information, escaped', () => {
    const rt = makeRt();
    roomsExt(rt).home = { status: 'joined' };
    applyRoomReady(rt, ROOM, ['botone', 'alice', 'mallory', 'alicе'], 'botone', 1);
    applyRoomReady(rt, DEN, ['botone', 'bob'], 'botone', 1);
    expect(roomIssues(rt, policyFixture(), 'botone')).toEqual([
      {
        kind: 'runtime',
        severity: 'info',
        message: 'unlisted occupants in room:4:testroom: alic\\u{435}, mallory',
        fix: 'they can read the room; add them to channels.oscar.allowFrom or move to a new room name',
      },
    ]);
  });

  it('says nothing about an unset home room, a healthy one, or an account that is not running', () => {
    const rt = makeRt();
    expect(roomIssues(rt, policyFixture({ room: undefined }), 'botone')).toEqual([]);
    roomsExt(rt).home = { status: 'joined' };
    expect(roomIssues(rt, policyFixture(), 'botone')).toEqual([]);
    expect(roomIssues(undefined, policyFixture(), 'botone')).toEqual([]);
  });
});
