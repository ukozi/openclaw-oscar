import type { PeerRef, RoomRef } from './names.js';
import { createLoginBudget } from './oscar/index.js';
import type { Logger, LoginBudget, OscarSession, StateReason, TimerApi } from './oscar/index.js';

export type RoomState = {
  ref: RoomRef; occupants: Set<string>; joinSeenAt: Map<string, number>; selfJoinedAt: number;
  invitedBy?: string; lastBotLine?: { from: string; at: number }; omittedCount: number; aloneSince?: number;
};
export type ProbeResult = 'checks' | 'does-not-check' | 'unknown';
export type AccountRuntime = {
  accountId: string; session: OscarSession; rooms: Map<string, RoomState>;
  sessionKeys: Map<string, { accountId: string; peer: PeerRef }>;
  lastReplyAt: Map<string, number>;
  counters: { droppedSends: number; eventGaps: number };
  halted?: { reason: StateReason; detail: string };
  probe?: { result: ProbeResult; at: number };
};
export type HostRuntime = { config: { current(): unknown } };
export type Timers = TimerApi;

type Holder = {
  accounts: Map<string, AccountRuntime>;
  generations: Map<string, number>;
  probes: Map<string, { result: ProbeResult; at: number }>;
  host?: HostRuntime;
  budget?: LoginBudget;
};

const SLOT = Symbol.for('openclaw-oscar.runtime');
const PROBE_TTL_MS = 24 * 3600_000;
const PROBE_RETRY_MS = 60_000;
const PROBE_RETRY_MAX_MS = 3600_000;

function holder(): Holder {
  const g = globalThis as unknown as Record<symbol, Holder | undefined>;
  let h = g[SLOT];
  if (!h) {
    h = { accounts: new Map(), generations: new Map(), probes: new Map() };
    g[SLOT] = h;
  }
  return h;
}

export function getRuntime(accountId: string): AccountRuntime | undefined {
  return holder().accounts.get(accountId);
}

export function setRuntime(rt: AccountRuntime): void {
  holder().accounts.set(rt.accountId, rt);
}

export function clearRuntime(accountId: string): void {
  holder().accounts.delete(accountId);
}

export function runtimeForSessionKey(sessionKey: string): AccountRuntime | undefined {
  for (const rt of holder().accounts.values()) if (rt.sessionKeys.has(sessionKey)) return rt;
  return undefined;
}

export function nextGeneration(accountId: string): number {
  const next = currentGeneration(accountId) + 1;
  holder().generations.set(accountId, next);
  return next;
}

export function currentGeneration(accountId: string): number {
  return holder().generations.get(accountId) ?? 0;
}

export function setHost(host: HostRuntime | undefined): void {
  const h = holder();
  if (host) h.host = host;
  else delete h.host;
}

export function liveConfig(fallback: unknown): unknown {
  try {
    return holder().host?.config.current() ?? fallback;
  } catch {
    return fallback;
  }
}

export function sharedLoginBudget(): LoginBudget {
  const h = holder();
  h.budget ??= createLoginBudget();
  return h.budget;
}

export type PasswordGuardDeps = {
  cacheKey: string; allowUnauthenticated: boolean; probe: () => Promise<ProbeResult>;
  now: () => number; timers: Timers; log: Logger;
  onResult: (r: { result: ProbeResult; at: number }) => void;
  halt: (detail: string) => Promise<void>;
};

export function createPasswordGuard(deps: PasswordGuardDeps): { onOnline(): void; stop(): void; idle(): Promise<void> } {
  let started = false;
  let stopped = false;
  let retryMs = PROBE_RETRY_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let work: Promise<void> = Promise.resolve();

  const settle = async (r: { result: ProbeResult; at: number }): Promise<void> => {
    deps.onResult(r);
    if (r.result === 'does-not-check' && !deps.allowUnauthenticated) {
      await deps.halt('the server accepted a random password, so it does not check passwords');
    }
  };

  const run = async (): Promise<void> => {
    if (stopped) return;
    let result: ProbeResult = 'unknown';
    try {
      result = await deps.probe();
    } catch (err) {
      deps.log.warn('password check failed to run', { error: err instanceof Error ? err.message : String(err) });
    }
    const record = { result, at: deps.now() };
    if (result === 'unknown') {
      deps.onResult(record);
      if (stopped) return;
      const delay = retryMs;
      retryMs = Math.min(retryMs * 2, PROBE_RETRY_MAX_MS);
      timer = deps.timers.setTimeout(() => { work = work.then(run); }, delay);
      return;
    }
    holder().probes.set(deps.cacheKey, record);
    await settle(record);
  };

  return {
    onOnline(): void {
      if (started || stopped) return;
      started = true;
      const cached = holder().probes.get(deps.cacheKey);
      if (cached && deps.now() - cached.at < PROBE_TTL_MS) {
        work = work.then(() => settle(cached));
        return;
      }
      work = work.then(run);
    },
    stop(): void {
      stopped = true;
      if (timer) deps.timers.clearTimeout(timer);
    },
    idle: () => work,
  };
}

export function resetRuntimeForTests(): void {
  const g = globalThis as unknown as Record<symbol, Holder | undefined>;
  delete g[SLOT];
}
