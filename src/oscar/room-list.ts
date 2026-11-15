import { OscarError, RoomJoinError } from 'open-oscar-client-kit/client';
import { roomConversationId } from 'open-oscar-client-kit/model';
import type { RoomMessage, RoomOccupantChange, RoomRate, RoomStatus } from 'open-oscar-client-kit/model';
import {
  ROOM_MISSING_RETRY_MS,
  ROOM_QUEUE_MAX,
  ROOM_REJOIN_BASE_MS,
  ROOM_REJOIN_CAP_MS,
  ROOM_REJOIN_STABLE_MS,
  ROOM_SESSION_MAX_FAILURES,
  joinTooLong,
  normalizeScreenName,
  roomCookie,
} from 'open-oscar-client-kit/wire';
import { toRewrittenLine, toRoomMessageEvent } from './events.js';
import type { KitClient } from './kit-client.js';
import { SendQueue, toRoomError, toSendError } from './send.js';
import {
  OscarRoomError,
  OscarSendError,
  type InviteEvent,
  type Logger,
  type OscarEvents,
  type RoomRef,
  type SendPriority,
  type SendReceipt,
  type TimerApi,
} from './types.js';

export type RoomEventName = 'roomReady' | 'roomJoin' | 'roomLeave' | 'roomMessage' | 'roomClosed' | 'rate';

export type RoomListDeps = {
  client(): KitClient | null;
  isOnline(): boolean;
  emit<E extends RoomEventName>(event: E, payload: OscarEvents[E]): void;
  log: Logger;
  now(): number;
  timers: TimerApi;
  random(): number;
};

type Wanted = { room: RoomRef; persistent: boolean; failures: number; timer: ReturnType<typeof setTimeout> | null };
type Live = { room: RoomRef; entry: Wanted; joinedAt: number; occupants: string[]; queue: SendQueue };

const names = (occupants: readonly string[]): string[] => occupants.map(normalizeScreenName);
const quiet = (): void => undefined;

function lineError(error: unknown): OscarSendError {
  if (error instanceof OscarError && error.info.kind === 'local') {
    if (error.info.code === 'whisper-target-left') return new OscarSendError('recipient-unavailable');
    // the room was live when the line left, so it closed under it
    if (error.info.code === 'not-in-room') return new OscarSendError('closed');
  }
  return toSendError(error);
}

export class RoomList {
  private readonly wanted = new Map<string, Wanted>();
  private readonly live = new Map<string, Live>();
  private readonly joining = new Map<string, Promise<void>>();
  private chain: Promise<void> = Promise.resolve();
  private bound: KitClient | null = null;
  private unbind: (() => void)[] = [];

  constructor(private readonly deps: RoomListDeps) {
    this.bind();
  }

  joinRoom(room: RoomRef, opts: { persistent?: boolean } = {}): Promise<void> {
    const ref: RoomRef = { exchange: room.exchange, name: room.name.toLowerCase() };
    const id = roomConversationId(ref);
    let entry = this.wanted.get(id);
    const created = !entry;
    if (!entry) {
      entry = { room: ref, persistent: opts.persistent === true, failures: 0, timer: null };
      this.wanted.set(id, entry);
    } else if (opts.persistent) {
      entry.persistent = true;
    }
    if (this.live.has(id)) return Promise.resolve();
    if (!this.deps.isOnline()) {
      if (entry.persistent) return Promise.resolve();
      if (created) this.wanted.delete(id);
      return Promise.reject(new OscarRoomError('not-online'));
    }
    return this.enqueue(entry, true);
  }

  joinInvited(invite: InviteEvent): Promise<void> {
    const ref: RoomRef = { exchange: invite.room.exchange, name: invite.room.name.toLowerCase() };
    const id = roomConversationId(ref);
    const forget = (): void => this.deps.client()?.forgetInvite(invite.roomCookie);
    // a second join of a room we hold would evict our own seat
    if (this.live.has(id)) {
      forget();
      return Promise.resolve();
    }
    if (!this.deps.isOnline()) return Promise.reject(new OscarRoomError('not-online'));
    let entry = this.wanted.get(id);
    if (!entry) {
      entry = { room: ref, persistent: false, failures: 0, timer: null };
      this.wanted.set(id, entry);
    }
    return this.enqueue(entry, true).finally(forget);
  }

