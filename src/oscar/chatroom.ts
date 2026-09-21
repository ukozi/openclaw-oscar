import { randomBytes } from 'node:crypto';
import {
  CHAT_CHANNEL,
  CHAT_CLIENT_TOOL_ID,
  CHAT_CLIENT_TOOL_VERSION,
  CHAT_ENCODING_ASCII,
  CHAT_LANG,
  CHAT_MSG_TLV_ENCODING,
  CHAT_MSG_TLV_LANG,
  CHAT_MSG_TLV_TEXT,
  CHAT_MSG_TO_CLIENT,
  CHAT_MSG_TO_HOST,
  CHAT_RATE_CLASS_IDS,
  CHAT_TLV_MESSAGE,
  CHAT_TLV_PUBLIC,
  CHAT_TLV_REFLECT,
  CHAT_TLV_SENDER,
  CHAT_TLV_WHISPER_TO,
  CHAT_USERS_JOINED,
  CHAT_USERS_LEFT,
  FAMILY_CHAT,
  FAMILY_OSERVICE,
  OSERVICE_CLIENT_ONLINE,
  OSERVICE_RATE_PARAMS_QUERY,
  OSERVICE_RATE_PARAMS_REPLY,
  OSERVICE_RATE_PARAMS_SUB_ADD,
  OSERVICE_RATE_PARAM_CHANGE,
  ROOM_LIMITED_HOLD_MS,
  ROOM_MAX_TEXT_BYTES,
  ROOM_QUEUE_MAX,
  ROOM_READY_TIMEOUT_MS,
  ROOM_RECEIPT_TIMEOUT_MS,
  ROOM_SERVER_SENDER,
  SERVICE_REQUEST_TIMEOUT_MS,
} from './constants.js';
import { decodeUserInfo, type UserInfo } from './snac.js';
import { fromWireText, normalizeScreenName, toAsciiEntities } from './text.js';
import { decodeTlvs, encodeTlvs, findTlv, type Tlv } from './tlv.js';
import {
  OscarRoomError,
  OscarSendError,
  type LinkClose,
  type Logger,
  type RoomRef,
  type SendPriority,
  type SendReceipt,
  type SnacIn,
  type SnacLink,
} from './types.js';

export type RoomRateStatus = 'clear' | 'alert' | 'limited';

export interface RoomPacer {
  seed(rateParamsReply: Uint8Array): void;
  notice(rateParamChange: Uint8Array): RoomRateStatus | null;
  waitMs(): number;
  sent(): void;
  dropped(): void;
}

export type RoomTimers = { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };

export type ChatRoomOptions = {
  room: RoomRef;
  link: SnacLink;
  self: string;
  pacer: RoomPacer;
  log: Logger;
  now: () => number;
  timers: RoomTimers;
  newCookie?: () => bigint;
};

export type ChatRoomEvents = {
  join: { name: string; display: string };
  leave: { name: string; display: string };
  message: { from: string; fromDisplay: string; text: string; cookie: bigint; whisper: boolean };
  rate: RoomRateStatus;
  closed: LinkClose;
};

export type RoomWireMessage = {
  cookie: bigint;
  sender: UserInfo;
  isPublic: boolean;
  text: Uint8Array;
  encoding?: string;
};

type Pending = {
  cookie: bigint;
  body: Uint8Array;
  rank: number;
  tries: number;
  resolve: (receipt: SendReceipt) => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
};

const RANK: Record<SendPriority, number> = { reply: 0, control: 1, notice: 2 };

export function newRoomCookie(): bigint {
  // cookie 0 is what TOC senders use, so it can never identify our own reflection
  for (;;) {
    const cookie = randomBytes(8).readBigUInt64BE(0);
    if (cookie !== 0n) return cookie;
  }
}

