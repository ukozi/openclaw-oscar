import { describe, expect, it } from 'vitest';
import { copy } from '../../../src/copy.js';
import type { RootPolicy } from '../../../src/config.js';
import { clearAloneTimers, handleInvite, watchAlone } from '../../../src/inbound/invite.js';
import type { RoomRef } from '../../../src/names.js';
import type { InviteEvent } from '../../../src/oscar/index.js';
import { toWireHtml } from '../../../src/oscar/text.js';
import { applyRoomClosed, applyRoomJoin, applyRoomLeave, applyRoomReady, roomsExt } from '../../../src/runtime.js';
import { ROOM, fakeSession, flush, makeRt, manualTimers, policyFixture, silentLog } from '../rooms-fixtures.js';

const DEN: RoomRef = { exchange: 4, name: 'bobsden' };
const DEN_KEY = 'room:4:bobsden';

function invite(from: string, room: RoomRef = DEN): InviteEvent {
  return { from, fromDisplay: from, room, roomCookie: `${room.exchange}-0-${room.name}`, text: 'join me' };
}

function setup(over: Partial<RootPolicy> = {}) {
  const fake = fakeSession();
  const rt = makeRt(fake.session);
  const clock = manualTimers();
  const notices: string[] = [];
  let policy = policyFixture(over);
  const deps = {
    policy: () => policy,
    now: clock.now,
    log: silentLog,
    timers: clock.timers,
    noticeStranger: (name: string) => {
      notices.push(name);
    },
  };
  return { fake, rt, clock, notices, deps, setPolicy: (next: RootPolicy) => (policy = next) };
}

describe('handleInvite', () => {
  it('joins for an approved inviter and remembers who invited', async () => {
    const s = setup();
    expect(await handleInvite(s.rt, s.deps, invite('Bob'))).toBe('joined');
    expect(s.fake.calls.joinInvited).toHaveLength(1);
    expect(s.fake.calls.joinRoom).toEqual([]);
    expect(roomsExt(s.rt).invitedBy.get(DEN_KEY)).toBe('bob');
    expect(roomsExt(s.rt).joining.has(DEN_KEY)).toBe(false);
  });

  it('carries the inviter into the room state when the room becomes ready', async () => {
    const s = setup();
    await handleInvite(s.rt, s.deps, invite('bob'));
    expect(applyRoomReady(s.rt, DEN, ['botone', 'bob'], 'botone', s.clock.now()).invitedBy).toBe('bob');
  });

  it('joins for an owner under accept owners and ignores an approved inviter silently', async () => {
    const s = setup({ invites: { accept: 'owners', maxRooms: 5, leaveWhenAloneMinutes: 10 } });
    expect(await handleInvite(s.rt, s.deps, invite('bob'))).toBe('ignored');
    expect(await handleInvite(s.rt, s.deps, invite('alice'))).toBe('joined');
    expect(s.fake.calls.joinInvited.map((i) => i.from)).toEqual(['alice']);
    expect(s.fake.calls.sendIm).toEqual([]);
    expect(s.notices).toEqual([]);
  });

  it('ignores everyone under accept off', async () => {
    const s = setup({ invites: { accept: 'off', maxRooms: 5, leaveWhenAloneMinutes: 10 } });
    expect(await handleInvite(s.rt, s.deps, invite('alice'))).toBe('ignored');
    expect(s.fake.calls.joinInvited).toEqual([]);
  });

  it('sends a stranger nothing and tells the notice module', async () => {
    const s = setup();
    expect(await handleInvite(s.rt, s.deps, invite('Mallory'))).toBe('stranger');
    expect(s.notices).toEqual(['mallory']);
    expect(s.fake.calls.joinInvited).toEqual([]);
    expect(s.fake.calls.sendIm).toEqual([]);
  });

  it('ignores a roster bot without a notice', async () => {
    const roster = [
      { screenName: 'botone', role: 'lead', aliases: [] },
      { screenName: 'bottwo', role: 'writing', aliases: [] },
    ];
    const s = setup({ chain: { ...policyFixture().chain, roster } });
    expect(await handleInvite(s.rt, s.deps, invite('bottwo'))).toBe('ignored');
    expect(s.notices).toEqual([]);
    expect(s.fake.calls.joinInvited).toEqual([]);
  });

  it('a second invite while the first join is in flight joins once', async () => {
    const s = setup();
    let release = (): void => {};
    s.fake.hold.joinInvited = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = handleInvite(s.rt, s.deps, invite('bob'));
    const second = handleInvite(s.rt, s.deps, invite('bob'));
    expect(await second).toBe('already');
    release();
    expect(await first).toBe('joined');
    expect(s.fake.calls.joinInvited).toHaveLength(1);
  });

  it('an invite to a joined room is a no-op', async () => {
    const s = setup();
    applyRoomReady(s.rt, DEN, ['botone', 'alice'], 'botone', 1);
    expect(await handleInvite(s.rt, s.deps, invite('bob'))).toBe('already');
    expect(s.fake.calls.joinInvited).toEqual([]);
    expect(roomsExt(s.rt).invitedBy.has(DEN_KEY)).toBe(false);
  });

  it('leaves an invite to the home room to the home room logic', async () => {
    const s = setup();
    expect(await handleInvite(s.rt, s.deps, invite('bob', ROOM))).toBe('already');
    expect(s.fake.calls.joinInvited).toEqual([]);
  });

  it('declines by IM at the cap, to the inviter only', async () => {
    const s = setup({ invites: { accept: 'approved', maxRooms: 1, leaveWhenAloneMinutes: 10 } });
    applyRoomReady(s.rt, ROOM, ['botone'], 'botone', 1);
    applyRoomReady(s.rt, { exchange: 4, name: 'first' }, ['botone', 'alice'], 'botone', 1);
    expect(await handleInvite(s.rt, s.deps, invite('bob'))).toBe('full');
    expect(s.fake.calls.joinInvited).toEqual([]);
    expect(s.fake.calls.sendIm).toEqual([{ to: 'bob', html: toWireHtml(copy.inviteFull()), priority: 'notice' }]);
  });

  it('never declines to a stranger, even at the cap', async () => {
    const s = setup({ invites: { accept: 'approved', maxRooms: 0, leaveWhenAloneMinutes: 10 } });
    expect(await handleInvite(s.rt, s.deps, invite('mallory'))).toBe('stranger');
    expect(s.fake.calls.sendIm).toEqual([]);
  });

  it('counts a room that is waiting to be rejoined toward the cap', async () => {
    const s = setup({ invites: { accept: 'approved', maxRooms: 1, leaveWhenAloneMinutes: 10 } });
    const first = { exchange: 4, name: 'first' } as const;
    applyRoomReady(s.rt, first, ['botone', 'alice'], 'botone', 1);
    applyRoomClosed(s.rt, first, true);
    expect(await handleInvite(s.rt, s.deps, invite('bob'))).toBe('full');
  });

  it('forgets a failed join and sends nothing', async () => {
    const s = setup();
    s.fake.fail.joinInvited = new Error('chatnav dropped');
    expect(await handleInvite(s.rt, s.deps, invite('bob'))).toBe('failed');
    expect(roomsExt(s.rt).invitedBy.has(DEN_KEY)).toBe(false);
    expect(roomsExt(s.rt).joining.has(DEN_KEY)).toBe(false);
    expect(s.fake.calls.sendIm).toEqual([]);
  });
});

