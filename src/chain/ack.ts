import { realTimers } from './types.js';
import type { Clock, TimerHandle, Timers } from './types.js';

export type AckDeps = {
  ackAfterMs(): number;
  isActive(roomKey: string): boolean;
  post(roomKey: string, kind: 'ack' | 'busy'): void;
  timers?: Timers;
  now?: Clock;
};

type Pending = { key: string; busy: boolean; ripe: boolean; timer: TimerHandle | null };
type RoomAck = { pending: Pending[]; toolSeen: boolean; acked: boolean; output: boolean };

export class AckTimers {
  private readonly timers: Timers;
  private readonly rooms = new Map<string, RoomAck>();

  constructor(private readonly deps: AckDeps) {
    this.timers = deps.timers ?? realTimers;
  }

  wakeStarted(roomKey: string, key: string, busy: boolean): void {
    const st = this.rooms.get(roomKey) ?? { pending: [], toolSeen: false, acked: false, output: false };
    this.rooms.set(roomKey, st);
    const p: Pending = { key, busy, ripe: false, timer: null };
    p.timer = this.timers.setTimeout(() => this.ripen(roomKey, p), this.deps.ackAfterMs());
    st.pending.push(p);
  }

  toolStarted(roomKey: string): void {
    const st = this.rooms.get(roomKey);
    if (!st) return;
    st.toolSeen = true;
    const ripe = st.pending.find((p) => p.ripe);
    if (ripe) this.fire(roomKey, ripe);
  }

  output(roomKey: string): void {
    const st = this.rooms.get(roomKey);
    if (!st) return;
    this.cancel(st);
    st.output = true;
  }

  runEnded(roomKey: string): { acked: boolean; output: boolean } {
    const st = this.rooms.get(roomKey);
    if (!st) return { acked: false, output: false };
    this.cancel(st);
    this.rooms.delete(roomKey);
    return { acked: st.acked, output: st.output };
  }

  clear(): void {
    for (const st of this.rooms.values()) this.cancel(st);
    this.rooms.clear();
  }

  private ripen(roomKey: string, p: Pending): void {
    const st = this.rooms.get(roomKey);
    if (!st || !st.pending.includes(p)) return;
    p.ripe = true;
    p.timer = null;
    if (st.toolSeen) {
      this.fire(roomKey, p);
      return;
    }
    p.timer = this.timers.setTimeout(() => this.fire(roomKey, p), 2 * this.deps.ackAfterMs());
  }

  private fire(roomKey: string, p: Pending): void {
    const st = this.rooms.get(roomKey);
    if (!st || !st.pending.includes(p)) return;
    this.cancel(st);
    if (!this.deps.isActive(roomKey)) return;
    st.acked = true;
    this.deps.post(roomKey, p.busy ? 'busy' : 'ack');
  }

  private cancel(st: RoomAck): void {
    for (const p of st.pending) if (p.timer) this.timers.clearTimeout(p.timer);
    st.pending = [];
  }
}
