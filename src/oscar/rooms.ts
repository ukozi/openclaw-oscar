import { joinTooLong, requestService, resolveRoom, roomCookie, roomKey, type NavQuery, type ServiceResolver } from './chatnav.js';
import { ChatRoom, type RoomPacer, type RoomTimers } from './chatroom.js';
import {
  FAMILY_CHAT,
  FAMILY_CHATNAV,
  ROOM_MISSING_RETRY_MS,
  ROOM_REJOIN_BASE_MS,
  ROOM_REJOIN_CAP_MS,
  ROOM_REJOIN_STABLE_MS,
  ROOM_SESSION_MAX_FAILURES,
} from './constants.js';
import {
  OscarRoomError,
  OscarSendError,
  type InviteEvent,
  type Logger,
  type OscarEvents,
  type RoomRef,
  type SendPriority,
  type SendReceipt,
  type SnacLink,
} from './types.js';

export type RoomEventName = 'roomReady' | 'roomJoin' | 'roomLeave' | 'roomMessage' | 'roomClosed' | 'rate';

export type RoomsHost = {
  screenName(): string;
  online(): boolean;
  resolveService: ServiceResolver;
  connect(target: { host: string; port: number }, cookie: Uint8Array): Promise<SnacLink>;
  makePacer(): RoomPacer;
  bosRateNotice(body: Uint8Array): void;
  emit<E extends RoomEventName>(event: E, payload: OscarEvents[E]): void;
  log: Logger;
  now(): number;
  timers: RoomTimers;
  random(): number;
};

type Wanted = {
  room: RoomRef;
  persistent: boolean;
  inviteCookie?: string;
  failures: number;
  timer: ReturnType<typeof setTimeout> | null;
};

type Live = { chat: ChatRoom; joinedAt: number };

