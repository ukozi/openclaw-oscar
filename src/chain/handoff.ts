import { randomInt } from 'node:crypto';
import { neutralizeDirectives } from '../policy.js';
import type { RoomRef } from '../names.js';
import { realTimers, roomKeyOf } from './types.js';
import type { Clock, TimerHandle, Timers } from './types.js';

export type Trailer = { id: string; hop: number; originator: string };

const ID = '\\d{1,2}-[a-z2-7]{4}';
const FULL = new RegExp(`\\s*\\[d:(${ID}) h:(\\d{1,2}) o:([a-z0-9]{1,32})\\]\\s*$`);
const RESULT = new RegExp(`\\s*\\[d:(${ID})\\]`);
const ANY = /[ \t]*\[d:[^\]\n]{0,80}\]/g;
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

export function formatTrailer(t: Trailer): string {
  return `[d:${t.id} h:${t.hop} o:${t.originator}]`;
}

export function parseTrailer(text: string): { body: string; trailer: Trailer | null; resultId: string | null } {
  const full = FULL.exec(text);
  if (full) {
    const trailer = { id: full[1] ?? '', hop: Number(full[2]), originator: full[3] ?? '' };
    return { body: text.slice(0, full.index).trimEnd(), trailer, resultId: null };
  }
  if (/\[d:[^\]]*\sh:/.test(text)) return { body: text, trailer: null, resultId: null };
  const result = RESULT.exec(text);
  if (result) {
    const body = (text.slice(0, result.index) + text.slice(result.index + result[0].length)).trim();
    return { body, trailer: null, resultId: result[1] ?? null };
  }
  return { body: text, trailer: null, resultId: null };
}

export function stripTrailers(text: string): string {
  return text
    .replace(ANY, '')
    .split('\n')
    .map((line) => line.replace(/[ \t]{2,}/g, ' ').trimEnd())
    .join('\n')
    .trim();
}

export function mintId(rank: number): string {
  let tail = '';
  for (let i = 0; i < 4; i++) tail += BASE32[randomInt(32)] ?? 'a';
  return `${rank}-${tail}`;
}

export function sanitizeTask(task: string): string {
  return neutralizeDirectives(stripTrailers(task).replace(/\s*\n+\s*/g, ' ').trim());
}

export function handoffLine(to: string, task: string, trailer: Trailer): string {
  return `${to}: ${task} ${formatTrailer(trailer)}`;
}

export function taskOf(body: string): string {
  const m = /^[^:\n]{1,60}:\s*/.exec(body);
  return m ? body.slice(m[0].length).trim() : body.trim();
}

export function frameTask(delegator: string, originator: string, task: string): string {
  return `${delegator} handed you this job for ${originator}: ${sanitizeTask(task)}`;
}

export type OpenHandoff = { id: string; to: string; room: RoomRef; originator: string; hop: number; createdAt: number };
export type LedgerDeps = { timeoutMs(): number; onExpire(h: OpenHandoff): void; timers?: Timers; now?: Clock };

const MAX_SEEN = 500;

export class HandoffLedger {
  private readonly timers: Timers;
  private readonly now: Clock;
  private readonly entries = new Map<string, { h: OpenHandoff; timer: TimerHandle }>();
  private readonly seen = new Set<string>();

  constructor(private readonly deps: LedgerDeps) {
    this.timers = deps.timers ?? realTimers;
    this.now = deps.now ?? (() => Date.now());
  }

  open(input: Omit<OpenHandoff, 'createdAt'>): OpenHandoff {
    const h: OpenHandoff = { ...input, createdAt: this.now() };
    const timer = this.timers.setTimeout(() => {
      if (!this.entries.delete(h.id)) return;
      this.deps.onExpire(h);
    }, this.deps.timeoutMs());
    this.entries.set(h.id, { h, timer });
    return h;
  }

  close(id: string, from: string): OpenHandoff | null {
    const entry = this.entries.get(id);
    if (!entry || entry.h.to !== from) return null;
    this.timers.clearTimeout(entry.timer);
    this.entries.delete(id);
    return entry.h;
  }

  targetLeft(room: RoomRef, name: string): OpenHandoff[] {
    const roomKey = roomKeyOf(room);
    const out: OpenHandoff[] = [];
    for (const [id, entry] of this.entries) {
      if (entry.h.to !== name || roomKeyOf(entry.h.room) !== roomKey) continue;
      this.timers.clearTimeout(entry.timer);
      this.entries.delete(id);
      out.push(entry.h);
    }
    return out;
  }

  openKeys(room: RoomRef): Set<string> {
    const roomKey = roomKeyOf(room);
    const keys = new Set<string>();
    for (const { h } of this.entries.values()) if (roomKeyOf(h.room) === roomKey) keys.add(`${h.to}:${h.id}`);
    return keys;
  }

  list(): OpenHandoff[] {
    return [...this.entries.values()].map((e) => e.h);
  }

  markSeen(delegator: string, id: string): void {
    this.seen.add(`${delegator}:${id}`);
    while (this.seen.size > MAX_SEEN) {
      const oldest = this.seen.values().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
  }

  seenKeys(): Set<string> {
    return this.seen;
  }

  clear(): void {
    for (const entry of this.entries.values()) this.timers.clearTimeout(entry.timer);
    this.entries.clear();
    this.seen.clear();
  }
}