  leaveRoom(room: RoomRef): Promise<void> {
    const id = roomConversationId(room);
    const entry = this.wanted.get(id);
    if (entry) this.forget(id, entry);
    const held = this.live.get(id);
    if (held) {
      this.close(id, held);
      this.deps.emit('roomClosed', { room: held.room, willRejoin: false });
    }
    return held || this.joining.has(id) ? this.release(id) : Promise.resolve();
  }

  rooms(): { room: RoomRef; occupants: string[]; joinedAt: number }[] {
    return [...this.live.values()].map((held) => ({ room: held.room, occupants: [...held.occupants], joinedAt: held.joinedAt }));
  }

  sendRoom(room: RoomRef, html: string, opts?: { whisperTo?: string; priority?: SendPriority }): Promise<SendReceipt> {
    const id = roomConversationId(room);
    const held = this.live.get(id);
    if (!held) return Promise.reject(new OscarSendError('room-not-joined'));
    if (held.queue.waiting >= ROOM_QUEUE_MAX) return Promise.reject(new OscarSendError('rate-limited'));
    return held.queue.push(opts?.priority ?? 'reply', async () => {
      const client = this.deps.client();
      if (!client || this.live.get(id) !== held) throw new OscarSendError('closed');
      try {
        const whisper = opts?.whisperTo === undefined ? undefined : { whisperTo: opts.whisperTo };
        const sent = await (whisper ? client.sendRoomMessage(id, { html }, whisper) : client.sendRoomMessage(id, { html }));
        if (sent.replacedBy) this.deps.emit('roomMessage', toRewrittenLine(held.room, sent.id, sent.replacedBy));
        return { id: sent.id, storedOffline: false };
      } catch (error) {
        throw lineError(error);
      }
    });
  }

  online(): void {
    this.bind();
    const entries = [...this.wanted.values()].sort((a, b) => Number(b.persistent) - Number(a.persistent));
    for (const entry of entries) {
      const id = roomConversationId(entry.room);
      if (this.live.has(id) || this.joining.has(id)) continue;
      this.clearTimer(entry);
      this.enqueue(entry, false).catch(quiet);
    }
  }

  offline(): void {
    for (const entry of this.wanted.values()) this.clearTimer(entry);
    for (const [id, held] of [...this.live]) {
      this.close(id, held);
      this.deps.emit('roomClosed', { room: held.room, willRejoin: this.wanted.has(id) });
    }
  }

  stop(): void {
    for (const [id, entry] of [...this.wanted]) {
      if (!entry.persistent) this.forget(id, entry);
    }
    this.offline();
  }

  private bind(): void {
    const client = this.deps.client();
    if (!client || client === this.bound) return;
    for (const off of this.unbind) off();
    this.bound = client;
    this.unbind = [
      client.on('room', (status) => this.onRoom(status)),
      client.on('roomOccupant', (change) => this.onOccupant(change)),
      client.on('roomMessage', (message) => this.onMessage(message)),
      client.on('roomRate', (rate) => this.onRate(rate)),
    ];
  }

  private onRoom(status: RoomStatus): void {
    if (status.state === 'joined') {
      const entry = this.wanted.get(status.id);
      if (entry) this.ready(status.id, entry, status);
    } else if (status.state === 'disconnected' || status.state === 'notAvailable') {
      this.dropped(status.id);
    }
  }

  private onOccupant(change: RoomOccupantChange): void {
    const held = this.live.get(change.roomId);
    if (!held) return;
    held.occupants = names(change.occupants);
    const who = { room: held.room, name: normalizeScreenName(change.screenName), display: change.screenName };
    this.deps.emit(change.change === 'joined' ? 'roomJoin' : 'roomLeave', who);
  }

  private onMessage(message: RoomMessage): void {
    const held = this.live.get(message.roomId);
    if (held) this.deps.emit('roomMessage', toRoomMessageEvent(held.room, message));
  }

  private onRate(rate: RoomRate): void {
    const held = this.live.get(rate.roomId);
    if (held) this.deps.emit('rate', { scope: held.room, status: rate.status });
  }

  private ready(id: string, entry: Wanted, status: RoomStatus): void {
    if (this.live.has(id)) return;
    const occupants = names(status.occupants);
    this.live.set(id, { room: entry.room, entry, joinedAt: this.deps.now(), occupants, queue: new SendQueue() });
    this.deps.emit('roomReady', { room: entry.room, occupants: [...occupants] });
  }

