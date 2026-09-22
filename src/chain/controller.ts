import type { RootPolicy } from '../config.js';
import { copy } from '../copy.js';
import { normalizeName } from '../names.js';
import type { RoomRef } from '../names.js';
import { guardRoll, toAsciiEntities, toWireHtml } from '../oscar/text.js';
import type { ImEvent, Logger, RateEvent, RoomMessageEvent, RoomRosterEvent, SendPriority, SendReceipt } from '../oscar/types.js';
import { neutralizeDirectives, roleOf } from '../policy.js';
import type { OriginClass, TurnOrigin } from '../policy.js';
import type { RunChange, RunInfo, RunTerminal } from '../presence/runs.js';
import type { RoomState } from '../runtime.js';
import { AckTimers } from './ack.js';
import { RoomLoopGuard, botLoopFacts } from './guards.js';
import { HandoffLedger, JobBoard, addressedLine, frameTask, handoffLine, mintId, sanitizeTask, stripTrailers } from './handoff.js';
import type { OpenHandoff, Trailer } from './handoff.js';
import { HelloExchange } from './hello.js';
import { HoldQueue, mustHold } from './holds.js';
import { TEAM_FACT_NOTE, promptVariant, roomSystemPrompt } from './prompts.js';
import { candidateOrder, noteRoomLine, rosterNames, route } from './route.js';
import type { Asked } from './route.js';
import { Takeover, parseTook } from './takeover.js';
import { realTimers, roomKeyOf } from './types.js';
import type { Clock, OutboundMeta, RoomSink, RoomTurn, Timers, UntrustedFact, WakeWhy } from './types.js';

export type ChainTracker = {
  activeRun(sessionKey: string): RunInfo | null;
  onIdle(sessionKey: string, fn: (last: RunTerminal) => void): () => void;
  onRun(fn: (change: RunChange) => void): () => void;
};

export type TeammatePresence = { name: string; online: boolean; away: boolean };

export type ChainDeps = {
  accountId: string;
  self(): string;
  policy(): RootPolicy;
  ownerWildcard(): boolean;
  roomChunkLimit(): number;
  room(roomKey: string): RoomState | undefined;
  sessionKeyFor(roomKey: string): string | undefined;
  roomKeyForSession(sessionKey: string): string | undefined;
  tracker: ChainTracker;
  sink: RoomSink;
  say(room: RoomRef, markdown: string, opts?: { whisperTo?: string; priority?: SendPriority }): Promise<SendReceipt>;
  sendIm(to: string, line: string): void;
  rosterPresence?: () => TeammatePresence[];
  log: Logger;
  timers?: Timers;
  now?: Clock;
};

export type ChainFacts = {
  mismatches: { peer: string; theirs: string; mine: string }[];
  claims: string[];
  lastRefusal: { at: number; to: string; reason: string } | null;
  open: OpenHandoff[];
};

export type TurnRecord = {
  origin: OriginClass;
  originator: string;
  holdClass: string;
  hop: number;
  delegated?: { delegator: string; id: string; stamped: boolean };
  failed: boolean;
};

type Pending = { turn: RoomTurn; key: string; rec: TurnRecord; ev?: RoomMessageEvent };

type WakeSpec = {
  why: WakeWhy;
  origin: OriginClass;
  key: string;
  handoff?: { delegator: string; trailer: Trailer; task: string };
  closed?: OpenHandoff | null;
  resultId?: string;
};

const HASH_CHECK_MS = 5000;
const ROOM_LIMITED_MS = 120_000;
const ROUTED: WakeWhy[] = ['lead', 'floor', 'invited', 'takeover'];

export function resolveBot(raw: string, policy: RootPolicy): string | null {
  const wanted = normalizeName(raw);
  if (!wanted) return null;
  for (const entry of policy.chain.roster) {
    const name = normalizeName(entry.screenName);
    if (name === wanted) return name;
    if ((entry.aliases ?? []).some((alias) => normalizeName(alias) === wanted)) return name;
  }
  return null;
}

