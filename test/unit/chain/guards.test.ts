import { describe, expect, it } from 'vitest';
import { ROOM_SENDER, RoomLoopGuard, botLoopFacts } from '../../../src/chain/guards.js';

const R = 'room:4:testroom';

describe('botLoopFacts', () => {
  it('scopes to the account and the room', () => {
    expect(botLoopFacts('botone', R, 'bottwo', 'botone', 5)).toEqual({
      scopeId: 'botone', conversationId: R, senderId: 'bottwo', receiverId: 'botone', defaultEnabled: true, nowMs: 5,
    });
  });
});

describe('RoomLoopGuard', () => {
  it('allows 20 bot-authored wakes a minute in one room, then refuses', () => {
    const guard = new RoomLoopGuard();
    for (let i = 0; i < 20; i++) expect(guard.allow('bottwo', R, 'bottwo', 1000 + i)).toBe(true);
    expect(guard.allow('bottwo', R, 'bottwo', 1100)).toBe(false);
    expect(guard.allow('bottwo', R, 'bottwo', 30_000)).toBe(false);
  });

  it('recovers after the cooldown', () => {
    const guard = new RoomLoopGuard();
    for (let i = 0; i < 21; i++) guard.allow('bottwo', R, 'bottwo', 1000 + i);
    expect(guard.allow('bottwo', R, 'bottwo', 1020 + 60_001)).toBe(true);
  });

  it('counts rooms and accounts apart', () => {
    const guard = new RoomLoopGuard();
    for (let i = 0; i < 21; i++) guard.allow('bottwo', R, 'bottwo', 1000 + i);
    expect(guard.allow('bottwo', 'room:4:other', 'bottwo', 1100)).toBe(true);
    expect(guard.allow('botthree', R, 'botthree', 1100)).toBe(true);
  });

  it('uses a sender no screen name can equal', () => {
    expect(ROOM_SENDER).toBe('*room*');
  });
});
