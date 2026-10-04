import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChainController } from '../../../src/chain/controller.js';
import type { RoomRef } from '../../../src/names.js';
import { attachRoomSetup, leaveRoomNow, parseLeaveLine } from '../../../src/rooms/leave.js';
import { applyRoomReady, roomsExt } from '../../../src/runtime.js';
import { ROOM, fakeSession, makeRt, policyFixture } from '../rooms-fixtures.js';

const DEN: RoomRef = { exchange: 4, name: 'den' };
const DEN_KEY = 'room:4:den';

afterEach(() => {
  attachRoomSetup('botone', null);
});

describe('parseLeaveLine', () => {
  it.each([
    ['/leave', { all: true }],
    ['  /leave  ', { all: true }],
    ['/LEAVE', { all: true }],
    ['/leave botone bottwo', { names: ['botone', 'bottwo'] }],
    ['/leave BotOne botone', { names: ['botone'] }],
    ['/leaver', null],
    ['leave', null],
    ['please /leave', null],
  ])('%j', (text, expected) => {
    expect(parseLeaveLine(text)).toEqual(expected);
  });
});

describe('leaveRoomNow', () => {
  function running() {
    const fake = fakeSession();
    const rt = makeRt(fake.session);
    const resetRoom = vi.fn();
    rt.chain = { resetRoom } as unknown as ChainController;
    const forget = vi.fn();
    attachRoomSetup('botone', { forget });
    applyRoomReady(rt, ROOM, ['botone', 'alice'], 'botone', 1);
    applyRoomReady(rt, DEN, ['botone', 'bob'], 'botone', 1);
    return { fake, rt, resetRoom, forget };
  }

  it('leaves a joined room and clears its state', async () => {
    const { fake, rt, resetRoom, forget } = running();
    roomsExt(rt).invitedBy.set(DEN_KEY, 'bob');
    expect(await leaveRoomNow(rt, DEN, policyFixture())).toBe('left');
    expect(fake.calls.leaveRoom).toEqual([DEN]);
    expect(rt.rooms.has(DEN_KEY)).toBe(false);
    expect(roomsExt(rt).invitedBy.has(DEN_KEY)).toBe(false);
    expect(resetRoom).toHaveBeenCalledWith(DEN_KEY);
    expect(forget).toHaveBeenCalledWith(DEN_KEY);
  });

  it('refuses the home room', async () => {
    const { fake, rt, resetRoom } = running();
    expect(await leaveRoomNow(rt, ROOM, policyFixture())).toBe('home');
    expect(fake.calls.leaveRoom).toEqual([]);
    expect(resetRoom).not.toHaveBeenCalled();
  });

  it('says so for a room it is not in', async () => {
    const { fake, rt, forget } = running();
    expect(await leaveRoomNow(rt, { exchange: 4, name: 'nowhere' }, policyFixture())).toBe('not-in');
    expect(fake.calls.leaveRoom).toEqual([]);
    expect(forget).not.toHaveBeenCalled();
  });
});
