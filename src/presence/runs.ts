import type { Logger } from '../oscar/index.js';
import type { OriginClass } from '../policy.js';

export type RunInfo = { runId: string; sessionKey: string; accountId: string; origin: OriginClass; startedAt: number };
export type RunEndReason = 'terminal' | 'excluded' | 'watchdog' | 'reset';
export type RunTerminal = 'end' | 'error';
export type RunChange = { kind: 'start'; run: RunInfo } | { kind: 'end'; run: RunInfo; why: RunEndReason };

export interface RunTracker {
  bind(sessionKey: string, accountId: string, origin: OriginClass): void;
  activeRun(sessionKey: string): RunInfo | null;
  activeCount(accountId: string): number;
  onIdle(sessionKey: string, fn: (last: RunTerminal) => void): () => void;
  on(event: 'busy' | 'idle', fn: (accountId: string) => void): () => void;
  reset(accountId: string): void;
  isBusy(accountId: string): boolean;
  runInfo(runId: string): RunInfo | null;
  onRun(fn: (change: RunChange) => void): () => void;
}

export interface RunFeed {
  seen(runId: string, sessionKey?: string): void;
  ended(runId: string, phase?: RunTerminal): void;
}

export type RunTrackerOptions = { now?: () => number; log?: Logger };

const MEMO_LIMIT = 256;
const MAX_BINDINGS = 1000;

type Tracked = RunInfo & { lastEventAt: number };

function boundedSet(limit: number) {
  const items = new Set<string>();
  return {
    has: (key: string) => items.has(key),
    add(key: string) {
      items.delete(key);
      items.add(key);
      if (items.size > limit) {
        const oldest = items.values().next().value;
        if (oldest !== undefined) items.delete(oldest);
      }
    },
    delete: (key: string) => items.delete(key),
  };
}

function normKey(sessionKey: string | undefined | null): string {
  return (sessionKey ?? '').trim().toLowerCase();
}

function infoOf(run: Tracked): RunInfo {
  return { runId: run.runId, sessionKey: run.sessionKey, accountId: run.accountId, origin: run.origin, startedAt: run.startedAt };
}

