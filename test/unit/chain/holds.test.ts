import { describe, expect, it } from 'vitest';
import { HoldQueue, MAX_HELD_PER_ROOM, mustHold } from '../../../src/chain/holds.js';

const R = 'room:4:testroom';

describe('mustHold', () => {
  it('nothing is held when the session is idle', () => {
    expect(mustHold(null, 'approved')).toBe(false);
  });
  it('same class steers', () => {
    expect(mustHold('owner', 'owner')).toBe(false);
  });
  it('different class is held', () => {
    expect(mustHold('owner', 'approved')).toBe(true);
    expect(mustHold('approved', 'owner')).toBe(true);
    expect(mustHold('owner', 'bot:botone:owner')).toBe(true);
    expect(mustHold('bot:botone:owner', 'bot:botone:approved')).toBe(true);
  });
});

describe('HoldQueue', () => {
  it('releases the head with the same-class entries right behind it', () => {
    const q = new HoldQueue<string>();
    q.hold(R, 'approved', 'a1');
    q.hold(R, 'approved', 'a2');
    q.hold(R, 'owner', 'o1');
    q.hold(R, 'approved', 'a3');
    expect(q.next(R)).toEqual({ holdClass: 'approved', items: ['a1', 'a2'] });
    expect(q.next(R)).toEqual({ holdClass: 'owner', items: ['o1'] });
    expect(q.next(R)).toEqual({ holdClass: 'approved', items: ['a3'] });
    expect(q.next(R)).toBeNull();
  });

  it('keeps rooms apart', () => {
    const q = new HoldQueue<string>();
    q.hold(R, 'owner', 'x');
    expect(q.size('room:4:other')).toBe(0);
    expect(q.next('room:4:other')).toBeNull();
    expect(q.size(R)).toBe(1);
  });

  it('refuses past the cap', () => {
    const q = new HoldQueue<number>();
    for (let i = 0; i < MAX_HELD_PER_ROOM; i++) expect(q.hold(R, 'approved', i)).toBe(true);
    expect(q.hold(R, 'approved', 99)).toBe(false);
    expect(q.size(R)).toBe(MAX_HELD_PER_ROOM);
  });

  it('clear empties every room', () => {
    const q = new HoldQueue<string>();
    q.hold(R, 'owner', 'x');
    q.clear();
    expect(q.next(R)).toBeNull();
  });
});
