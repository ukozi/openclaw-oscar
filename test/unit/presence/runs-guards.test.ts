import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RUN_QUIET_MS, TOOL_CAP_MS, createRunTracker } from '../../../src/presence/runs.js';

const IM = 'agent:main:oscar:group:botone/alice';
const CHILD = 'agent:main:subagent:1111';
const GRANDCHILD = 'agent:main:subagent:2222';
const MINUTE = 60_000;

function setup() {
  const tracker = createRunTracker();
  const events: string[] = [];
  tracker.on('busy', () => events.push('busy'));
  tracker.on('idle', () => events.push('idle'));
  tracker.onRun((change) => {
    if (change.kind === 'end') events.push(`end:${change.run.runId}:${change.why}`);
  });
  tracker.bind(IM, 'botone', 'owner');
  return { tracker, events };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('runs that do not count', () => {
  it.each(['heartbeat', 'cron'])('drops a %s run', (trigger) => {
    const { tracker, events } = setup();
    tracker.seen('r1', IM);
    tracker.trigger('r1', trigger, IM);
    expect(tracker.isBusy('botone')).toBe(false);
    expect(events).toEqual(['busy', 'end:r1:excluded', 'idle']);
    tracker.toolStart('r1', 't1', 'exec', IM);
    tracker.seen('r1', IM);
    expect(tracker.isBusy('botone')).toBe(false);
  });

  it('never adds a run whose trigger arrived first', () => {
    const { tracker, events } = setup();
    tracker.trigger('r1', 'heartbeat', IM);
    tracker.seen('r1', IM);
    expect(events).toEqual([]);
  });

  it.each(['user', 'manual', undefined])('keeps a run with trigger %s', (trigger) => {
    const { tracker } = setup();
    tracker.trigger('r1', trigger, IM);
    expect(tracker.isBusy('botone')).toBe(true);
  });
});

describe('subagent holds', () => {
  it('stays busy after the parent run until the subagent ends', () => {
    const { tracker, events } = setup();
    tracker.seen('r1', IM);
    tracker.subagentSpawned(CHILD, IM);
    tracker.ended('r1');
    expect(tracker.isBusy('botone')).toBe(true);
    expect(tracker.activeCount('botone')).toBe(0);
    expect(tracker.activeRun(IM)).toBeNull();
    tracker.subagentEnded(CHILD);
    expect(events).toEqual(['busy', 'end:r1:terminal', 'idle']);
  });

  it('follows a subagent spawned by a subagent', () => {
    const { tracker } = setup();
    tracker.seen('r1', IM);
    tracker.subagentSpawned(CHILD, IM);
    tracker.subagentSpawned(GRANDCHILD, CHILD);
    tracker.ended('r1');
    tracker.subagentEnded(CHILD);
    expect(tracker.isBusy('botone')).toBe(true);
    tracker.subagentEnded(GRANDCHILD);
    expect(tracker.isBusy('botone')).toBe(false);
  });

  it('ignores a spawn from a session with no counted run', () => {
    const { tracker } = setup();
    tracker.subagentSpawned(CHILD, IM);
    tracker.subagentSpawned(GRANDCHILD, 'agent:main:main');
    tracker.subagentSpawned('agent:main:subagent:3333', undefined);
    expect(tracker.isBusy('botone')).toBe(false);
  });

  it('gives up on a hold after the cap', () => {
    const { tracker, events } = setup();
    tracker.seen('r1', IM);
    tracker.subagentSpawned(CHILD, IM);
    tracker.ended('r1');
    vi.advanceTimersByTime(TOOL_CAP_MS - MINUTE);
    expect(tracker.isBusy('botone')).toBe(true);
    vi.advanceTimersByTime(2 * MINUTE);
    expect(tracker.isBusy('botone')).toBe(false);
    expect(events.at(-1)).toBe('idle');
  });

  it('reset clears holds', () => {
    const { tracker } = setup();
    tracker.seen('r1', IM);
    tracker.subagentSpawned(CHILD, IM);
    tracker.reset('botone');
    expect(tracker.isBusy('botone')).toBe(false);
  });
});

describe('watchdog', () => {
  it('drops a wedged run after fifteen quiet minutes', () => {
    const { tracker, events } = setup();
    tracker.seen('r1', IM);
    vi.advanceTimersByTime(RUN_QUIET_MS - MINUTE);
    expect(tracker.isBusy('botone')).toBe(true);
    vi.advanceTimersByTime(2 * MINUTE);
    expect(tracker.isBusy('botone')).toBe(false);
    expect(events).toEqual(['busy', 'end:r1:watchdog', 'idle']);
  });

  it('keeps a run alive while model calls and tools keep coming', () => {
    const { tracker } = setup();
    tracker.seen('r1', IM);
    for (let i = 0; i < 6; i += 1) {
      vi.advanceTimersByTime(10 * MINUTE);
      if (i % 2 === 0) tracker.trigger('r1', 'user', IM);
      else {
        tracker.toolStart('r1', `t${i}`, 'read', IM);
        tracker.toolEnd('r1', `t${i}`, 'read', IM);
      }
    }
    expect(tracker.isBusy('botone')).toBe(true);
  });

  it('does not drop a run during one long tool call', () => {
    const { tracker } = setup();
    tracker.seen('r1', IM);
    tracker.toolStart('r1', 't1', 'exec', IM);
    vi.advanceTimersByTime(90 * MINUTE);
    expect(tracker.isBusy('botone')).toBe(true);
    tracker.toolEnd('r1', 't1', 'exec', IM);
    vi.advanceTimersByTime(RUN_QUIET_MS - MINUTE);
    expect(tracker.isBusy('botone')).toBe(true);
    vi.advanceTimersByTime(2 * MINUTE);
    expect(tracker.isBusy('botone')).toBe(false);
  });

  it('drops a run whose tool call stays open past two hours', () => {
    const { tracker, events } = setup();
    tracker.seen('r1', IM);
    tracker.toolStart('r1', 't1', 'exec', IM);
    vi.advanceTimersByTime(TOOL_CAP_MS + MINUTE);
    expect(tracker.isBusy('botone')).toBe(false);
    expect(events).toContain('end:r1:watchdog');
  });

  it('gives up on a stuck tool call but keeps a run that still shows life', () => {
    const { tracker, events } = setup();
    tracker.seen('r1', IM);
    tracker.toolStart('r1', 't1', 'exec', IM);
    vi.advanceTimersByTime(TOOL_CAP_MS - MINUTE);
    tracker.toolStart('r1', 't2', 'read', IM);
    tracker.toolEnd('r1', 't2', 'read', IM);
    vi.advanceTimersByTime(2 * MINUTE);
    expect(tracker.isBusy('botone')).toBe(true);
    expect(events).toEqual(['busy']);
    vi.advanceTimersByTime(RUN_QUIET_MS);
    expect(tracker.isBusy('botone')).toBe(false);
    expect(events).toEqual(['busy', 'end:r1:watchdog', 'idle']);
  });

  it('pairs tool calls that carry no id by tool name', () => {
    const { tracker } = setup();
    tracker.seen('r1', IM);
    tracker.toolStart('r1', undefined, 'exec', IM);
    tracker.toolEnd('r1', undefined, 'exec', IM);
    vi.advanceTimersByTime(RUN_QUIET_MS + MINUTE);
    expect(tracker.isBusy('botone')).toBe(false);
  });

  it('brings a dropped run back when it shows signs of life', () => {
    const { tracker, events } = setup();
    tracker.seen('r1', IM);
    vi.advanceTimersByTime(RUN_QUIET_MS + MINUTE);
    tracker.toolEnd('r1', 't1', 'exec', IM);
    expect(tracker.isBusy('botone')).toBe(true);
    tracker.ended('r1');
    expect(events).toEqual(['busy', 'end:r1:watchdog', 'idle', 'busy', 'end:r1:terminal', 'idle']);
  });

  it('remembers that a tool call started', () => {
    const { tracker } = setup();
    tracker.seen('r1', IM);
    expect(tracker.toolSeen('r1')).toBe(false);
    tracker.toolStart('r1', 't1', 'exec', IM);
    expect(tracker.toolSeen('r1')).toBe(true);
    expect(tracker.toolSeen('nope')).toBe(false);
  });

  it('leaves no timer behind once everything ended', () => {
    const { tracker } = setup();
    tracker.seen('r1', IM);
    tracker.ended('r1');
    vi.advanceTimersByTime(MINUTE);
    expect(vi.getTimerCount()).toBe(0);
  });
});
