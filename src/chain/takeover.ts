import type { RoomRef } from '../names.js';
import { realTimers, roomKeyOf } from './types.js';
import type { Clock, TimerHandle, Timers } from './types.js';

const TOOK = /^#oc took (\S{1,80})$/;
const TOOK_MEMORY_MS = 60_000;

export function tookLine(key: string): string {
  return `#oc took ${key}`;
}

export function parseTook(text: string): string | null {
  return TOOK.exec(text)?.[1] ?? null;
}

export type TakeoverDeps = {
  takeoverMs(): number;
  whisper(room: RoomRef, to: string, line: string): void;
  timers?: Timers;
  now?: Clock;
};

type Known = { roomKey: string; order: string[]; position: number; timer: TimerHandle | null; relayed: boolean; at: number };

export class Takeover {
  private readonly timers: Timers;
  private readonly now: Clock;
  private readonly known = new Map<string, Known>();
  private readonly tooks = new Map<string, number>();

  constructor(private readonly deps: TakeoverDeps) {
    this.timers = deps.timers ?? realTimers;
    this.now = deps.now ?? (() => Date.now());
  }

  claimed(room: RoomRef, key: string, order: string[]): void {
    const next = order[1];
    if (next) this.deps.whisper(room, next, tookLine(key));
  }

  standby(room: RoomRef, key: string, order: string[], position: number, onTake: () => void): void {
    const id = `${roomKeyOf(room)}|${key}`;
    this.prune();
    if (this.known.has(id)) return;
    const entry: Known = { roomKey: roomKeyOf(room), order, position, timer: null, relayed: false, at: this.now() };
    this.known.set(id, entry);
    if (this.tooks.has(id)) {
      this.relay(room, key, entry);
      return;
    }
    entry.timer = this.timers.setTimeout(() => {
      entry.timer = null;
      entry.relayed = true;
      onTake();
    }, position * this.deps.takeoverMs());
  }

  onTook(room: RoomRef, key: string): void {
    const id = `${roomKeyOf(room)}|${key}`;
    this.tooks.set(id, this.now());
    const entry = this.known.get(id);
    if (!entry) return;
    this.cancel(entry);
    this.relay(room, key, entry);
  }

  onPublicLine(room: RoomRef, from: string): void {
    const roomKey = roomKeyOf(room);
    for (const entry of this.known.values()) {
      if (entry.roomKey !== roomKey || entry.timer === null) continue;
      const idx = entry.order.indexOf(from);
      if (idx >= 0 && idx < entry.position) this.cancel(entry);
    }
  }

  pending(): number {
    let n = 0;
    for (const entry of this.known.values()) if (entry.timer !== null) n += 1;
    return n;
  }

  clear(): void {
    for (const entry of this.known.values()) this.cancel(entry);
    this.known.clear();
    this.tooks.clear();
  }

  private cancel(entry: Known): void {
    if (entry.timer !== null) this.timers.clearTimeout(entry.timer);
    entry.timer = null;
  }

  // A public line can stand a candidate down before the took reaches it; the candidates
  // after it may have seen that line ahead of the command, so the took still has to travel on.
  private relay(room: RoomRef, key: string, entry: Known): void {
    if (entry.relayed) return;
    entry.relayed = true;
    const next = entry.order[entry.position + 1];
    if (next) this.deps.whisper(room, next, tookLine(key));
  }

  private prune(): void {
    const cutoff = this.now() - TOOK_MEMORY_MS;
    for (const [id, at] of this.tooks) if (at < cutoff) this.tooks.delete(id);
    for (const [id, entry] of this.known) if (entry.timer === null && entry.at < cutoff) this.known.delete(id);
  }
}