  private close(id: string, held: Live): void {
    this.live.delete(id);
    held.queue.failAll(new OscarSendError('closed'));
  }

  // The client keeps a closed room, and its seat, until it is left.
  private release(id: string): Promise<void> {
    const client = this.deps.client();
    return client ? client.leaveRoom(id).catch(quiet) : Promise.resolve();
  }

  private enqueue(entry: Wanted, manual: boolean): Promise<void> {
    const id = roomConversationId(entry.room);
    const running = this.joining.get(id);
    if (running) return running;
    const run = this.chain
      .then(() => this.attempt(id, entry))
      .catch((err: unknown) => {
        const error = !this.deps.isOnline() && !(err instanceof OscarRoomError) ? new OscarRoomError('not-online') : toRoomError(err);
        const hopeless = error.code === 'too-long' || (err instanceof RoomJoinError && err.reason === 'invalid-name');
        this.failed(id, entry, error, hopeless, manual);
        throw error;
      });
    this.chain = run.catch(quiet);
    this.joining.set(id, run);
    const done = (): void => {
      if (this.joining.get(id) === run) this.joining.delete(id);
    };
    run.then(done, done);
    return run;
  }

  private async attempt(id: string, entry: Wanted): Promise<void> {
    if (this.wanted.get(id) !== entry || this.live.has(id)) return;
    const client = this.deps.client();
    if (!client || !this.deps.isOnline()) throw new OscarRoomError('not-online');
    this.bind();
    const self = client.self?.screenName;
    if (self !== undefined && joinTooLong(self, roomCookie(entry.room))) throw new OscarRoomError('too-long');
    let status: RoomStatus;
    try {
      status = await client.joinRoom(entry.room);
    } catch (err) {
      // leaving a room ends its join in the client
      if (this.wanted.get(id) !== entry) return;
      throw err;
    }
    if (this.wanted.get(id) !== entry) {
      await this.release(id);
      return;
    }
    if (status.state === 'joined') this.ready(id, entry, status);
  }

  private dropped(id: string): void {
    const held = this.live.get(id);
    if (!held) return;
    this.close(id, held);
    const entry = held.entry;
    if (this.deps.now() - held.joinedAt >= ROOM_REJOIN_STABLE_MS) entry.failures = 0;
    const willRejoin = this.wanted.get(id) === entry;
    void this.release(id);
    this.deps.emit('roomClosed', { room: held.room, willRejoin });
    if (!willRejoin || !this.deps.isOnline()) return;
    entry.failures += 1;
    this.schedule(id, entry, this.backoff(entry.failures));
  }

  private failed(id: string, entry: Wanted, error: OscarRoomError, hopeless: boolean, manual: boolean): void {
    if (this.wanted.get(id) !== entry) return;
    const code = error.code;
    if (code !== 'not-online') entry.failures += 1;
    this.deps.log.warn('room join failed', { room: entry.room.name, exchange: entry.room.exchange, code });
    const giveUp =
      hopeless || (!entry.persistent && (manual || code === 'no-such-room' || entry.failures >= ROOM_SESSION_MAX_FAILURES));
    if (giveUp) {
      this.forget(id, entry);
      if (!manual) this.deps.emit('roomClosed', { room: entry.room, willRejoin: false });
      return;
    }
    if (code === 'not-online' && !this.deps.isOnline()) return;
    this.schedule(id, entry, code === 'no-such-room' ? ROOM_MISSING_RETRY_MS : this.backoff(entry.failures));
  }

  private schedule(id: string, entry: Wanted, ms: number): void {
    this.clearTimer(entry);
    entry.timer = this.deps.timers.setTimeout(() => {
      entry.timer = null;
      if (this.wanted.get(id) !== entry || this.live.has(id) || !this.deps.isOnline()) return;
      this.enqueue(entry, false).catch(quiet);
    }, ms);
  }

  private backoff(failures: number): number {
    const base = Math.min(ROOM_REJOIN_CAP_MS, ROOM_REJOIN_BASE_MS * 2 ** Math.max(0, failures - 1));
    return Math.round(base * (0.8 + 0.4 * this.deps.random()));
  }

  private forget(id: string, entry: Wanted): void {
    this.clearTimer(entry);
    if (this.wanted.get(id) === entry) this.wanted.delete(id);
  }

  private clearTimer(entry: Wanted): void {
    if (entry.timer) this.deps.timers.clearTimeout(entry.timer);
    entry.timer = null;
  }
}