export function encodeRoomSend(msg: { cookie: bigint; text: string; whisperTo?: string }): Uint8Array {
  const head = Buffer.alloc(10);
  head.writeBigUInt64BE(msg.cookie, 0);
  head.writeUInt16BE(CHAT_CHANNEL, 8);
  const info = encodeTlvs([
    { tag: CHAT_MSG_TLV_ENCODING, value: Buffer.from(CHAT_ENCODING_ASCII, 'ascii') },
    { tag: CHAT_MSG_TLV_LANG, value: Buffer.from(CHAT_LANG, 'ascii') },
    { tag: CHAT_MSG_TLV_TEXT, value: Buffer.from(msg.text, 'ascii') },
  ]);
  const empty = new Uint8Array(0);
  const tlvs: Tlv[] =
    msg.whisperTo === undefined
      ? [
          { tag: CHAT_TLV_PUBLIC, value: empty },
          { tag: CHAT_TLV_REFLECT, value: empty },
        ]
      : [
          { tag: CHAT_TLV_REFLECT, value: empty },
          { tag: CHAT_TLV_WHISPER_TO, value: Buffer.from(msg.whisperTo, 'utf8') },
        ];
  // a room message without TLV 0x05 and its nested text TLV drops the room socket
  tlvs.push({ tag: CHAT_TLV_MESSAGE, value: info });
  return Buffer.concat([head, Buffer.from(encodeTlvs(tlvs))]);
}

export function decodeRoomMessage(body: Uint8Array): RoomWireMessage | null {
  if (body.length < 10) return null;
  const b = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  try {
    const tlvs = decodeTlvs(b.subarray(10));
    const senderBytes = findTlv(tlvs, CHAT_TLV_SENDER);
    const infoBytes = findTlv(tlvs, CHAT_TLV_MESSAGE);
    if (!senderBytes || !infoBytes) return null;
    const inner = decodeTlvs(infoBytes);
    const text = findTlv(inner, CHAT_MSG_TLV_TEXT);
    if (!text) return null;
    const encoding = findTlv(inner, CHAT_MSG_TLV_ENCODING);
    return {
      cookie: b.readBigUInt64BE(0),
      sender: decodeUserInfo(senderBytes, 0).info,
      isPublic: findTlv(tlvs, CHAT_TLV_PUBLIC) !== undefined,
      text,
      encoding: encoding ? Buffer.from(encoding).toString('ascii') : undefined,
    };
  } catch {
    return null;
  }
}

export function decodeRoster(body: Uint8Array): UserInfo[] {
  const out: UserInfo[] = [];
  let at = 0;
  try {
    while (at < body.length) {
      const { info, next } = decodeUserInfo(body, at);
      out.push(info);
      at = next;
    }
  } catch {
    return out;
  }
  return out;
}

export function encodeClassIds(ids: number[]): Uint8Array {
  const b = Buffer.alloc(ids.length * 2);
  ids.forEach((id, i) => b.writeUInt16BE(id, i * 2));
  return b;
}

export function encodeRoomClientOnline(): Uint8Array {
  const families = [FAMILY_OSERVICE, FAMILY_CHAT];
  const b = Buffer.alloc(families.length * 8);
  families.forEach((family, i) => {
    b.writeUInt16BE(family, i * 8);
    b.writeUInt16BE(1, i * 8 + 2);
    b.writeUInt16BE(CHAT_CLIENT_TOOL_ID, i * 8 + 4);
    b.writeUInt16BE(CHAT_CLIENT_TOOL_VERSION, i * 8 + 6);
  });
  return b;
}

export class ChatRoom {
  readonly room: RoomRef;
  private readonly link: SnacLink;
  private readonly self: string;
  private readonly pacer: RoomPacer;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly timers: RoomTimers;
  private readonly newCookie: () => bigint;
  private readonly names = new Map<string, string>();
  private readonly listeners: { [E in keyof ChatRoomEvents]: Set<(p: ChatRoomEvents[E]) => void> } = {
    join: new Set(),
    leave: new Set(),
    message: new Set(),
    rate: new Set(),
    closed: new Set(),
  };
  private queue: Pending[] = [];
  private inflight: Pending | null = null;
  private pumpTimer: ReturnType<typeof setTimeout> | null = null;
  private holdUntil = 0;
  private ready = false;
  private closed = false;
  private settleReady: { resolve: (names: string[]) => void; reject: (err: Error) => void } | null = null;

  constructor(opts: ChatRoomOptions) {
    this.room = opts.room;
    this.link = opts.link;
    this.self = normalizeScreenName(opts.self);
    this.pacer = opts.pacer;
    this.log = opts.log;
    this.now = opts.now;
    this.timers = opts.timers;
    this.newCookie = opts.newCookie ?? newRoomCookie;
  }

