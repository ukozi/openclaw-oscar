import type { RootPolicy } from '../../src/config.js';
import type { RoomDeps, RoomLineRecord, TurnRequest } from '../../src/inbound/room.js';
import type { RoomRef } from '../../src/names.js';
import type {
  InviteEvent,
  Logger,
  OscarEvents,
  OscarSession,
  RoomMessageEvent,
  SendReceipt,
  SessionPhase,
} from '../../src/oscar/index.js';
import type { AccountRuntime } from '../../src/runtime.js';

export const ROOM: RoomRef = { exchange: 4, name: 'testroom' };
export const KEY = 'room:4:testroom';

export const silentLog: Logger = { debug() {}, info() {}, warn() {}, error() {} };

export function policyFixture(over: Partial<RootPolicy> = {}): RootPolicy {
  return {
    owners: ['alice'],
    allowFrom: ['alice', 'bob'],
    dmPolicy: 'allowlist',
    contactNotice: { cooldownHours: 6, maxPerHour: 5 },
    nonOwnerTools: { deny: ['group:runtime', 'group:fs', 'group:automation', 'group:nodes', 'sessions_spawn'] },
    outbound: { allowUnlisted: false },
    room: { ref: ROOM, historyFrom: 'listed', notifyOnUnlistedJoin: true },
    invites: { accept: 'approved', maxRooms: 5, leaveWhenAloneMinutes: 10 },
    rooms: {},
    awareness: { lines: 5 },
    chain: {
      roster: [],
      floorSeconds: 120,
      takeoverMs: 10000,
      ackAfterMs: 8000,
      ackText: 'on it',
      busyText: 'busy, will pick this up next',
      maxHops: 2,
      resultTimeoutMinutes: 20,
      reviewResults: false,
    },
    ...over,
  };
}

export function fakeSession(screenName = 'BotOne') {
  const handlers = new Map<string, Set<(payload: unknown) => void>>();
  const calls = {
    joinRoom: [] as { room: RoomRef; persistent: boolean }[],
    joinInvited: [] as InviteEvent[],
    leaveRoom: [] as RoomRef[],
    sendIm: [] as { to: string; html: string; priority?: string }[],
    sendRoom: [] as { room: RoomRef; html: string; whisperTo?: string; priority?: string }[],
  };
  const fail: { joinRoom?: unknown; joinInvited?: unknown } = {};
  const hold: { joinInvited?: Promise<void> } = {};
  let phase: SessionPhase = 'online';
  const receipt: SendReceipt = { id: 'r1', storedOffline: false };
  const api = {
    on(event: string, fn: (payload: unknown) => void) {
      const set = handlers.get(event) ?? new Set();
      set.add(fn);
      handlers.set(event, set);
      return () => {
        set.delete(fn);
      };
    },
    getState: () => ({ phase, since: 0, attempts: 0 }),
    selfInfo: () => ({ screenName, bot: false }),
    rooms: () => [],
    async joinRoom(room: RoomRef, opts?: { persistent?: boolean }) {
      calls.joinRoom.push({ room, persistent: opts?.persistent === true });
      if (fail.joinRoom !== undefined) throw fail.joinRoom;
    },
    async joinInvited(invite: InviteEvent) {
      calls.joinInvited.push(invite);
      if (hold.joinInvited) await hold.joinInvited;
      if (fail.joinInvited !== undefined) throw fail.joinInvited;
    },
    async leaveRoom(room: RoomRef) {
      calls.leaveRoom.push(room);
    },
    async sendIm(to: string, html: string, opts?: { priority?: string }) {
      calls.sendIm.push({ to, html, priority: opts?.priority });
      return receipt;
    },
    async sendRoom(room: RoomRef, html: string, opts?: { whisperTo?: string; priority?: string }) {
      calls.sendRoom.push({ room, html, whisperTo: opts?.whisperTo, priority: opts?.priority });
      return receipt;
    },
  };
  function emit<E extends keyof OscarEvents>(event: E, payload: OscarEvents[E]): void {
    for (const fn of handlers.get(event) ?? []) fn(payload);
  }
  return {
    session: api as unknown as OscarSession,
    emit,
    calls,
    fail,
    hold,
    listenerCount: (event: string) => handlers.get(event)?.size ?? 0,
    setPhase(next: SessionPhase) {
      phase = next;
    },
  };
}

export function makeRt(session: OscarSession = fakeSession().session): AccountRuntime {
  return {
    accountId: 'botone',
    session,
    rooms: new Map(),
    sessionKeys: new Map(),
    lastReplyAt: new Map(),
    counters: { droppedSends: 0, eventGaps: 0 },
  } as AccountRuntime;
}

export function manualTimers() {
  let seq = 0;
  let nowMs = 1_000_000;
  const pending = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => nowMs,
    timers: {
      setTimeout: ((fn: () => void, ms?: number) => {
        seq += 1;
        pending.set(seq, { at: nowMs + (ms ?? 0), fn });
        return seq as unknown as ReturnType<typeof setTimeout>;
      }) as unknown as typeof setTimeout,
      clearTimeout: ((id: unknown) => {
        pending.delete(id as number);
      }) as unknown as typeof clearTimeout,
    },
    advance(ms: number) {
      nowMs += ms;
      for (const [id, t] of [...pending]) {
        if (t.at <= nowMs && pending.delete(id)) t.fn();
      }
    },
    pending: () => pending.size,
  };
}

export async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

export function roomDeps(over: Partial<RoomDeps> = {}) {
  const turns: TurnRequest[] = [];
  const records: RoomLineRecord[] = [];
  const notices: { name: string; display: string }[] = [];
  const ownerNotes: string[] = [];
  let policy = policyFixture();
  let nowMs = 10_000;
  const deps: RoomDeps = {
    policy: () => policy,
    self: () => 'BotOne',
    now: () => nowMs,
    timers: { setTimeout, clearTimeout },
    log: silentLog,
    runTurn: async (req) => {
      turns.push(req);
    },
    record: async (rec) => {
      records.push(rec);
      const entries = rec.historyMap.get(rec.historyKey) ?? [];
      entries.push({ sender: rec.senderLabel, body: rec.text, timestamp: rec.timestamp, messageId: rec.messageId });
      rec.historyMap.set(rec.historyKey, entries);
    },
    noticeStranger: (name, display) => {
      notices.push({ name, display });
    },
    tellOwners: async (text) => {
      ownerNotes.push(text);
    },
    contacts: () => [],
    ...over,
  };
  return {
    deps,
    turns,
    records,
    notices,
    ownerNotes,
    setPolicy(next: RootPolicy) {
      policy = next;
    },
    tick(ms: number) {
      nowMs += ms;
    },
  };
}

export function line(from: string, text: string, over: Partial<RoomMessageEvent> = {}): RoomMessageEvent {
  return { room: ROOM, from, fromDisplay: from, text, cookie: 0n, whisper: false, serverGenerated: false, ...over };
}
