import type { RoomProfile, RootPolicy } from '../config.js';
import { copy } from '../copy.js';
import { normalizeName, normalizeRoom, type RoomRef } from '../names.js';
import type { ImEvent, Logger, RoomMessageEvent } from '../oscar/index.js';
import { roleOf } from '../policy.js';
import { roomKey, type RoomState } from '../runtime.js';
import { parseSetupReply } from './grammar.js';
import { effectiveProfile, profileStore } from './profiles.js';

export const HOLD_MAX = 20;

export type RoomGate = { onRoomLine(ev: RoomMessageEvent): 'pass' | 'consumed' };

export type RoomSetupDeps = {
  accountId: string;
  self: () => string;
  policy: () => RootPolicy;
  now: () => number;
  log: Logger;
  rooms: () => Map<string, RoomState>;
  invitedBy: (roomKey: string) => string | undefined;
  ask: (owner: string, text: string) => Promise<void>;
  record: (ev: RoomMessageEvent) => void;
  replay: (ev: RoomMessageEvent) => void;
  leave: (ref: RoomRef) => Promise<void>;
};

type Waiting = { ref: RoomRef; held: RoomMessageEvent[]; reminded: boolean };

export class RoomSetup implements RoomGate {
  private readonly pending = new Map<string, Waiting>();
  private readonly settled = new Set<string>();

  constructor(private readonly deps: RoomSetupDeps) {}

  onRoomReady(ref: RoomRef): void {
    const key = roomKey(ref);
    if (this.pending.has(key) || this.settled.has(key)) return;
    const policy = this.deps.policy();
    const eff = effectiveProfile(this.deps.accountId, policy, ref);
    if (eff.source === 'config') return;
    this.pending.set(key, { ref, held: [], reminded: false });
    const inviter = this.deps.invitedBy(key);
    const by = inviter !== undefined && roleOf(inviter, policy) === 'owner' ? normalizeName(inviter) : undefined;
    const text = eff.source === 'stored'
      ? copy.setupAskBack(ref.name, copy.profileSummary(eff.profile, false))
      : copy.setupAskNew(ref.name, policy.teammates, inviter);
    const self = normalizeName(this.deps.self());
    for (const owner of by ? [by] : policy.owners.filter((o) => o !== self)) this.send(owner, text);
  }

  onRoomLine(ev: RoomMessageEvent): 'pass' | 'consumed' {
    const waiting = this.pending.get(roomKey(ev.room));
    if (!waiting) return 'pass';
    if (roleOf(ev.from, this.deps.policy()) !== 'owner') {
      this.deps.record(ev);
      return 'consumed';
    }
    waiting.held.push(ev);
    if (waiting.held.length > HOLD_MAX) waiting.held.shift();
    if (!waiting.reminded) {
      waiting.reminded = true;
      this.send(normalizeName(ev.from), copy.setupReminder(waiting.ref.name));
    }
    return 'consumed';
  }

  onIm(ev: ImEvent): 'handled' | 'pass' {
    const policy = this.deps.policy();
    const from = normalizeName(ev.from);
    if (roleOf(from, policy) !== 'owner') return 'pass';
    const joined = [...this.deps.rooms().values()];
    const reply = parseSetupReply(ev.text, { rooms: joined.map((r) => r.ref.name), pending: this.pending.size, teammates: policy.teammates });
    if (reply.kind === 'not-setup') return 'pass';
    if (reply.kind === 'error') return this.answer(from, copy.setupNotUnderstood(reply.word));

    let ref: RoomRef | undefined;
    if (reply.room !== undefined) {
      ref = joined.find((r) => normalizeRoom(r.ref.name) === reply.room)?.ref;
    } else {
      const waiting = [...this.pending.values()];
      if (waiting.length > 1) return this.answer(from, copy.setupWhichRoom(waiting[0]!.ref.name));
      ref = waiting[0]?.ref;
    }
    if (!ref) return 'handled';
    const key = roomKey(ref);

    if (reply.kind === 'leave') {
      this.pending.delete(key);
      this.settled.delete(key);
      this.send(from, copy.setupLeaving(ref.name));
      this.deps.leave(ref).catch((err: unknown) => {
        this.deps.log.warn('room leave failed', { room: key, error: err instanceof Error ? err.message : String(err) });
      });
      return 'handled';
    }

    const eff = effectiveProfile(this.deps.accountId, policy, ref);
    if (eff.source === 'config') return this.answer(from, copy.setupConfigRoom(ref.name));
    const existing = eff.source === 'stored' ? eff.profile : undefined;
    let profile: RoomProfile;
    if (reply.kind === 'same') {
      if (!existing) return this.answer(from, copy.setupNotUnderstood('same'));
      profile = existing;
    } else if (reply.mode === undefined) {
      if (!existing || !reply.trust) return this.answer(from, copy.setupNotUnderstood(reply.trust ?? ''));
      profile = { ...existing, trust: reply.trust };
    } else {
      if (reply.rank && !reply.rank.includes(normalizeName(this.deps.self()))) {
        return this.answer(from, copy.setupNotUnderstood(reply.rank.join(' ')));
      }
      profile = { mode: reply.mode, trust: reply.trust ?? existing?.trust ?? 'public', ...(reply.rank ? { rank: reply.rank } : {}) };
    }

    const store = profileStore(this.deps.accountId);
    if (!store) {
      this.deps.log.warn('room profile not saved: no store', { room: key });
      return 'handled';
    }
    store.setProfile(key, profile);
    this.send(from, copy.setupApplied(ref.name, copy.profileSummary(profile, true)));
    const waiting = this.pending.get(key);
    this.pending.delete(key);
    this.settled.add(key);
    for (const line of waiting?.held ?? []) this.deps.replay(line);
    return 'handled';
  }

  forget(roomKey: string): void {
    this.pending.delete(roomKey);
    this.settled.delete(roomKey);
  }

  pendingCount(): number {
    return this.pending.size;
  }

  private answer(owner: string, text: string): 'handled' {
    this.send(owner, text);
    return 'handled';
  }

  private send(owner: string, text: string): void {
    this.deps.ask(owner, text).catch((err: unknown) => {
      this.deps.log.warn('setup IM was not delivered', { owner, error: err instanceof Error ? err.message : String(err) });
    });
  }
}