export class RoomManager {
  private readonly wanted = new Map<string, Wanted>();
  private readonly live = new Map<string, Live>();
  private readonly joining = new Map<string, Promise<void>>();
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly host: RoomsHost) {}

  joinRoom(room: RoomRef, opts: { persistent?: boolean } = {}): Promise<void> {
    const ref: RoomRef = { exchange: room.exchange, name: room.name.toLowerCase() };
    const key = roomKey(ref);
    let entry = this.wanted.get(key);
    const created = !entry;
    if (!entry) {
      entry = { room: ref, persistent: opts.persistent === true, failures: 0, timer: null };
      this.wanted.set(key, entry);
    } else if (opts.persistent) {
      entry.persistent = true;
    }
    if (this.live.has(key)) return Promise.resolve();
    if (!this.host.online()) {
      if (entry.persistent) return Promise.resolve();
      if (created) this.wanted.delete(key);
      return Promise.reject(new OscarRoomError('not-online'));
    }
    return this.enqueue(entry, true);
  }

  joinInvited(invite: InviteEvent): Promise<void> {
    const ref: RoomRef = { exchange: invite.room.exchange, name: invite.room.name.toLowerCase() };
    const key = roomKey(ref);
    // a second join of a room we hold would evict our own seat
    if (this.live.has(key)) return Promise.resolve();
    if (!this.host.online()) return Promise.reject(new OscarRoomError('not-online'));
    let entry = this.wanted.get(key);
    if (!entry) {
      entry = { room: ref, persistent: false, inviteCookie: invite.roomCookie, failures: 0, timer: null };
      this.wanted.set(key, entry);
    }
    return this.enqueue(entry, true);
  }

  leaveRoom(room: RoomRef): Promise<void> {
    const key = roomKey(room);
    const entry = this.wanted.get(key);
    if (entry) this.forget(key, entry);
    const held = this.live.get(key);
    if (held) {
      this.live.delete(key);
      held.chat.close();
      this.host.emit('roomClosed', { room: held.chat.room, willRejoin: false });
    }
    return Promise.resolve();
  }

  rooms(): { room: RoomRef; occupants: string[]; joinedAt: number }[] {
    return [...this.live.values()].map((held) => ({
      room: held.chat.room,
      occupants: held.chat.occupants(),
      joinedAt: held.joinedAt,
    }));
  }

  sendRoom(room: RoomRef, html: string, opts?: { whisperTo?: string; priority?: SendPriority }): Promise<SendReceipt> {
    const held = this.live.get(roomKey(room));
    if (!held) return Promise.reject(new OscarSendError('room-not-joined'));
    return held.chat.send(html, opts);
  }

  bosOnline(): void {
    const entries = [...this.wanted.values()].sort((a, b) => Number(b.persistent) - Number(a.persistent));
    for (const entry of entries) {
      const key = roomKey(entry.room);
      if (this.live.has(key) || this.joining.has(key)) continue;
      this.clearTimer(entry);
      this.enqueue(entry, false).catch(() => undefined);
    }
  }

  bosLost(): void {
    for (const entry of this.wanted.values()) this.clearTimer(entry);
    for (const [key, held] of [...this.live]) {
      this.live.delete(key);
      held.chat.close();
      this.host.emit('roomClosed', { room: held.chat.room, willRejoin: this.wanted.has(key) });
    }
  }

  stop(): void {
    for (const [key, entry] of [...this.wanted]) {
      if (!entry.persistent) this.forget(key, entry);
    }
    this.bosLost();
  }

  private enqueue(entry: Wanted, manual: boolean): Promise<void> {
    const key = roomKey(entry.room);
    const running = this.joining.get(key);
    if (running) return running;
    const run = this.chain
      .then(() => this.attempt(key, entry))
      .catch((err: unknown) => {
        this.failed(key, entry, err, manual);
        throw err;
      });
    this.chain = run.catch(() => undefined);
    this.joining.set(key, run);
    const done = (): void => {
      if (this.joining.get(key) === run) this.joining.delete(key);
    };
    run.then(done, done);
    return run;
  }

  private async attempt(key: string, entry: Wanted): Promise<void> {
    if (this.wanted.get(key) !== entry || this.live.has(key)) return;
    if (!this.host.online()) throw new OscarRoomError('not-online');
    const self = this.host.screenName();
    const ask: ServiceResolver = (family, roomInfo) => this.host.resolveService(family, roomInfo);
    const open = (grant: { host: string; port: number; cookie: Uint8Array; expiresAt: number }): Promise<SnacLink> => {
      if (grant.expiresAt <= this.host.now()) throw new OscarRoomError('unavailable', 'the service cookie ran out before its socket opened');
      return this.host.connect({ host: grant.host, port: grant.port }, grant.cookie);
    };
    if (joinTooLong(self, entry.inviteCookie ?? roomCookie(entry.room))) throw new OscarRoomError('too-long');

    const query: NavQuery = entry.inviteCookie
      ? { kind: 'cookie', exchange: entry.room.exchange, cookie: entry.inviteCookie }
      : { kind: 'create', room: entry.room };
    const info = await resolveRoom(query, {
      open: async () => open(await requestService(ask, { foodGroup: FAMILY_CHATNAV, screenName: self })),
      sleep: (ms) => new Promise<void>((resolve) => this.host.timers.setTimeout(resolve, ms)),
      random: () => this.host.random(),
      log: this.host.log,
      onStrayRate: (body) => this.host.bosRateNotice(body),
    });

    // a chat service request for a cookie the server does not know drops BOS, so it only ever follows a fresh resolve
    const grant = await requestService(ask, { foodGroup: FAMILY_CHAT, room: info, screenName: self });
    let link: SnacLink;
    try {
      link = await open(grant);
    } catch (err) {
      throw err instanceof OscarRoomError ? err : new OscarRoomError('unavailable', 'room socket did not open');
    }
    const chat = new ChatRoom({
      room: entry.room,
      link,
      self,
      pacer: this.host.makePacer(),
      log: this.host.log,
      now: () => this.host.now(),
      timers: this.host.timers,
    });
    const occupants = await chat.start();
    if (this.wanted.get(key) !== entry) {
      chat.close();
      return;
    }
    const room = entry.room;
    this.live.set(key, { chat, joinedAt: this.host.now() });
    chat.on('join', (e) => this.host.emit('roomJoin', { room, ...e }));
    chat.on('leave', (e) => this.host.emit('roomLeave', { room, ...e }));
    chat.on('message', (e) => this.host.emit('roomMessage', { room, ...e }));
    chat.on('rate', (status) => this.host.emit('rate', { scope: room, status }));
    chat.on('closed', () => this.dropped(key, entry, chat));
    this.host.emit('roomReady', { room, occupants });
  }

  private dropped(key: string, entry: Wanted, chat: ChatRoom): void {
    const held = this.live.get(key);
    if (!held || held.chat !== chat) return;
    this.live.delete(key);
    if (this.host.now() - held.joinedAt >= ROOM_REJOIN_STABLE_MS) entry.failures = 0;
    const willRejoin = this.wanted.get(key) === entry;
    // the server closes a room socket with a bare signoff whatever the cause, so the reason is unknowable here
    this.host.emit('roomClosed', { room: entry.room, willRejoin });
    if (!willRejoin || !this.host.online()) return;
    entry.failures += 1;
    this.schedule(key, entry, this.backoff(entry.failures));
  }

  private failed(key: string, entry: Wanted, err: unknown, manual: boolean): void {
    if (this.wanted.get(key) !== entry) return;
    const code = err instanceof OscarRoomError ? err.code : 'unavailable';
    if (code !== 'not-online') entry.failures += 1;
    this.host.log.warn('room join failed', { room: entry.room.name, exchange: entry.room.exchange, code });
    const giveUp =
      code === 'too-long' ||
      (!entry.persistent && (manual || code === 'no-such-room' || entry.failures >= ROOM_SESSION_MAX_FAILURES));
    if (giveUp) {
      this.forget(key, entry);
      if (!manual) this.host.emit('roomClosed', { room: entry.room, willRejoin: false });
      return;
    }
    if (code === 'not-online' && !this.host.online()) return;
    this.schedule(key, entry, code === 'no-such-room' ? ROOM_MISSING_RETRY_MS : this.backoff(entry.failures));
  }

  private schedule(key: string, entry: Wanted, ms: number): void {
    this.clearTimer(entry);
    entry.timer = this.host.timers.setTimeout(() => {
      entry.timer = null;
      if (this.wanted.get(key) !== entry || this.live.has(key) || !this.host.online()) return;
      this.enqueue(entry, false).catch(() => undefined);
    }, ms);
  }

  private backoff(failures: number): number {
    const base = Math.min(ROOM_REJOIN_CAP_MS, ROOM_REJOIN_BASE_MS * 2 ** Math.max(0, failures - 1));
    return Math.round(base * (0.8 + 0.4 * this.host.random()));
  }

  private forget(key: string, entry: Wanted): void {
    this.clearTimer(entry);
    if (this.wanted.get(key) === entry) this.wanted.delete(key);
  }

  private clearTimer(entry: Wanted): void {
    if (entry.timer) this.host.timers.clearTimeout(entry.timer);
    entry.timer = null;
  }
}
