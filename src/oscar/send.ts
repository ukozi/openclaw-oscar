import { OscarError, RoomJoinError } from 'open-oscar-client-kit/client';
import type { SentIm } from 'open-oscar-client-kit/client';
import { TYPING_KEEPALIVE_MS, TYPING_MAX_MS, normalizeScreenName } from 'open-oscar-client-kit/wire';
import type { KitClient } from './kit-client.js';
import { OscarRoomError, OscarSendError } from './types.js';
import type { SendPriority, SendReceipt, TimerApi } from './types.js';

type Timer = ReturnType<typeof setTimeout>;
type Job = { run: () => Promise<SendReceipt>; resolve: (r: SendReceipt) => void; reject: (e: Error) => void };

const PRIORITIES: readonly SendPriority[] = ['reply', 'control', 'notice'];

export class SendQueue {
  private readonly lanes: Record<SendPriority, Job[]> = { reply: [], control: [], notice: [] };
  private busy = false;

  push(priority: SendPriority, run: () => Promise<SendReceipt>): Promise<SendReceipt> {
    return new Promise<SendReceipt>((resolve, reject) => {
      this.lanes[priority].push({ run, resolve, reject });
      void this.pump();
    });
  }

  get waiting(): number {
    return PRIORITIES.reduce((n, p) => n + this.lanes[p].length, 0);
  }

  failAll(error: Error): void {
    for (const p of PRIORITIES) for (const job of this.lanes[p].splice(0)) job.reject(error);
  }

  private async pump(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (;;) {
        const job = PRIORITIES.map((p) => this.lanes[p]).find((lane) => lane.length > 0)?.shift();
        if (!job) return;
        await job.run().then(job.resolve, job.reject);
      }
    } finally {
      this.busy = false;
    }
  }
}

function isAckTimeout(error: unknown): boolean {
  return error instanceof OscarError && error.info.kind === 'timeout';
}

export function toSendError(error: unknown): OscarSendError {
  if (error instanceof OscarSendError) return error;
  if (!(error instanceof OscarError)) return new OscarSendError('closed');
  const info = error.info;
  switch (info.kind) {
    case 'not-signed-on':
      return new OscarSendError('not-online');
    case 'timeout':
      return new OscarSendError('rate-limited');
    case 'refused':
      return new OscarSendError('recipient-unavailable', `send refused (0x${(info.code >>> 0).toString(16)})`);
    case 'local':
      switch (info.code) {
        case 'message-too-long':
        case 'text-too-long':
          return new OscarSendError('too-long');
        case 'invalid-argument':
        case 'invalid-screen-name':
          return new OscarSendError('recipient-unavailable', 'bad screen name');
        case 'not-in-room':
        case 'unknown-conversation':
          return new OscarSendError('room-not-joined');
        case 'rate-held':
          return new OscarSendError('rate-limited');
        default:
          return new OscarSendError('closed');
      }
    default:
      return new OscarSendError('closed');
  }
}

export function toRoomError(error: unknown): OscarRoomError {
  if (error instanceof OscarRoomError) return error;
  if (error instanceof RoomJoinError) {
    if (error.reason === 'no-such-room') return new OscarRoomError('no-such-room');
    return new OscarRoomError(error.reason === 'name-too-long' ? 'too-long' : 'unavailable');
  }
  if (error instanceof OscarError && error.info.kind === 'not-signed-on') return new OscarRoomError('not-online');
  return new OscarRoomError('unavailable');
}

export async function sendWithResend(client: KitClient, to: string, html: string, auto: boolean): Promise<SendReceipt> {
  const once = (): Promise<SentIm> => client.sendIm(to, { html }, { automatic: auto, store: 'when-offline' });
  let sent: SentIm;
  try {
    sent = await once();
  } catch (first) {
    if (!isAckTimeout(first)) throw toSendError(first);
    // No acknowledgment on a live link means the server's limiter dropped it. The second copy waits in the rate class.
    if (client.state !== 'online') throw new OscarSendError('closed');
    try {
      sent = await once();
    } catch (second) {
      throw isAckTimeout(second) ? new OscarSendError('rate-limited') : toSendError(second);
    }
  }
  return { id: sent.id, storedOffline: sent.stored };
}

export class Typing {
  private readonly open = new Map<string, { timer: Timer; stopAt: number }>();

  constructor(
    private readonly deps: { client(): KitClient | null; limited(): boolean; now(): number; timers: TimerApi },
  ) {}

  send(to: string, state: 'typing' | 'typed' | 'none'): void {
    const client = this.deps.client();
    if (!client) return;
    const name = normalizeScreenName(to);
    const stopAt = this.open.get(name)?.stopAt ?? this.deps.now() + TYPING_MAX_MS;
    this.clear(name);
    if (!this.deps.limited()) {
      try {
        client.sendTyping(to, state === 'none' ? 'stopped' : state).catch(() => {});
      } catch {
        // A typing notice is never worth a failure.
      }
    }
    if (state !== 'typing') return;
    const timer = this.deps.timers.setTimeout(() => {
      this.send(to, this.deps.now() >= stopAt ? 'none' : 'typing');
    }, TYPING_KEEPALIVE_MS);
    this.open.set(name, { timer, stopAt });
  }

  clearAll(): void {
    for (const name of [...this.open.keys()]) this.clear(name);
  }

  private clear(name: string): void {
    const entry = this.open.get(name);
    if (entry) this.deps.timers.clearTimeout(entry.timer);
    this.open.delete(name);
  }
}
