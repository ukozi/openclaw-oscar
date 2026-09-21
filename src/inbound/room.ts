import { runChannelInboundEvent } from 'openclaw/plugin-sdk/channel-inbound';
import type { ChannelBotLoopProtectionFacts } from 'openclaw/plugin-sdk/channel-inbound';
import type { HistoryEntry } from 'openclaw/plugin-sdk/reply-history';
import { awarenessFor } from '../awareness.js';
import type { ContactAttemptView, UntrustedEntry } from '../awareness.js';
import type { RootPolicy } from '../config.js';
import { escapeNonAscii, normalizeName, normalizeRoom, senderLabel } from '../names.js';
import type { PeerRef, RoomRef } from '../names.js';
import type { Logger, RoomMessageEvent } from '../oscar/index.js';
import { neutralizeDirectives, roleOf } from '../policy.js';
import type { OriginClass, Role } from '../policy.js';
import { pushRecentLine, roomKey, roomsExt, touchActivity } from '../runtime.js';
import type { AccountRuntime, RoomState } from '../runtime.js';
import { soloPrompt, soloRoute } from './solo.js';

export const ROOM_HISTORY_LIMIT = 50;
const DEDUPE_MS = 60_000;
const ONLINE_HOST = 'onlinehost';

export type InboundRunner = typeof runChannelInboundEvent;

export type RoomLineRecord = {
  accountId: string;
  historyKey: string;
  historyMap: Map<string, HistoryEntry[]>;
  messageId: string;
  timestamp: number;
  senderLabel: string;
  text: string;
};

export type TurnRequest = {
  accountId: string;
  peer: PeerRef;
  origin: OriginClass;
  sender: { name: string; display: string; role: Role };
  messageId: string;
  timestamp: number;
  text: string;
  commandAuthorized: boolean;
  untrustedContext: UntrustedEntry[];
  group?: { label: string; systemPrompt: string; history: HistoryEntry[] };
  botLoopProtection?: ChannelBotLoopProtectionFacts;
};

export type RoomTurn = {
  room: RoomRef;
  sender: string;
  originator: string;
  origin: OriginClass;
  why: string;
  body: string;
  systemPrompt: string;
  commandAuthorized: boolean;
  cookie: bigint;
  untrusted?: UntrustedEntry[];
  botLoopProtection?: ChannelBotLoopProtectionFacts;
};

export type RoomSink = {
  wake(turn: RoomTurn): Promise<void>;
  record(ev: RoomMessageEvent): void;
  count(ev: RoomMessageEvent): void;
};

export type RoomBrain = { onRoomMessage(ev: RoomMessageEvent): void };

export type RoomDeps = {
  policy: () => RootPolicy;
  self: () => string;
  now: () => number;
  timers: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
  log: Logger;
  runTurn: (req: TurnRequest) => Promise<void>;
  record: (line: RoomLineRecord) => Promise<void>;
  noticeStranger: (name: string, display: string) => void;
  tellOwners: (text: string) => Promise<void>;
  contacts: () => ContactAttemptView[];
};

const sinks = new Map<string, RoomSink>();
const brains = new Map<string, RoomBrain>();
const solos = new Map<string, RoomBrain>();
let messageSeq = 0;

export async function recordRoomLine(line: RoomLineRecord, run: InboundRunner = runChannelInboundEvent): Promise<void> {
  await run<RoomLineRecord>({
    channel: 'oscar',
    accountId: line.accountId,
    raw: line,
    adapter: {
      ingest: (raw) => ({ id: raw.messageId, timestamp: raw.timestamp, rawText: raw.text, textForAgent: raw.text }),
      preflight: () => ({
        admission: { kind: 'drop', reason: 'room-record', recordHistory: true },
        message: { rawBody: line.text, bodyForAgent: line.text, senderLabel: line.senderLabel },
        history: { key: line.historyKey, limit: ROOM_HISTORY_LIMIT, historyMap: line.historyMap },
      }),
      resolveTurn: () => {
        throw new Error('a recorded room line never resolves a turn');
      },
    },
  });
}

