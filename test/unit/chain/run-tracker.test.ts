import { describe, expect, it, vi } from 'vitest';
import { FakeRunTracker } from '../../fake/run-tracker.js';

describe('FakeRunTracker', () => {
  it('reports the active run and its origin', () => {
    const t = new FakeRunTracker();
    expect(t.activeRun('k')).toBeNull();
    t.start('k', 'botone', 'owner');
    expect(t.activeRun('k')?.origin).toBe('owner');
  });

  it('fires onIdle once when the last run ends', () => {
    const t = new FakeRunTracker();
    const idle = vi.fn();
    t.start('k', 'botone', 'owner');
    t.start('k', 'botone', 'owner');
    t.onIdle('k', idle);
    t.end('k');
    expect(idle).not.toHaveBeenCalled();
    t.end('k');
    expect(idle).toHaveBeenCalledTimes(1);
    expect(idle).toHaveBeenCalledWith('end');
    expect(t.activeRun('k')).toBeNull();
  });

  it('hands the waiter the phase of the run that emptied the session', () => {
    const t = new FakeRunTracker();
    const idle = vi.fn();
    t.start('k', 'botone', 'bot');
    t.onIdle('k', idle);
    t.end('k', 'error');
    expect(idle).toHaveBeenCalledWith('error');
  });

  it('reports each run start and end', () => {
    const t = new FakeRunTracker();
    const seen: string[] = [];
    const off = t.onRun((change) => seen.push(`${change.kind}:${change.run.sessionKey}`));
    t.start('k', 'botone', 'owner');
    t.end('k');
    off();
    t.start('k', 'botone', 'owner');
    expect(seen).toEqual(['start:k', 'end:k']);
  });

  it('reset drops every run and answers waiters with end, as a sign-on does', () => {
    const t = new FakeRunTracker();
    const idle = vi.fn();
    t.start('k', 'botone', 'owner');
    t.onIdle('k', idle);
    t.reset();
    expect(idle).toHaveBeenCalledWith('end');
    expect(t.activeRun('k')).toBeNull();
  });

  it('fires on the next microtask when the session has no run, like the real tracker', async () => {
    const t = new FakeRunTracker();
    const idle = vi.fn();
    t.onIdle('k', idle);
    expect(idle).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(idle).toHaveBeenCalledTimes(1);
    expect(idle).toHaveBeenCalledWith('end');
  });

  it('lets a listener unsubscribe', async () => {
    const t = new FakeRunTracker();
    const idle = vi.fn();
    t.start('k', 'botone', 'bot');
    t.onIdle('k', idle)();
    t.end('k');
    t.onIdle('k', idle)();
    await Promise.resolve();
    expect(idle).not.toHaveBeenCalled();
  });
});
