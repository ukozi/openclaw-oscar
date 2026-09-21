import type { HistoryEntry } from 'openclaw/plugin-sdk/reply-history';
import { formatTarget, normalizeName } from './names.js';
import type { PeerRef, RoomRef } from './names.js';
import { createLoginBudget } from './oscar/index.js';
import type { Logger, LoginBudget, OscarSession, StateReason, TimerApi } from './oscar/index.js';
import type { Role } from './policy.js';

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
  roomsExt?: RoomsExt;
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

const RECENT_LINES_MAX = 20;

export type HomeRoomStatus = 'unset' | 'pending' | 'joined' | 'missing' | 'failed';
export type RoomLine = { from: string; role: Role; text: string; at: number };
export type RoomsExt = {
  home: { status: HomeRoomStatus; detail?: string };
  homeRegistered: boolean;
  homeBusy: boolean;
  joined: Set<string>;
  joining: Set<string>;
  invitedBy: Map<string, string>;
  history: Map<string, HistoryEntry[]>;
  recentLines: Map<string, RoomLine[]>;
  activity: Map<string, number>;
  seen: Map<string, number>;
  aloneTimers: Map<string, ReturnType<typeof setTimeout>>;
  joinNotes: { last: Map<string, number>; sentAt: number[] };
  tails: Map<string, Promise<void>>;
};

export function roomsExt(rt: AccountRuntime): RoomsExt {
  if (!rt.roomsExt) {
    rt.roomsExt = {
      home: { status: 'unset' },
      homeRegistered: false,
      homeBusy: false,
      joined: new Set(),
      joining: new Set(),
      invitedBy: new Map(),
      history: new Map(),
      recentLines: new Map(),
      activity: new Map(),
      seen: new Map(),
      aloneTimers: new Map(),
      joinNotes: { last: new Map(), sentAt: [] },
      tails: new Map(),
    };
  }
  return rt.roomsExt;
}

export function roomKey(ref: RoomRef): string {
  return formatTarget({ kind: 'room', room: ref });
}

export function joinedRooms(rt: AccountRuntime): RoomRef[] {
  const ext = roomsExt(rt);
  return [...rt.rooms.entries()].filter(([key]) => ext.joined.has(key)).map(([, state]) => state.ref);
}

function refreshAlone(state: RoomState, self: string, now: number): void {
  const me = normalizeName(self);
  const others = [...state.occupants].some((name) => name !== me);
  if (others) delete state.aloneSince;
  else if (state.aloneSince === undefined) state.aloneSince = now;
}

export function applyRoomReady(
  rt: AccountRuntime,
  ref: RoomRef,
  occupants: string[],
  self: string,
  now: number,
): RoomState {
  const key = roomKey(ref);
  const ext = roomsExt(rt);
  const prev = rt.rooms.get(key);
  const names = occupants.map((name) => normalizeName(name));
  const state: RoomState = {
    ref,
    occupants: new Set(names),
    joinSeenAt: new Map(names.map((name) => [name, now])),
    selfJoinedAt: now,
    omittedCount: prev?.omittedCount ?? 0,
  };
  const invitedBy = ext.invitedBy.get(key) ?? prev?.invitedBy;
  if (invitedBy !== undefined) state.invitedBy = invitedBy;
  if (prev?.lastBotLine) state.lastBotLine = prev.lastBotLine;
  refreshAlone(state, self, now);
  rt.rooms.set(key, state);
  ext.joined.add(key);
  ext.joining.delete(key);
  return state;
}

export function applyRoomJoin(
  rt: AccountRuntime,
  ref: RoomRef,
  name: string,
  self: string,
  now: number,
): RoomState | undefined {
  const state = rt.rooms.get(roomKey(ref));
  if (!state) return undefined;
  const who = normalizeName(name);
  state.occupants.add(who);
  state.joinSeenAt.set(who, now);
  refreshAlone(state, self, now);
  return state;
}

export function applyRoomLeave(
  rt: AccountRuntime,
  ref: RoomRef,
  name: string,
  self: string,
  now: number,
): RoomState | undefined {
  const state = rt.rooms.get(roomKey(ref));
  if (!state) return undefined;
  const who = normalizeName(name);
  state.occupants.delete(who);
  state.joinSeenAt.delete(who);
  refreshAlone(state, self, now);
  return state;
}

export function applyRoomClosed(rt: AccountRuntime, ref: RoomRef, willRejoin: boolean): void {
  const key = roomKey(ref);
  const ext = roomsExt(rt);
  ext.joined.delete(key);
  const state = rt.rooms.get(key);
  if (willRejoin) {
    if (state) {
      state.occupants.clear();
      state.joinSeenAt.clear();
      delete state.aloneSince;
    }
    return;
  }
  rt.rooms.delete(key);
  ext.invitedBy.delete(key);
  ext.history.delete(key);
  ext.recentLines.delete(key);
  ext.activity.delete(key);
}

export function pushRecentLine(rt: AccountRuntime, key: string, line: RoomLine): void {
  const ext = roomsExt(rt);
  const lines = ext.recentLines.get(key) ?? [];
  lines.push(line);
  if (lines.length > RECENT_LINES_MAX) lines.splice(0, lines.length - RECENT_LINES_MAX);
  ext.recentLines.set(key, lines);
}

export function touchActivity(rt: AccountRuntime, target: string, now: number): void {
  roomsExt(rt).activity.set(target, now);
}
