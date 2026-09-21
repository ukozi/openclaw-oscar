import type { OriginClass } from '../../src/policy.js';
import type { RunChange, RunInfo, RunTerminal } from '../../src/presence/runs.js';

type IdleFn = (last: RunTerminal) => void;

export class FakeRunTracker {
  private runs = new Map<string, RunInfo[]>();
  private idle = new Map<string, Set<IdleFn>>();
  private listeners = new Set<(change: RunChange) => void>();
  private seq = 0;

  start(sessionKey: string, accountId: string, origin: OriginClass): string {
    const runId = `run-${++this.seq}`;
    const run: RunInfo = { runId, sessionKey, accountId, origin, startedAt: Date.now() };
    const list = this.runs.get(sessionKey) ?? [];
    list.push(run);
    this.runs.set(sessionKey, list);
    for (const fn of [...this.listeners]) fn({ kind: 'start', run });
    return runId;
  }

  end(sessionKey: string, last: RunTerminal = 'end'): void {
    const list = this.runs.get(sessionKey) ?? [];
    const run = list.shift();
    if (run) for (const fn of [...this.listeners]) fn({ kind: 'end', run, why: 'terminal' });
    if (list.length > 0) return;
    this.runs.delete(sessionKey);
    this.answer(sessionKey, last);
  }

  reset(): void {
    const dropped = [...this.runs.entries()];
    this.runs.clear();
    for (const [sessionKey, list] of dropped) {
      for (const run of list) for (const fn of [...this.listeners]) fn({ kind: 'end', run, why: 'reset' });
      this.answer(sessionKey, 'end');
    }
  }

  activeRun(sessionKey: string): RunInfo | null {
    return this.runs.get(sessionKey)?.[0] ?? null;
  }

  onIdle(sessionKey: string, fn: IdleFn): () => void {
    if (!this.activeRun(sessionKey)) {
      let cancelled = false;
      queueMicrotask(() => {
        if (!cancelled) fn('end');
      });
      return () => {
        cancelled = true;
      };
    }
    const set = this.idle.get(sessionKey) ?? new Set<IdleFn>();
    set.add(fn);
    this.idle.set(sessionKey, set);
    return () => set.delete(fn);
  }

  onRun(fn: (change: RunChange) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private answer(sessionKey: string, last: RunTerminal): void {
    const fns = [...(this.idle.get(sessionKey) ?? [])];
    this.idle.delete(sessionKey);
    for (const fn of fns) fn(last);
  }
}