// What sendRoomLine puts on the wire, byte for byte: markup grows on the way out, so a link of
// thirteen characters leaves as twenty four and a raw count would wave through a line that the
// room then has to split.
export function wireLength(markdown: string): number {
  return guardRoll(toAsciiEntities(toWireHtml(markdown))).length;
}

const HANDOFF_SEND_MS = 20_000;
const WIRE_BREAK = /<br\s*\/?>/i;

function plainOfWire(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&#(\d{1,7});/g, (_m, n: string) => (Number(n) <= 0x10ffff ? String.fromCodePoint(Number(n)) : ''))
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&');
}

export class ChainController {
  readonly hello: HelloExchange;
  readonly ledger: HandoffLedger;
  readonly board: JobBoard;
  private readonly ack: AckTimers;
  private readonly turns = new Map<string, TurnRecord>();
  private readonly asked = new Map<string, Asked>();
  private lastRefusal: ChainFacts['lastRefusal'] = null;
  private readonly now: Clock;
  private readonly takeover: Takeover;
  private readonly holds = new HoldQueue<Pending>();
  private readonly guard = new RoomLoopGuard();
  private readonly inflight = new Map<string, number>();
  private readonly idleUnsub = new Map<string, () => void>();
  private readonly unsubRun: () => void;
  private readonly announced = new Set<string>();
  private readonly limitedUntil = new Map<string, number>();
  private readonly timers: Timers;
  private lastHashCheck = 0;

  constructor(private readonly deps: ChainDeps) {
    const timers = deps.timers ?? realTimers;
    this.timers = timers;
    this.now = deps.now ?? (() => Date.now());
    this.unsubRun = deps.tracker.onRun((change) => {
      if (change.kind !== 'start') return;
      const roomKey = deps.roomKeyForSession(change.run.sessionKey);
      if (roomKey) this.watchIdle(roomKey);
    });
    this.takeover = new Takeover({
      takeoverMs: () => deps.policy().chain.takeoverMs,
      whisper: (room, to, text) => {
        deps.say(room, text, { whisperTo: to, priority: 'control' }).catch((err: unknown) => {
          deps.log.debug('chain took whisper failed', { to, error: String(err) });
        });
      },
      timers,
      now: this.now,
    });
    this.ack = new AckTimers({
      ackAfterMs: () => deps.policy().chain.ackAfterMs,
      isActive: (roomKey) => this.activeClass(roomKey) !== null,
      post: (roomKey, kind) => {
        const room = deps.room(roomKey);
        if (!room) return;
        const chain = deps.policy().chain;
        void this.post(room, kind === 'busy' ? copy.busy(chain.busyText) : copy.ack(chain.ackText));
      },
      timers,
      now: this.now,
    });
    this.ledger = new HandoffLedger({
      timeoutMs: () => deps.policy().chain.resultTimeoutMinutes * 60_000,
      onExpire: (h) => this.reviewWake(h, copy.noteTimeout(h.to, h.id, deps.policy().chain.resultTimeoutMinutes)),
      timers,
      now: this.now,
    });
    this.board = new JobBoard({
      maxAgeMs: () => deps.policy().chain.resultTimeoutMinutes * 60_000,
      resolve: (name) => resolveBot(name, deps.policy()),
      now: this.now,
    });
    this.hello = new HelloExchange({ self: deps.self, policy: deps.policy, send: deps.sendIm, now: this.now });
  }

