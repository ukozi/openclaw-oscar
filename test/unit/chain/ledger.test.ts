import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HandoffLedger } from '../../../src/chain/handoff.js';
import { ROOM } from './fixtures.js';

const H = { id: '1-k7f3', to: 'bottwo', room: ROOM, originator: 'alice', hop: 1 };

function make() {
  const onExpire = vi.fn();
  const ledger = new HandoffLedger({ timeoutMs: () => 20 * 60_000, onExpire });
  return { ledger, onExpire };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('HandoffLedger', () => {
  it('opens and lists', () => {
    const { ledger } = make();
    const open = ledger.open(H);
    expect(open.createdAt).toBe(Date.now());
    expect(ledger.list()).toEqual([open]);
    expect(ledger.openKeys(ROOM)).toEqual(new Set(['bottwo:1-k7f3']));
    expect(ledger.openKeys({ exchange: 4, name: 'other' })).toEqual(new Set());
  });

  it('closes only for the target', () => {
    const { ledger, onExpire } = make();
    ledger.open(H);
    expect(ledger.close('1-k7f3', 'botthree')).toBeNull();
    expect(ledger.close('1-k7f3', 'bottwo')?.id).toBe('1-k7f3');
    expect(ledger.close('1-k7f3', 'bottwo')).toBeNull();
    vi.advanceTimersByTime(60 * 60_000);
    expect(onExpire).not.toHaveBeenCalled();
  });

  it('expires after the timeout', () => {
    const { ledger, onExpire } = make();
    ledger.open(H);
    vi.advanceTimersByTime(20 * 60_000 - 1);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onExpire).toHaveBeenCalledWith(expect.objectContaining({ id: '1-k7f3', to: 'bottwo' }));
    expect(ledger.list()).toEqual([]);
  });

  it('hands back what a leaving target still owed', () => {
    const { ledger, onExpire } = make();
    ledger.open(H);
    ledger.open({ ...H, id: '1-aaaa', to: 'botthree' });
    ledger.open({ ...H, id: '1-bbbb', room: { exchange: 4, name: 'other' } });
    expect(ledger.targetLeft(ROOM, 'bottwo').map((h) => h.id)).toEqual(['1-k7f3']);
    expect(ledger.list().map((h) => h.id).sort()).toEqual(['1-aaaa', '1-bbbb']);
    vi.advanceTimersByTime(20 * 60_000);
    expect(onExpire).toHaveBeenCalledTimes(2);
  });

  it('remembers seen hand-offs, newest 500', () => {
    const { ledger } = make();
    ledger.markSeen('botone', '1-k7f3');
    expect(ledger.seenKeys().has('botone:1-k7f3')).toBe(true);
    for (let i = 0; i < 500; i++) ledger.markSeen('botone', `1-${String(i).padStart(4, 'a')}`);
    expect(ledger.seenKeys().has('botone:1-k7f3')).toBe(false);
    expect(ledger.seenKeys().size).toBe(500);
  });

  it('clear cancels timeouts', () => {
    const { ledger, onExpire } = make();
    ledger.open(H);
    ledger.clear();
    vi.advanceTimersByTime(60 * 60_000);
    expect(onExpire).not.toHaveBeenCalled();
    expect(ledger.list()).toEqual([]);
  });
});