export function omittedLine(n: number): string {
  return n === 1 ? '1 message from unlisted occupants omitted' : `${n} messages from unlisted occupants omitted`;
}

export function setRoomBrain(accountId: string, brain: RoomBrain | null): void {
  if (brain) brains.set(accountId, brain);
  else brains.delete(accountId);
}

export function roomSink(accountId: string): RoomSink {
  const live = (): RoomSink => {
    const sink = sinks.get(accountId);
    if (!sink) throw new Error(`rooms are not attached for ${accountId}`);
    return sink;
  };
  return {
    wake: async (turn) => live().wake(turn),
    record: (ev) => live().record(ev),
    count: (ev) => live().count(ev),
  };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function nextMessageId(key: string, from: string): string {
  messageSeq += 1;
  return `${key}:${from}:${messageSeq}`;
}

function enqueue(rt: AccountRuntime, deps: RoomDeps, key: string, job: () => Promise<void>): void {
  const ext = roomsExt(rt);
  const tail = (ext.tails.get(key) ?? Promise.resolve()).then(job).catch((err: unknown) => {
    deps.log.error('room line failed', { room: key, error: errText(err) });
  });
  ext.tails.set(key, tail);
}

async function recordLine(rt: AccountRuntime, deps: RoomDeps, ev: RoomMessageEvent, counted: boolean): Promise<void> {
  const key = roomKey(ev.room);
  const state = rt.rooms.get(key);
  if (!state) return;
  const policy = deps.policy();
  const from = normalizeName(ev.from);
  const role = roleOf(from, policy);
  const everyone = policy.room?.historyFrom === 'all';
  if ((counted || role === 'unlisted') && !everyone) {
    state.omittedCount += 1;
    return;
  }
  const now = deps.now();
  await deps.record({
    accountId: rt.accountId,
    historyKey: key,
    historyMap: roomsExt(rt).history,
    messageId: nextMessageId(key, from),
    timestamp: now,
    senderLabel: senderLabel(from, role),
    text: ev.text,
  });
  if (role !== 'unlisted') pushRecentLine(rt, key, { from, role, text: ev.text, at: now });
}

function roomContext(state: RoomState, policy: RootPolicy, self: string, omitted: number): UntrustedEntry {
  const occupants = [...state.occupants]
    .filter((name) => name !== self)
    .sort()
    .map((name) => ({ name: escapeNonAscii(name), role: roleOf(name, policy) }));
  const payload: Record<string, unknown> = { room: roomKey(state.ref), occupants };
  if (omitted > 0) payload.omitted = omittedLine(omitted);
  return { label: 'Room', source: 'oscar', type: 'room', payload };
}

async function wakeTurn(rt: AccountRuntime, deps: RoomDeps, turn: RoomTurn): Promise<void> {
  const key = roomKey(turn.room);
  const ext = roomsExt(rt);
  await (ext.tails.get(key) ?? Promise.resolve());
  const state = rt.rooms.get(key);
  if (!state || !ext.joined.has(key)) throw new Error(`not in ${key}`);
  const policy = deps.policy();
  const now = deps.now();
  const self = normalizeName(deps.self());
  const sender = normalizeName(turn.sender);
  const role = roleOf(sender, policy);
  if (role === 'unlisted') throw new Error('unlisted senders never wake a run');
  const history = ext.history.get(key) ?? [];
  ext.history.set(key, []);
  const omitted = state.omittedCount;
  state.omittedCount = 0;
  const peer: PeerRef = { kind: 'room', bot: self, room: turn.room };
  const operatorPrompt = policy.rooms[normalizeRoom(turn.room.name)]?.systemPrompt?.trim() ?? '';
  const request: TurnRequest = {
    accountId: rt.accountId,
    peer,
    origin: turn.origin,
    sender: { name: sender, display: sender, role },
    messageId: nextMessageId(key, sender),
    timestamp: now,
    text: role === 'owner' ? turn.body : neutralizeDirectives(turn.body),
    commandAuthorized: turn.commandAuthorized && role === 'owner',
    untrustedContext: [
      roomContext(state, policy, self, omitted),
      ...(turn.untrusted ?? []),
      ...awarenessFor(rt, policy, peer, turn.origin, now, deps.contacts()),
    ],
    group: {
      label: turn.room.name,
      systemPrompt: operatorPrompt === '' ? turn.systemPrompt : `${turn.systemPrompt}\n\n${operatorPrompt}`,
      history: history.slice(-ROOM_HISTORY_LIMIT),
    },
  };
  if (turn.botLoopProtection) request.botLoopProtection = turn.botLoopProtection;
  pushRecentLine(rt, key, { from: sender, role, text: turn.body, at: now });
  try {
    await deps.runTurn(request);
  } catch (err) {
    ext.history.set(key, [...history, ...(ext.history.get(key) ?? [])].slice(-ROOM_HISTORY_LIMIT));
    state.omittedCount += omitted;
    throw err;
  }
}

function createSink(rt: AccountRuntime, deps: RoomDeps): RoomSink {
  return {
    wake: (turn) => wakeTurn(rt, deps, turn),
    record: (ev) => enqueue(rt, deps, roomKey(ev.room), () => recordLine(rt, deps, ev, false)),
    count: (ev) => enqueue(rt, deps, roomKey(ev.room), () => recordLine(rt, deps, ev, true)),
  };
}

function createSoloBrain(rt: AccountRuntime, deps: RoomDeps, sink: RoomSink): RoomBrain {
  return {
    onRoomMessage(ev) {
      const key = roomKey(ev.room);
      const state = rt.rooms.get(key);
      if (!state) return;
      const decision = soloRoute({
        self: deps.self(),
        policy: deps.policy(),
        room: state,
        message: { from: ev.from, text: ev.text, whisper: ev.whisper },
      });
      if (decision.kind === 'ignore') return;
      if (decision.kind === 'count') return sink.count(ev);
      if (decision.kind === 'record') return sink.record(ev);
      sink
        .wake({
          room: ev.room,
          sender: ev.from,
          originator: ev.from,
          origin: decision.origin,
          why: decision.why,
          body: ev.text,
          systemPrompt: soloPrompt(deps.self()),
          commandAuthorized: decision.origin === 'owner',
          cookie: ev.cookie,
        })
        .catch((err: unknown) => {
          deps.log.error('room wake failed', { room: key, error: errText(err) });
        });
    },
  };
}

export function registerRooms(rt: AccountRuntime, deps: RoomDeps): void {
  const sink = createSink(rt, deps);
  sinks.set(rt.accountId, sink);
  solos.set(rt.accountId, createSoloBrain(rt, deps, sink));
}

export function unregisterRooms(accountId: string): void {
  sinks.delete(accountId);
  solos.delete(accountId);
}

function duplicate(rt: AccountRuntime, key: string, from: string, cookie: bigint, now: number): boolean {
  // TOC clients send cookie 0 on every room message, so 0 identifies nothing.
  if (cookie === 0n) return false;
  const seen = roomsExt(rt).seen;
  for (const [id, at] of seen) {
    if (now - at > DEDUPE_MS) seen.delete(id);
  }
  const id = `${key}|${from}|${cookie.toString(16)}`;
  if (seen.has(id)) return true;
  seen.set(id, now);
  return false;
}

export function onRoomMessage(rt: AccountRuntime, deps: RoomDeps, ev: RoomMessageEvent): void {
  const key = roomKey(ev.room);
  const state = rt.rooms.get(key);
  if (!state || !roomsExt(rt).joined.has(key)) return;
  const now = deps.now();
  const from = normalizeName(ev.from);
  const self = normalizeName(deps.self());
  if (from === self) {
    if (!ev.whisper) state.lastBotLine = { from: self, at: now };
    return;
  }
  // The server posts //roll results under this name with no user behind it.
  if (from === ONLINE_HOST) return;
  if (duplicate(rt, key, from, ev.cookie, now)) return;
  if (!ev.whisper && roleOf(from, deps.policy()) === 'bot') state.lastBotLine = { from, at: now };
  touchActivity(rt, key, now);
  const brain = brains.get(rt.accountId) ?? solos.get(rt.accountId);
  brain?.onRoomMessage({ ...ev, from });
}
