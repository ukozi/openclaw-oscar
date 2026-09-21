import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearRuntime, createPasswordGuard, currentGeneration, getRuntime, liveConfig, nextGeneration,
  resetRuntimeForTests, runtimeForSessionKey, setHost, setRuntime, sharedLoginBudget,
} from '../../src/runtime.js';
import type { AccountRuntime, ProbeResult } from '../../src/runtime.js';
import { FakeSession } from '../fake/session.js';

const rt = (accountId: string): AccountRuntime => ({
  accountId, session: new FakeSession().asSession(), rooms: new Map(), sessionKeys: new Map(),
  lastReplyAt: new Map(), counters: { droppedSends: 0, eventGaps: 0 },
});
const log = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

beforeEach(() => resetRuntimeForTests());
afterEach(() => vi.useRealTimers());

describe('holder', () => {
  it('stores, finds by session key and clears', () => {
    const a = rt('botone');
    a.sessionKeys.set('agent:main:oscar:group:botone/alice', { accountId: 'botone', peer: { kind: 'im', bot: 'botone', peer: 'alice' } });
    setRuntime(a);
    expect(getRuntime('botone')).toBe(a);
    expect(runtimeForSessionKey('agent:main:oscar:group:botone/alice')).toBe(a);
    expect(runtimeForSessionKey('agent:main:main')).toBeUndefined();
    clearRuntime('botone');
    expect(getRuntime('botone')).toBeUndefined();
  });

  it('survives a second evaluation of the module', async () => {
    const a = rt('botone');
    setRuntime(a);
    vi.resetModules();
    const again = await import('../../src/runtime.js');
    expect(again.getRuntime('botone')).toBe(a);
    expect(again.sharedLoginBudget()).toBe(sharedLoginBudget());
  });

  it('counts generations per account', () => {
    expect(currentGeneration('botone')).toBe(0);
    expect(nextGeneration('botone')).toBe(1);
    expect(nextGeneration('botone')).toBe(2);
    expect(currentGeneration('bottwo')).toBe(0);
  });

  it('reads live config from the host when there is one', () => {
    expect(liveConfig({ a: 1 })).toEqual({ a: 1 });
    setHost({ config: { current: () => ({ a: 2 }) } });
    expect(liveConfig({ a: 1 })).toEqual({ a: 2 });
    setHost({ config: { current: () => { throw new Error('no snapshot yet'); } } });
    expect(liveConfig({ a: 1 })).toEqual({ a: 1 });
  });
});

describe('shared login budget', () => {
  it('is one object per process and grants at once when idle', async () => {
    const budget = sharedLoginBudget();
    expect(sharedLoginBudget()).toBe(budget);
    await expect(budget.take()).resolves.toBeUndefined();
    resetRuntimeForTests();
    expect(sharedLoginBudget()).not.toBe(budget);
  });
});

describe('password guard', () => {
  function setup(results: ProbeResult[], allowUnauthenticated = false, cacheKey = 'h:5190:botone') {
    const halted: string[] = [];
    const seen: ProbeResult[] = [];
    let calls = 0;
    const guard = createPasswordGuard({
      cacheKey, allowUnauthenticated,
      probe: async () => results[Math.min(calls++, results.length - 1)] ?? 'unknown',
      now: () => Date.now(),
      timers: { setTimeout, clearTimeout }, log,
      onResult: (r) => seen.push(r.result),
      halt: async (detail) => { halted.push(detail); },
    });
    return { guard, halted, seen, calls: () => calls };
  }

  it('halts when the server does not check passwords', async () => {
    const t = setup(['does-not-check']);
    t.guard.onOnline();
    await t.guard.idle();
    expect(t.seen).toEqual(['does-not-check']);
    expect(t.halted).toHaveLength(1);
  });

  it('only records it when the dangerous flag is set', async () => {
    const t = setup(['does-not-check'], true);
    t.guard.onOnline();
    await t.guard.idle();
    expect(t.seen).toEqual(['does-not-check']);
    expect(t.halted).toEqual([]);
  });

  it('probes once per run and uses the 24 h cache across guards', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const a = setup(['checks']);
    a.guard.onOnline();
    a.guard.onOnline();
    await a.guard.idle();
    expect(a.calls()).toBe(1);
    const b = setup(['does-not-check']);
    b.guard.onOnline();
    await b.guard.idle();
    expect(b.calls()).toBe(0);
    expect(b.seen).toEqual(['checks']);
    vi.setSystemTime(1_000_000 + 24 * 3600_000 + 1);
    const c = setup(['checks']);
    c.guard.onOnline();
    await c.guard.idle();
    expect(c.calls()).toBe(1);
  });

  it('does not reuse one host and name answer for another', async () => {
    const a = setup(['checks']);
    a.guard.onOnline();
    await a.guard.idle();
    const b = setup(['does-not-check'], false, 'other:5190:bottwo');
    b.guard.onOnline();
    await b.guard.idle();
    expect(b.calls()).toBe(1);
    expect(b.seen).toEqual(['does-not-check']);
    expect(b.halted).toHaveLength(1);
  });

  it('retries unknown after 60 s and does not cache it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const t = setup(['unknown', 'unknown', 'checks']);
    t.guard.onOnline();
    await t.guard.idle();
    expect(t.calls()).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    await t.guard.idle();
    expect(t.calls()).toBe(2);
    await vi.advanceTimersByTimeAsync(119_999);
    expect(t.calls()).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    await t.guard.idle();
    expect(t.seen).toEqual(['unknown', 'unknown', 'checks']);
  });

  it('stops retrying after stop', async () => {
    vi.useFakeTimers();
    const t = setup(['unknown']);
    t.guard.onOnline();
    await t.guard.idle();
    t.guard.stop();
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(t.calls()).toBe(1);
  });
});