  onRoomMessage(ev: RoomMessageEvent): void {
    const roomKey = roomKeyOf(ev.room);
    const room = this.deps.room(roomKey);
    if (!room) return;
    const policy = this.deps.policy();
    const self = this.deps.self();
    const now = this.now();
    this.checkHash(now);

    const fromBot = ev.from !== self && rosterNames(policy).includes(ev.from);
    if (fromBot && ev.whisper) {
      const key = parseTook(ev.text);
      if (key) this.takeover.onTook(ev.room, key);
      if (key || ev.text.startsWith('#oc ')) return;
    }
    if (fromBot && !ev.whisper) {
      room.lastBotLine = { from: ev.from, at: now };
      this.takeover.onPublicLine(ev.room, ev.from);
    }

    const mismatched = this.hello.mismatchedIn(room.occupants);
    const result = route({
      self, now, policy, room, rosterMismatch: mismatched.length > 0, message: ev,
      asked: this.askedIn(roomKey),
      openHandoffIds: this.ledger.openKeys(ev.room), seenHandoffs: this.ledger.seenKeys(),
    });
    if (mismatched.length > 0) this.announceMismatch(room, mismatched, now);
    if (!ev.whisper) {
      const seen = { from: ev.from, text: ev.text, at: now };
      noteRoomLine(this.askedIn(roomKey), seen, policy);
      this.board.note(ev.room, seen);
    }

    switch (result.kind) {
      case 'ignore':
        return;
      case 'count':
        this.deps.sink.count(ev);
        return;
      case 'record':
        if (result.result?.known) this.ledger.close(result.result.id, ev.from);
        this.deps.sink.record(ev);
        return;
      case 'standby': {
        this.deps.sink.record(ev);
        const { key, order, position } = result;
        this.takeover.standby(ev.room, key, order, position, () => this.takeOver(ev, key, order, position));
        return;
      }
      case 'wake': {
        if (result.why === 'handoff' && this.deps.ownerWildcard()) {
          this.deps.sink.record(ev);
          return;
        }
        if (result.origin === 'bot' && !this.guard.allow(this.deps.accountId, roomKey, self, now)) {
          this.deps.log.warn('chain room guard suppressed a bot wake', { room: roomKey, from: ev.from });
          this.deps.sink.record(ev);
          return;
        }
        if (result.handoff) this.ledger.markSeen(ev.from, result.handoff.trailer.id);
        const closed = result.result?.known ? this.ledger.close(result.result.id, ev.from) : null;
        if (result.order) this.takeover.claimed(ev.room, result.key, result.order);
        this.dispatchOrHold(this.pendingFor(ev, {
          why: result.why, origin: result.origin, key: result.key, handoff: result.handoff, closed, resultId: result.result?.id,
        }));
        return;
      }
    }
  }

  onRoomReady(_room: RoomRef, occupants: string[]): void {
    this.hello.onRoomJoined(occupants);
  }

  onRoomJoin(ev: RoomRosterEvent): void {
    this.hello.onPeerSeen(ev.name);
  }

  onRoomLeave(ev: RoomRosterEvent): void {
    this.board.holderLeft(ev.room, ev.name);
    for (const h of this.ledger.targetLeft(ev.room, ev.name)) this.reviewWake(h, copy.noteLeft(h.to, h.id));
  }

  onPresence(name: string, online: boolean): void {
    if (online) this.hello.onPeerSeen(name);
  }

  onRate(ev: RateEvent): void {
    if (ev.scope === 'bos') return;
    const roomKey = roomKeyOf(ev.scope);
    if (ev.status === 'limited') this.limitedUntil.set(roomKey, this.now() + ROOM_LIMITED_MS);
    else if (ev.status === 'clear') this.limitedUntil.delete(roomKey);
  }

  roomLimited(roomKey: string): boolean {
    return (this.limitedUntil.get(roomKey) ?? 0) > this.now();
  }

  onIm(ev: ImEvent): 'handled' | 'pass' {
    this.checkHash(this.now());
    return this.hello.onIm(ev.from, ev.text);
  }

  toolStarted(sessionKey: string): void {
    const roomKey = this.deps.roomKeyForSession(sessionKey);
    if (!roomKey) return;
    this.ack.toolStarted(roomKey);
    this.watchIdle(roomKey);
  }

  standbys(): number {
    return this.takeover.pending();
  }

  turnOrigin(roomKey: string): TurnOrigin | null {
    const rec = this.turns.get(roomKey);
    if (!rec) return null;
    return rec.delegated ? { originator: rec.originator, delegator: rec.delegated.delegator } : { originator: rec.originator };
  }