describe('watchAlone', () => {
  function alone(s: ReturnType<typeof setup>) {
    applyRoomReady(s.rt, DEN, ['botone', 'bob'], 'botone', s.clock.now());
    applyRoomLeave(s.rt, DEN, 'bob', 'botone', s.clock.now());
    watchAlone(s.rt, s.deps, DEN);
  }

  it('leaves an invited room after ten minutes alone', async () => {
    const s = setup();
    alone(s);
    s.clock.advance(9 * 60_000);
    expect(s.fake.calls.leaveRoom).toEqual([]);
    s.clock.advance(60_000);
    await flush();
    expect(s.fake.calls.leaveRoom).toEqual([DEN]);
  });

  it('someone coming back at minute nine cancels the leave, and the clock restarts when they go', async () => {
    const s = setup();
    alone(s);
    s.clock.advance(9 * 60_000);
    applyRoomJoin(s.rt, DEN, 'bob', 'botone', s.clock.now());
    watchAlone(s.rt, s.deps, DEN);
    expect(s.clock.pending()).toBe(0);
    s.clock.advance(5 * 60_000);
    expect(s.fake.calls.leaveRoom).toEqual([]);
    applyRoomLeave(s.rt, DEN, 'bob', 'botone', s.clock.now());
    watchAlone(s.rt, s.deps, DEN);
    s.clock.advance(9 * 60_000);
    expect(s.fake.calls.leaveRoom).toEqual([]);
    s.clock.advance(60_000);
    expect(s.fake.calls.leaveRoom).toEqual([DEN]);
  });

  it('never leaves the home room', () => {
    const s = setup();
    applyRoomReady(s.rt, ROOM, ['botone'], 'botone', s.clock.now());
    watchAlone(s.rt, s.deps, ROOM);
    expect(s.clock.pending()).toBe(0);
    s.clock.advance(60 * 60_000);
    expect(s.fake.calls.leaveRoom).toEqual([]);
  });

  it('is off at zero minutes', () => {
    const s = setup({ invites: { accept: 'approved', maxRooms: 5, leaveWhenAloneMinutes: 0 } });
    alone(s);
    expect(s.clock.pending()).toBe(0);
  });

  it('reads the limit again when the timer fires', () => {
    const s = setup();
    alone(s);
    s.setPolicy(policyFixture({ invites: { accept: 'approved', maxRooms: 5, leaveWhenAloneMinutes: 30 } }));
    s.clock.advance(10 * 60_000);
    expect(s.fake.calls.leaveRoom).toEqual([]);
    s.clock.advance(20 * 60_000);
    expect(s.fake.calls.leaveRoom).toEqual([DEN]);
  });

  it('clears every timer on request', () => {
    const s = setup();
    alone(s);
    clearAloneTimers(s.rt, s.clock.timers);
    expect(s.clock.pending()).toBe(0);
    expect(roomsExt(s.rt).aloneTimers.size).toBe(0);
  });
});
