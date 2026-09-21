import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRunTracker, driveRunState, getRunTracker, handleLifecycle } from '../../../src/presence/runs.js';

const IM = 'agent:main:oscar:group:botone/alice';
const ROOM = 'agent:main:oscar:group:botone#4.testroom';

function setup() {
  const tracker = createRunTracker();
  const events: string[] = [];
  tracker.on('busy', (id) => events.push(`busy:${id}`));
  tracker.on('idle', (id) => events.push(`idle:${id}`));
  tracker.bind(IM, 'botone', 'owner');
  tracker.bind(ROOM, 'botone', 'approved');
  const life = (runId: string, phase: string, sessionKey?: string) =>
    handleLifecycle(tracker, { runId, stream: 'lifecycle', data: { phase }, sessionKey });
  return { tracker, events, life };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('run tracker', () => {
  it('counts a run from start to end', () => {
    const { tracker, events, life } = setup();
    life('r1', 'start', IM);
    expect(tracker.isBusy('botone')).toBe(true);
    expect(tracker.activeCount('botone')).toBe(1);
    life('r1', 'end', IM);
    expect(tracker.isBusy('botone')).toBe(false);
    expect(events).toEqual(['busy:botone', 'idle:botone']);
  });

  it('ignores sessions it never dispatched', () => {
    const { tracker, events, life } = setup();
    life('r1', 'start', 'agent:main:discord:group:123');
    life('r2', 'start', undefined);
    expect(tracker.isBusy('botone')).toBe(false);
    expect(events).toEqual([]);
  });

  it('ignores other streams', () => {
    const { tracker } = setup();
    handleLifecycle(tracker, { runId: 'r1', stream: 'tool', data: { phase: 'start' }, sessionKey: IM });
    expect(tracker.isBusy('botone')).toBe(false);
  });

  it('ignores a repeated start', () => {
    const { tracker, events, life } = setup();
    life('r1', 'start', IM);
    const first = tracker.runInfo('r1')!.startedAt;
    vi.advanceTimersByTime(5000);
    life('r1', 'start', IM);
    expect(tracker.activeCount('botone')).toBe(1);
    expect(tracker.runInfo('r1')!.startedAt).toBe(first);
    expect(events).toEqual(['busy:botone']);
  });

  it('treats finishing as still running and error as the end', () => {
    const { tracker, life } = setup();
    life('r1', 'start', IM);
    life('r1', 'finishing', IM);
    expect(tracker.isBusy('botone')).toBe(true);
    life('r1', 'error', IM);
    expect(tracker.isBusy('botone')).toBe(false);
  });

  it('does not bring a finished run back', () => {
    const { tracker, life } = setup();
    life('r1', 'start', IM);
    life('r1', 'end', IM);
    life('r1', 'finishing', IM);
    tracker.seen('r1', IM);
    expect(tracker.isBusy('botone')).toBe(false);
  });

  it('stays busy until the last of two runs ends', () => {
    const { tracker, events, life } = setup();
    life('r1', 'start', IM);
    life('r2', 'start', ROOM);
    life('r1', 'end', IM);
    expect(tracker.isBusy('botone')).toBe(true);
    life('r2', 'end', ROOM);
    expect(events).toEqual(['busy:botone', 'idle:botone']);
  });

  it('counts a queued follow-up run that only has a session key', () => {
    const { tracker, life } = setup();
    tracker.seen('r1', IM);
    life('r1', 'end', IM);
    life('r2', 'start', IM);
    expect(tracker.activeRun(IM)?.runId).toBe('r2');
  });

  it('matches session keys without regard to case', () => {
    const { tracker, life } = setup();
    life('r1', 'start', IM.toUpperCase());
    expect(tracker.activeRun(IM)?.runId).toBe('r1');
  });

  it('keeps accounts apart', () => {
    const { tracker, events, life } = setup();
    tracker.bind('agent:two:oscar:group:bottwo/alice', 'bottwo', 'owner');
    life('r1', 'start', 'agent:two:oscar:group:bottwo/alice');
    expect(tracker.isBusy('bottwo')).toBe(true);
    expect(tracker.isBusy('botone')).toBe(false);
    expect(events).toEqual(['busy:bottwo']);
  });

  it('reports the oldest run of a session with the origin bound at its start', () => {
    const { tracker, life } = setup();
    life('r1', 'start', ROOM);
    vi.advanceTimersByTime(10);
    tracker.bind(ROOM, 'botone', 'owner');
    life('r2', 'start', ROOM);
    expect(tracker.activeRun(ROOM)).toMatchObject({ runId: 'r1', origin: 'approved', accountId: 'botone' });
    expect(tracker.runInfo('r2')?.origin).toBe('owner');
    expect(tracker.activeRun(IM)).toBeNull();
  });

  it('calls onIdle once when the session has no runs left', async () => {
    const { tracker, life } = setup();
    const calls: string[] = [];
    life('r1', 'start', ROOM);
    life('r2', 'start', ROOM);
    life('r3', 'start', IM);
    tracker.onIdle(ROOM, () => calls.push('room'));
    const cancel = tracker.onIdle(ROOM, () => calls.push('cancelled'));
    cancel();
    life('r1', 'end', ROOM);
    expect(calls).toEqual([]);
    life('r2', 'end', ROOM);
    expect(calls).toEqual(['room']);
    life('r2', 'end', ROOM);
    expect(calls).toEqual(['room']);
    tracker.onIdle(ROOM, () => calls.push('already'));
    await Promise.resolve();
    expect(calls).toEqual(['room', 'already']);
  });

  it('tells an idle waiter how the last run ended', async () => {
    const { tracker, life } = setup();
    const calls: string[] = [];
    life('r1', 'start', ROOM);
    tracker.onIdle(ROOM, (last) => calls.push(`room:${last}`));
    life('r1', 'error', ROOM);
    life('r2', 'start', ROOM);
    life('r3', 'start', ROOM);
    tracker.onIdle(ROOM, (last) => calls.push(`room:${last}`));
    life('r2', 'error', ROOM);
    life('r3', 'end', ROOM);
    tracker.onIdle(IM, (last) => calls.push(`im:${last}`));
    await Promise.resolve();
    expect(calls).toEqual(['room:error', 'room:end', 'im:end']);
  });

  it('reset empties the account and lets a live run come back', () => {
    const { tracker, events, life } = setup();
    const idle: string[] = [];
    life('r1', 'start', IM);
    tracker.onIdle(IM, (last) => idle.push(`im:${last}`));
    tracker.reset('botone');
    expect(tracker.isBusy('botone')).toBe(false);
    expect(idle).toEqual(['im:end']);
    tracker.seen('r1', IM);
    expect(tracker.isBusy('botone')).toBe(true);
    expect(events).toEqual(['busy:botone', 'idle:botone', 'busy:botone']);
  });

  it('survives a listener that throws', () => {
    const { tracker, life } = setup();
    tracker.on('busy', () => {
      throw new Error('boom');
    });
    const seen: string[] = [];
    tracker.on('busy', (id) => seen.push(id));
    life('r1', 'start', IM);
    expect(seen).toEqual(['botone']);
  });

  it('drives a run state machine per run', () => {
    const { tracker, life } = setup();
    const calls: string[] = [];
    const stop = driveRunState(tracker, 'botone', { onRunStart: () => calls.push('start'), onRunEnd: () => calls.push('end') });
    tracker.bind('agent:two:oscar:group:bottwo/alice', 'bottwo', 'owner');
    life('r1', 'start', IM);
    life('r2', 'start', ROOM);
    life('x1', 'start', 'agent:two:oscar:group:bottwo/alice');
    life('r1', 'end', IM);
    tracker.reset('botone');
    expect(calls).toEqual(['start', 'start', 'end', 'end']);
    stop();
    life('r9', 'start', IM);
    expect(calls).toHaveLength(4);
  });

  it('shares one tracker per process', () => {
    expect(getRunTracker()).toBe(getRunTracker());
  });
});