  async filterOutbound(meta: OutboundMeta, body: string): Promise<string | null> {
    if (meta.kind === 'plugin') return body;
    const wire = meta.format === 'wire';
    let text = stripTrailers(body);
    if (meta.target.kind !== 'room') return text === '' ? null : text;
    const roomKey = roomKeyOf(meta.target.room);
    const room = this.deps.room(roomKey);
    if (!room) return text === '' ? null : text;
    this.watchIdle(roomKey);
    const rec = this.turns.get(roomKey);
    if (rec) text = await this.stampHandoffLines(room, rec, text, wire);
    if ((wire ? plainOfWire(text) : text).trim() === '') return null;
    this.ack.output(roomKey);
    const d = rec?.delegated;
    let out = text;
    if (d && !d.stamped && meta.kind === 'final' && !wire) {
      const stamped = `${d.delegator}: ${text} [d:${d.id}]`;
      if (wireLength(stamped) <= this.deps.roomChunkLimit()) {
        d.stamped = true;
        out = stamped;
      }
    }
    this.noteOwnLine(room, wire ? plainOfWire(out) : out);
    return out;
  }

  async delegate(req: { roomKey: string | null; requester?: string; to: string; task: string }): Promise<string> {
    const room = req.roomKey ? this.deps.room(req.roomKey) : undefined;
    if (!room || !req.roomKey) throw new Error(copy.delegateError('not-in-room'));
    const rec: TurnRecord = this.turns.get(req.roomKey) ?? {
      origin: 'owner', originator: normalizeName(req.requester ?? ''), holdClass: '', hop: 0, failed: false,
    };
    const sent = await this.sendHandoff(room, rec, req.to, req.task);
    return copy.delegateSent(sent.to, sent.id);
  }

  facts(): ChainFacts {
    return {
      mismatches: this.hello.mismatches(),
      claims: this.hello.claims(),
      lastRefusal: this.lastRefusal,
      open: this.ledger.list(),
    };
  }

  stop(): void {
    this.takeover.clear();
    this.ack.clear();
    this.ledger.clear();
    this.board.clear();
    this.holds.clear();
    this.guard.clear();
    this.unsubRun();
    for (const unsub of this.idleUnsub.values()) unsub();
    this.idleUnsub.clear();
    this.turns.clear();
    this.asked.clear();
    this.inflight.clear();
    this.limitedUntil.clear();
  }

  private post(room: RoomState, text: string): Promise<void> {
    return this.deps.say(room.ref, text).then(
      () => this.noteOwnLine(room, text),
      (err: unknown) => this.deps.log.warn('chain line was not sent', { room: roomKeyOf(room.ref), error: String(err) }),
    );
  }

  private askedIn(roomKey: string): Asked {
    const asked = this.asked.get(roomKey) ?? new Map<string, number>();
    this.asked.set(roomKey, asked);
    return asked;
  }

  private noteOwnLine(room: RoomState, text: string): void {
    const now = this.now();
    const seen = { from: this.deps.self(), text, at: now };
    room.lastBotLine = { from: seen.from, at: now };
    noteRoomLine(this.askedIn(roomKeyOf(room.ref)), seen, this.deps.policy());
    this.board.note(room.ref, seen);
  }

  private watchIdle(roomKey: string): void {
    if (this.idleUnsub.has(roomKey)) return;
    const sessionKey = this.deps.sessionKeyFor(roomKey);
    if (!sessionKey) return;
    const unsub = this.deps.tracker.onIdle(sessionKey, (last) => {
      this.idleUnsub.delete(roomKey);
      if (this.deps.tracker.activeRun(sessionKey)) {
        this.watchIdle(roomKey);
        return;
      }
      const rec = this.turns.get(roomKey);
      if (rec && last === 'error') rec.failed = true;
      if ((this.inflight.get(roomKey) ?? 0) === 0) this.finish(roomKey);
    });
    this.idleUnsub.set(roomKey, unsub);
  }

