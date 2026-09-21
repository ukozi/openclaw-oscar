import { describe, expect, it } from 'vitest';
import { backoffDelay, connectFailureReason, createLoginBudget } from '../../../src/oscar/session.js';
import { ManualTimers } from '../../fake/oscar-client.js';

describe('connectFailureReason', () => {
  it('names TLS failures, unroutable redirects and plain network errors', () => {
    const cert = Object.assign(new Error('self-signed certificate'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
    const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    expect(connectFailureReason(cert, false)).toBe('tls');
    expect(connectFailureReason(cert, true)).toBe('tls');
    expect(connectFailureReason(refused, true)).toBe('redirect-unroutable');
    expect(connectFailureReason(refused, false)).toBe('network');
  });
});

describe('backoffDelay', () => {
  const rows: [number, number, number][] = [
    [1, 0, 2000],
    [2, 0, 4000],
    [3, 0, 60_000],
    [4, 0, 60_000],
    [6, 0, 64_000],
    [7, 0, 120_000],
    [20, 0, 120_000],
    [1, 1, 2400],
    [7, 1, 144_000],
    [3, 0.5, 66_000],
  ];
  it.each(rows)('failure %i with random %d waits %i ms', (failures, random, want) => {
    expect(backoffDelay(failures, random)).toBe(want);
  });
});

describe('createLoginBudget', () => {
  it('staggers logins 2 s apart and allows 8 per minute', async () => {
    const timers = new ManualTimers();
    const budget = createLoginBudget({ now: timers.now, timers: timers.api });
    const start = timers.now();
    const granted: number[] = [];
    for (let i = 0; i < 10; i++) void budget.take().then(() => granted.push(timers.now() - start));
    await timers.advance(0);
    expect(granted).toEqual([0]);
    await timers.advance(59_999);
    expect(granted).toEqual([0, 2000, 4000, 6000, 8000, 10_000, 12_000, 14_000]);
    await timers.advance(2001);
    expect(granted).toEqual([0, 2000, 4000, 6000, 8000, 10_000, 12_000, 14_000, 60_000, 62_000]);
  });

  it('grants at once after a quiet spell', async () => {
    const timers = new ManualTimers();
    const budget = createLoginBudget({ now: timers.now, timers: timers.api });
    await budget.take();
    await timers.advance(5000);
    let granted = false;
    void budget.take().then(() => (granted = true));
    await timers.advance(0);
    expect(granted).toBe(true);
  });
});