  on<E extends keyof ChatRoomEvents>(event: E, fn: (payload: ChatRoomEvents[E]) => void): () => void {
    this.listeners[event].add(fn);
    return () => {
      this.listeners[event].delete(fn);
    };
  }

  occupants(): string[] {
    return [...this.names.keys()];
  }

  async start(): Promise<string[]> {
    this.link.onSnac((snac) => this.handle(snac));
    this.link.onClose((info) => this.handleClose(info));
    const roster = new Promise<string[]>((resolve, reject) => {
      this.settleReady = { resolve, reject };
    });
    roster.catch(() => undefined);
    const timer = this.timers.setTimeout(() => {
      this.settleReady?.reject(new OscarRoomError('unavailable', 'room roster did not arrive'));
    }, ROOM_READY_TIMEOUT_MS);
    try {
      const reply = await this.link.request(
        FAMILY_OSERVICE,
        OSERVICE_RATE_PARAMS_QUERY,
        new Uint8Array(0),
        SERVICE_REQUEST_TIMEOUT_MS,
      );
      if (reply.family === FAMILY_OSERVICE && reply.subtype === OSERVICE_RATE_PARAMS_REPLY) this.pacer.seed(reply.body);
      // the server sends 0x01/0x0A on a socket only for classes subscribed on that socket
      this.link.send(FAMILY_OSERVICE, OSERVICE_RATE_PARAMS_SUB_ADD, encodeClassIds(CHAT_RATE_CLASS_IDS));
      this.link.send(FAMILY_OSERVICE, OSERVICE_CLIENT_ONLINE, encodeRoomClientOnline());
      return await roster;
    } catch (err) {
      this.close();
      throw err instanceof OscarRoomError ? err : new OscarRoomError('unavailable', 'room socket closed during sign-on');
    } finally {
      this.timers.clearTimeout(timer);
    }
  }

  send(html: string, opts: { whisperTo?: string; priority?: SendPriority } = {}): Promise<SendReceipt> {
    if (this.closed) return Promise.reject(new OscarSendError('closed'));
    if (!this.ready) return Promise.reject(new OscarSendError('room-not-joined'));
    const text = toAsciiEntities(html);
    if (Buffer.byteLength(text, 'ascii') > ROOM_MAX_TEXT_BYTES) return Promise.reject(new OscarSendError('too-long'));
    if (opts.whisperTo !== undefined && !this.names.has(normalizeScreenName(opts.whisperTo))) {
      return Promise.reject(new OscarSendError('recipient-unavailable'));
    }
    if (this.queue.length >= ROOM_QUEUE_MAX) return Promise.reject(new OscarSendError('rate-limited'));
    const cookie = this.newCookie();
    const rank = RANK[opts.priority ?? 'reply'];
    return new Promise<SendReceipt>((resolve, reject) => {
      const item: Pending = {
        cookie,
        body: encodeRoomSend({ cookie, text, whisperTo: opts.whisperTo }),
        rank,
        tries: 0,
        resolve,
        reject,
      };
      const at = this.queue.findIndex((q) => q.rank > rank);
      if (at === -1) this.queue.push(item);
      else this.queue.splice(at, 0, item);
      this.pump();
    });
  }

  close(): void {
    if (this.closed) return;
    this.handleClose({ clean: true });
    this.link.close();
  }

  private emit<E extends keyof ChatRoomEvents>(event: E, payload: ChatRoomEvents[E]): void {
    for (const fn of this.listeners[event]) fn(payload);
  }

  private pump(): void {
    if (this.closed || this.inflight || this.pumpTimer || this.queue.length === 0) return;
    const wait = Math.max(this.pacer.waitMs(), this.holdUntil - this.now());
    if (wait > 0) {
      this.pumpTimer = this.timers.setTimeout(() => {
        this.pumpTimer = null;
        this.pump();
      }, wait);
      return;
    }
    const item = this.queue.shift();
    if (!item) return;
    this.inflight = item;
    item.tries += 1;
    this.pacer.sent();
    this.link.send(FAMILY_CHAT, CHAT_MSG_TO_HOST, item.body);
    item.timer = this.timers.setTimeout(() => this.receiptMissing(item), ROOM_RECEIPT_TIMEOUT_MS);
  }