  private checkHash(now: number): void {
    if (now - this.lastHashCheck < HASH_CHECK_MS) return;
    this.lastHashCheck = now;
    this.hello.checkHash();
  }

  private announceMismatch(room: RoomState, mismatched: string[], now: number): void {
    const self = this.deps.self();
    if (candidateOrder(self, now, this.deps.policy(), room, true, this.askedIn(roomKeyOf(room.ref)))[0] !== self) return;
    for (const peer of mismatched) {
      const tag = `${roomKeyOf(room.ref)}|${peer}|${this.hello.hashOf(peer) ?? ''}`;
      if (this.announced.has(tag)) continue;
      this.announced.add(tag);
      void this.post(room, copy.mismatch(self, peer));
    }
  }

  private takeOver(ev: RoomMessageEvent, key: string, order: string[], position: number): void {
    const room = this.deps.room(roomKeyOf(ev.room));
    if (!room) return;
    this.takeover.claimed(ev.room, key, order.slice(position));
    void this.post(room, copy.takeover(order[0] ?? ''));
    const origin: OriginClass = roleOf(ev.from, this.deps.policy()) === 'owner' ? 'owner' : 'approved';
    this.dispatchOrHold(this.pendingFor(ev, { why: 'takeover', origin, key }));
  }

  private reviewWake(h: OpenHandoff, note: string): void {
    const self = this.deps.self();
    const policy = this.deps.policy();
    const roomKey = roomKeyOf(h.room);
    const now = this.now();
    if (!this.guard.allow(this.deps.accountId, roomKey, self, now)) return;
    const turn: RoomTurn = {
      room: h.room, sender: h.to, originator: h.originator, origin: 'bot', why: 'review', body: note,
      systemPrompt: roomSystemPrompt({ self, policy, why: 'review' }),
      commandAuthorized: false, cookie: 0n,
      botLoopProtection: botLoopFacts(this.deps.accountId, roomKey, h.to, self, now),
    };
    const rec: TurnRecord = {
      origin: 'bot', originator: h.originator, holdClass: `bot:${h.to}:${roleOf(h.originator, policy)}`, hop: h.hop - 1, failed: false,
    };
    this.dispatchOrHold({ turn, key: `${h.to}:${h.id}:review`, rec });
  }

  private pendingFor(ev: RoomMessageEvent, w: WakeSpec): Pending {
    const policy = this.deps.policy();
    const self = this.deps.self();
    const roomKey = roomKeyOf(ev.room);
    let originator = ev.from;
    let hop = 0;
    let body = w.origin === 'owner' ? ev.text : neutralizeDirectives(ev.text);
    let delegated: TurnRecord['delegated'];
    let handoff: { delegator: string; originator: string } | undefined;
    if (w.handoff) {
      originator = w.handoff.trailer.originator;
      hop = w.handoff.trailer.hop;
      body = frameTask(w.handoff.delegator, originator, w.handoff.task);
      delegated = { delegator: w.handoff.delegator, id: w.handoff.trailer.id, stamped: false };
      handoff = { delegator: w.handoff.delegator, originator };
    } else if (w.why === 'review') {
      originator = w.closed?.originator ?? '';
      hop = w.closed ? w.closed.hop - 1 : 0;
      const note = w.closed ? copy.noteResult(ev.from, w.closed.id) : copy.noteLostLedger(w.resultId ?? '');
      body = `${note}\n${neutralizeDirectives(stripTrailers(ev.text))}`;
    }
    const turn: RoomTurn = {
      room: ev.room, sender: ev.from, originator, origin: w.origin, why: w.why, body,
      systemPrompt: roomSystemPrompt({ self, policy, why: w.why, handoff }),
      commandAuthorized: w.origin === 'owner', cookie: ev.cookie,
    };
    if (w.origin === 'bot') turn.botLoopProtection = botLoopFacts(this.deps.accountId, roomKey, ev.from, self, this.now());
    const room = this.deps.room(roomKey);
    const facts = room && promptVariant(w.why, policy) === 'chair' ? this.routingFacts(policy, room) : null;
    if (facts) turn.untrusted = [facts];
    const holdClass = w.origin === 'bot' ? `bot:${ev.from}:${roleOf(originator, policy)}` : w.origin;
    const rec: TurnRecord = { origin: w.origin, originator, holdClass, hop, failed: false };
    if (delegated) rec.delegated = delegated;
    return { turn, key: w.key, rec, ev };
  }

