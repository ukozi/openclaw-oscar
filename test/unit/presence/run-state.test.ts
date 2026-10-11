import { describe, expect, it, vi } from 'vitest';
import { RUN_HEARTBEAT_MS, createRunStateMachine } from '../../../src/presence/run-state.js';

type Patch = { activeRuns: number; busy: boolean; lastRunActivityAt?: number };

function setup(abortSignal?: AbortSignal) {
  vi.useFakeTimers();
  let clock = 1000;
  const status: Patch[] = [];
  const machine = createRunStateMachine({ setStatus: (p) => status.push(p), abortSignal, now: () => clock });
  return { machine, status, tick: (ms: number) => { clock += ms; vi.advanceTimersByTime(ms); } };
}

describe('createRunStateMachine', () => {
  it('publishes idle at start', () => {
    const { status } = setup();
    expect(status).toEqual([{ activeRuns: 0, busy: false }]);
    vi.useRealTimers();
  });

  it('counts runs and stamps activity', () => {
    const { machine, status } = setup();
    machine.onRunStart();
    machine.onRunStart();
    machine.onRunEnd();
    expect(status.slice(1)).toEqual([
      { activeRuns: 1, busy: true, lastRunActivityAt: 1000 },
      { activeRuns: 2, busy: true, lastRunActivityAt: 1000 },
      { activeRuns: 1, busy: true, lastRunActivityAt: 1000 },
    ]);
    machine.onRunEnd();
    machine.onRunEnd();
    expect(status.at(-1)).toEqual({ activeRuns: 0, busy: false, lastRunActivityAt: 1000 });
    vi.useRealTimers();
  });

  it('beats while busy and stops when idle', () => {
    const { machine, status, tick } = setup();
    machine.onRunStart();
    tick(RUN_HEARTBEAT_MS);
    expect(status.at(-1)).toEqual({ activeRuns: 1, busy: true, lastRunActivityAt: 1000 + RUN_HEARTBEAT_MS });
    machine.onRunEnd();
    const count = status.length;
    tick(RUN_HEARTBEAT_MS * 3);
    expect(status.length).toBe(count);
    vi.useRealTimers();
  });

  it('goes quiet after abort or deactivate', () => {
    const ctl = new AbortController();
    const { machine, status, tick } = setup(ctl.signal);
    machine.onRunStart();
    ctl.abort();
    expect(machine.isActive()).toBe(false);
    const count = status.length;
    machine.onRunStart();
    tick(RUN_HEARTBEAT_MS * 2);
    expect(status.length).toBe(count);
    vi.useRealTimers();
  });

  it('publishes nothing when already aborted', () => {
    const ctl = new AbortController();
    ctl.abort();
    const { status } = setup(ctl.signal);
    expect(status).toEqual([]);
    vi.useRealTimers();
  });
});