export function createRunTracker(opts: RunTrackerOptions = {}): RunTracker & RunFeed {
  const now = opts.now ?? Date.now;
  const log = opts.log;

  const bindings = new Map<string, { accountId: string; origin: OriginClass }>();
  const runs = new Map<string, Tracked>();
  const endedRuns = boundedSet(MEMO_LIMIT);
  const busyListeners = new Set<(accountId: string) => void>();
  const idleListeners = new Set<(accountId: string) => void>();
  const runListeners = new Set<(change: RunChange) => void>();
  const idleWaiters = new Map<string, Set<(last: RunTerminal) => void>>();

  function call<A>(fn: (arg: A) => void, arg: A): void {
    try {
      fn(arg);
    } catch (err) {
      log?.warn('run tracker listener failed', { error: String(err) });
    }
  }

  function isBusy(accountId: string): boolean {
    for (const run of runs.values()) if (run.accountId === accountId) return true;
    return false;
  }

  function settle(accountId: string, wasBusy: boolean): void {
    const busy = isBusy(accountId);
    if (busy === wasBusy) return;
    for (const fn of [...(busy ? busyListeners : idleListeners)]) call(fn, accountId);
  }

  function activeRun(sessionKey: string): RunInfo | null {
    const key = normKey(sessionKey);
    let first: Tracked | undefined;
    for (const run of runs.values()) {
      if (run.sessionKey === key && (!first || run.startedAt < first.startedAt)) first = run;
    }
    return first ? infoOf(first) : null;
  }

  function add(runId: string, sessionKey: string | undefined): Tracked | null {
    if (endedRuns.has(runId)) return null;
    const key = normKey(sessionKey);
    const binding = key ? bindings.get(key) : undefined;
    if (!binding) return null;
    const at = now();
    const run: Tracked = {
      runId, sessionKey: key, accountId: binding.accountId, origin: binding.origin, startedAt: at, lastEventAt: at,
    };
    const wasBusy = isBusy(run.accountId);
    runs.set(runId, run);
    for (const fn of [...runListeners]) call(fn, { kind: 'start', run: infoOf(run) });
    settle(run.accountId, wasBusy);
    return run;
  }

  function touch(runId: string, sessionKey: string | undefined): Tracked | null {
    const run = runs.get(runId);
    if (!run) return add(runId, sessionKey);
    run.lastEventAt = now();
    return run;
  }

  function remove(run: Tracked, why: RunEndReason, last: RunTerminal = 'end'): void {
    const wasBusy = isBusy(run.accountId);
    runs.delete(run.runId);
    for (const fn of [...runListeners]) call(fn, { kind: 'end', run: infoOf(run), why });
    if (!activeRun(run.sessionKey)) {
      const waiters = idleWaiters.get(run.sessionKey);
      idleWaiters.delete(run.sessionKey);
      for (const fn of waiters ?? []) call(fn, last);
    }
    settle(run.accountId, wasBusy);
  }

  return {
    bind(sessionKey, accountId, origin) {
      const key = normKey(sessionKey);
      if (!key) return;
      bindings.delete(key);
      bindings.set(key, { accountId, origin });
      if (bindings.size > MAX_BINDINGS) {
        const oldest = bindings.keys().next().value;
        if (oldest !== undefined) bindings.delete(oldest);
      }
    },
    activeRun,
    activeCount(accountId) {
      let count = 0;
      for (const run of runs.values()) if (run.accountId === accountId) count += 1;
      return count;
    },
    onIdle(sessionKey, fn) {
      const key = normKey(sessionKey);
      if (!activeRun(key)) {
        let cancelled = false;
        queueMicrotask(() => {
          if (!cancelled) call(fn, 'end');
        });
        return () => {
          cancelled = true;
        };
      }
      const waiters = idleWaiters.get(key) ?? new Set<(last: RunTerminal) => void>();
      idleWaiters.set(key, waiters);
      waiters.add(fn);
      return () => {
        waiters.delete(fn);
      };
    },
    on(event, fn) {
      const listeners = event === 'busy' ? busyListeners : idleListeners;
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    reset(accountId) {
      for (const run of [...runs.values()]) if (run.accountId === accountId) remove(run, 'reset');
    },
    isBusy,
    runInfo(runId) {
      const run = runs.get(runId);
      return run ? infoOf(run) : null;
    },
    onRun(fn) {
      runListeners.add(fn);
      return () => {
        runListeners.delete(fn);
      };
    },
    seen(runId, sessionKey) {
      touch(runId, sessionKey);
    },
    ended(runId, phase = 'end') {
      endedRuns.add(runId);
      const run = runs.get(runId);
      if (run) remove(run, 'terminal', phase);
    },
  };
}

const TRACKER_SLOT = Symbol.for('openclaw-oscar.runTracker');

export function getRunTracker(): RunTracker & RunFeed {
  const holder = globalThis as unknown as Record<symbol, (RunTracker & RunFeed) | undefined>;
  let tracker = holder[TRACKER_SLOT];
  if (!tracker) {
    tracker = createRunTracker();
    holder[TRACKER_SLOT] = tracker;
  }
  return tracker;
}

export type LifecycleEvent = { runId: string; stream: string; data: Record<string, unknown>; sessionKey?: string };

export function handleLifecycle(feed: Pick<RunFeed, 'seen' | 'ended'>, event: LifecycleEvent): void {
  if (event.stream !== 'lifecycle') return;
  const phase = event.data['phase'];
  if (phase === 'end' || phase === 'error') feed.ended(event.runId, phase);
  else if (typeof phase === 'string') feed.seen(event.runId, event.sessionKey);
}

export function driveRunState(
  tracker: Pick<RunTracker, 'onRun'>,
  accountId: string,
  machine: { onRunStart(): void; onRunEnd(): void },
): () => void {
  return tracker.onRun((change) => {
    if (change.run.accountId !== accountId) return;
    if (change.kind === 'start') machine.onRunStart();
    else machine.onRunEnd();
  });
}