  private receiptMissing(item: Pending): void {
    if (this.inflight !== item) return;
    this.inflight = null;
    // a live socket with no reflection means the server dropped the send for rate; more sends push toward disconnect
    this.pacer.dropped();
    this.holdUntil = this.now() + ROOM_LIMITED_HOLD_MS;
    this.emit('rate', 'limited');
    if (item.tries >= 2) item.reject(new OscarSendError('rate-limited'));
    else this.queue.unshift(item);
    this.pump();
  }

  private handle(snac: SnacIn): void {
    if (this.closed) return;
    if (snac.family === FAMILY_CHAT && snac.subtype === CHAT_USERS_JOINED) {
      for (const user of decodeRoster(snac.body)) {
        const name = normalizeScreenName(user.name);
        const isNew = !this.names.has(name);
        this.names.set(name, user.name);
        if (this.ready && isNew && name !== this.self) this.emit('join', { name, display: user.name });
      }
      // another occupant's join notice can arrive ahead of the full roster; the full one always lists us
      if (!this.ready && this.names.has(this.self)) {
        this.ready = true;
        this.settleReady?.resolve(this.occupants());
      }
      return;
    }
    if (snac.family === FAMILY_CHAT && snac.subtype === CHAT_USERS_LEFT) {
      for (const user of decodeRoster(snac.body)) {
        const name = normalizeScreenName(user.name);
        if (this.names.delete(name) && this.ready) this.emit('leave', { name, display: user.name });
      }
      return;
    }
    if (snac.family === FAMILY_CHAT && snac.subtype === CHAT_MSG_TO_CLIENT) {
      this.handleMessage(snac.body);
      return;
    }
    if (snac.family === FAMILY_OSERVICE && snac.subtype === OSERVICE_RATE_PARAM_CHANGE) {
      const status = this.pacer.notice(snac.body);
      if (!status) return;
      if (status === 'limited') this.holdUntil = this.now() + ROOM_LIMITED_HOLD_MS;
      if (status === 'clear') {
        this.holdUntil = 0;
        if (this.pumpTimer) {
          this.timers.clearTimeout(this.pumpTimer);
          this.pumpTimer = null;
        }
      }
      this.emit('rate', status);
      this.pump();
    }
  }

  private handleMessage(body: Uint8Array): void {
    const msg = decodeRoomMessage(body);
    if (!msg) {
      this.log.debug('room message did not parse', { room: this.room.name });
      return;
    }
    const from = normalizeScreenName(msg.sender.name);
    if (from === ROOM_SERVER_SENDER) return;
    if (from === this.self) {
      const item = this.inflight;
      if (item && item.cookie === msg.cookie) {
        this.inflight = null;
        if (item.timer) this.timers.clearTimeout(item.timer);
        item.resolve({ id: msg.cookie.toString(16), storedOffline: false });
        this.pump();
        return;
      }
      // a reflection that lands after its timeout still proves the line went out; the queued retry would say it twice
      const at = this.queue.findIndex((q) => q.tries > 0 && q.cookie === msg.cookie);
      if (at !== -1) {
        const [late] = this.queue.splice(at, 1);
        late?.resolve({ id: msg.cookie.toString(16), storedOffline: false });
      }
      return;
    }
    this.emit('message', {
      from,
      fromDisplay: msg.sender.name,
      text: fromWireText(msg.text, msg.encoding),
      cookie: msg.cookie,
      whisper: !msg.isPublic,
    });
  }

  private handleClose(info: LinkClose): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pumpTimer) this.timers.clearTimeout(this.pumpTimer);
    this.pumpTimer = null;
    const waiting = this.inflight ? [this.inflight, ...this.queue] : this.queue;
    this.inflight = null;
    this.queue = [];
    for (const item of waiting) {
      if (item.timer) this.timers.clearTimeout(item.timer);
      item.reject(new OscarSendError('closed'));
    }
    if (!this.ready) this.settleReady?.reject(new OscarRoomError('unavailable', 'room socket closed during sign-on'));
    this.emit('closed', info);
  }
}