  private routingFacts(policy: RootPolicy, room: RoomState): UntrustedFact | null {
    const presence = this.deps.rosterPresence?.() ?? [];
    const now = this.now();
    const openJobs = this.board.openIn(room.ref, now).map((job) => ({
      id: job.id, to: job.to, by: job.by, for: job.originator, minutes: Math.floor((now - job.since) / 60_000),
    }));
    if (presence.length === 0 && openJobs.length === 0) return null;
    const roles = new Map(policy.chain.roster.map((entry) => [normalizeName(entry.screenName), entry.role] as const));
    const teammates = presence.map((p) => ({ name: p.name, role: roles.get(p.name) ?? '', online: p.online, busy: p.away }));
    const watchingMinutes = Math.max(0, Math.floor((now - room.selfJoinedAt) / 60_000));
    return {
      label: 'Team', source: 'oscar', type: 'oscar_chain_team',
      payload: { teammates, openJobs, watchingMinutes, note: TEAM_FACT_NOTE },
    };
  }

  private activeClass(roomKey: string): string | null {
    const sessionKey = this.deps.sessionKeyFor(roomKey);
    const run = sessionKey ? this.deps.tracker.activeRun(sessionKey) : null;
    if (!run && (this.inflight.get(roomKey) ?? 0) === 0) return null;
    return this.turns.get(roomKey)?.holdClass ?? run?.origin ?? 'unknown';
  }

  private dispatchOrHold(p: Pending): void {
    const roomKey = roomKeyOf(p.turn.room);
    const active = this.activeClass(roomKey);
    if (mustHold(active, p.rec.holdClass)) {
      if (this.holds.hold(roomKey, p.rec.holdClass, p)) {
        this.watchIdle(roomKey);
      } else {
        this.deps.log.warn('chain hold queue is full, line recorded only', { room: roomKey });
        if (p.ev) this.deps.sink.record(p.ev);
      }
      return;
    }
    this.dispatch(p, active !== null);
  }

  private dispatch(p: Pending, steering: boolean): void {
    const roomKey = roomKeyOf(p.turn.room);
    if (!this.turns.has(roomKey)) this.turns.set(roomKey, p.rec);
    this.ack.wakeStarted(roomKey, p.key, steering && ROUTED.includes(p.turn.why));
    this.inflight.set(roomKey, (this.inflight.get(roomKey) ?? 0) + 1);
    this.deps.sink.wake(p.turn)
      .catch((err: unknown) => {
        const rec = this.turns.get(roomKey);
        if (rec) rec.failed = true;
        this.deps.log.warn('chain wake failed', { room: roomKey, error: String(err) });
      })
      .finally(() => {
        this.inflight.set(roomKey, Math.max(0, (this.inflight.get(roomKey) ?? 1) - 1));
        if (this.activeClass(roomKey) !== null) {
          this.watchIdle(roomKey);
          return;
        }
        this.finish(roomKey);
      });
    this.watchIdle(roomKey);
  }

  private finish(roomKey: string): void {
    const rec = this.turns.get(roomKey);
    this.turns.delete(roomKey);
    this.idleUnsub.get(roomKey)?.();
    this.idleUnsub.delete(roomKey);
    const ackFacts = this.ack.runEnded(roomKey);
    const room = this.deps.room(roomKey);
    const d = rec?.delegated;
    if (rec && room && d && !d.stamped) {
      const outcome = rec.failed ? 'failed' : ackFacts.output ? 'done' : 'none';
      void this.post(room, copy.outcome(d.delegator, d.id, outcome));
    } else if (rec && room && !d && ackFacts.acked && !ackFacts.output) {
      void this.post(room, copy.closing());
    }
    const next = this.holds.next(roomKey);
    for (const p of next?.items ?? []) this.dispatchOrHold(p);
  }

  private async stampHandoffLines(room: RoomState, rec: TurnRecord, text: string, wire: boolean): Promise<string> {
    const keep: string[] = [];
    for (const textLine of wire ? text.split(WIRE_BREAK) : text.split('\n')) {
      const target = this.handoffTarget(wire ? plainOfWire(textLine) : textLine);
      if (!target) {
        keep.push(textLine);
        continue;
      }
      try {
        await this.sendHandoff(room, rec, target.to, target.task);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.lastRefusal = { at: this.now(), to: target.to, reason };
        this.deps.log.info('chain text hand-off refused', { to: target.to, reason });
        keep.push(textLine);
      }
    }
    return keep.join(wire ? '<BR>' : '\n');
  }

  private handoffTarget(textLine: string): { to: string; task: string } | null {
    const addressed = addressedLine(textLine);
    if (!addressed) return null;
    const policy = this.deps.policy();
    const to = resolveBot(addressed.to, policy);
    if (!to) return null;
    const roster = rosterNames(policy);
    const myIdx = roster.indexOf(this.deps.self());
    if (myIdx < 0 || roster.indexOf(to) <= myIdx) return null;
    return { to, task: addressed.task };
  }

  private async sendHandoff(room: RoomState, rec: TurnRecord, toRaw: string, taskRaw: string): Promise<{ id: string; to: string }> {
    const policy = this.deps.policy();
    const roster = rosterNames(policy);
    const myIdx = roster.indexOf(this.deps.self());
    if (this.deps.ownerWildcard()) throw new Error(copy.delegateError('wildcard'));
    const to = resolveBot(toRaw, policy);
    if (!to || myIdx < 0 || roster.indexOf(to) <= myIdx) throw new Error(copy.delegateError('not-below', to ?? normalizeName(toRaw)));
    if (!room.occupants.has(to)) throw new Error(copy.delegateError('absent', to));
    if (this.hello.mismatchedIn([to]).length > 0) throw new Error(copy.delegateError('mismatch', to));
    const hop = rec.hop + 1;
    if (hop > policy.chain.maxHops) throw new Error(copy.delegateError('hops'));
    const role = roleOf(rec.originator, policy);
    if (role !== 'owner' && role !== 'approved') throw new Error(copy.delegateError('lost-turn'));
    const task = sanitizeTask(taskRaw);
    if (!task) throw new Error(copy.delegateError('empty'));
    const id = mintId(myIdx + 1);
    const text = handoffLine(to, task, { id, hop, originator: rec.originator });
    if (wireLength(text) > this.deps.roomChunkLimit()) throw new Error(copy.delegateError('too-long'));
    if (this.roomLimited(roomKeyOf(room.ref))) throw new Error(copy.delegateError('rate'));
    let late = false;
    const sent = this.deps.say(room.ref, text).then(() => {
      this.ledger.open({ id, to, room: room.ref, originator: rec.originator, hop });
      if (late) this.deps.log.warn('chain hand-off went out after its deadline', { to, id });
    });
    try {
      await this.withDeadline(sent, HANDOFF_SEND_MS);
    } catch (err) {
      const code = (err as { code?: string }).code;
      late = code === 'deadline';
      if (late) sent.catch(() => undefined);
      this.deps.log.warn('chain hand-off was not sent', { to, code: code ?? 'unknown' });
      throw new Error(copy.delegateError(late || code === 'rate-limited' ? 'rate' : 'send-failed'));
    }
    this.ack.output(roomKeyOf(room.ref));
    this.noteOwnLine(room, text);
    return { id, to };
  }

  private withDeadline(work: Promise<void>, ms: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = this.timers.setTimeout(() => reject(Object.assign(new Error('deadline'), { code: 'deadline' })), ms);
      work.then(resolve, reject).finally(() => this.timers.clearTimeout(timer));
    });
  }
}
