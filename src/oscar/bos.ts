import { randomBytes } from 'node:crypto';
import { ByteReader, ByteWriter } from './bytes.js';
import {
  BUDDY_ADD_BUDDIES,
  BUDDY_ARRIVED,
  BUDDY_DEL_BUDDIES,
  BUDDY_DEPARTED,
  CAPABILITY_LENGTH,
  CAP_CHAT,
  CLIENT_TOOL_ID,
  CLIENT_TOOL_VERSION,
  FAMILY_BUDDY,
  FAMILY_ICBM,
  FAMILY_LOCATE,
  FAMILY_OSERVICE,
  FLAP_MAX_PAYLOAD,
  FOOD_GROUP_VERSION,
  ICBM_CHANNEL_IM,
  ICBM_CHANNEL_RENDEZVOUS,
  ICBM_CLIENT_EVENT,
  ICBM_ERR,
  ICBM_ERROR_NOT_LOGGED_ON,
  ICBM_EVENT_NONE,
  ICBM_EVENT_TYPED,
  ICBM_EVENT_TYPING,
  ICBM_FRAGMENT_CAPS,
  ICBM_FRAGMENT_CAPS_TEXT,
  ICBM_FRAGMENT_TEXT,
  ICBM_FRAGMENT_VERSION,
  ICBM_HOST_ACK,
  ICBM_MSG_TO_CLIENT,
  ICBM_MSG_TO_HOST,
  ICBM_OFFLINE_RETRIEVE,
  ICBM_TLV_AUTO_RESPONSE,
  ICBM_TLV_IM_DATA,
  ICBM_TLV_REQUEST_HOST_ACK,
  ICBM_TLV_RENDEZVOUS,
  ICBM_TLV_SEND_TIME,
  ICBM_TLV_STORE,
  LOCATE_SET_INFO,
  LOCATE_TLV_AWAY_TEXT,
  LOCATE_TLV_CAPABILITIES,
  OSERVICE_CLIENT_ONLINE,
  OSERVICE_CLIENT_VERSIONS,
  OSERVICE_ERR,
  OSERVICE_HOST_ONLINE,
  OSERVICE_RATE_PARAMS_QUERY,
  OSERVICE_RATE_PARAMS_REPLY,
  OSERVICE_RATE_PARAMS_SUB_ADD,
  OSERVICE_RATE_PARAM_CHANGE,
  OSERVICE_SERVICE_REQUEST,
  OSERVICE_SERVICE_RESPONSE,
  OSERVICE_USER_INFO_QUERY,
  OSERVICE_USER_INFO_UPDATE,
  RATE_CLASS_IM,
  RATE_RECENT_MS,
  RDV_FRAGMENT_MIN_BYTES,
  RDV_TLV_CHARSET,
  RDV_TLV_INVITATION,
  RDV_TLV_SERVICE_DATA,
  RDV_TYPE_PROPOSE,
  RECEIPT_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
  SERVICE_TLV_COOKIE,
  SERVICE_TLV_RECONNECT_HERE,
  SERVICE_TLV_ROOM_INFO,
  SERVICE_TLV_SSL_STATE,
  SERVICE_TLV_USE_SSL,
  SYSTEM_SENDER,
  USER_FLAG_AWAY,
  USER_FLAG_BOT,
} from './constants.js';
import { ConnectionClosedError, RequestTimeoutError, parseHostPort } from './connection.js';
import type { OscarConnection } from './connection.js';
import { roomFromCookie } from './chatnav.js';
import { RateGovernor, decodeRateParamChange, decodeRateParamsReply } from './rate.js';
import type { RateStatus } from './rate.js';
import { decodeSnacError, decodeUserInfo, userFlags } from './snac.js';
import type { Snac, UserInfo } from './snac.js';
import { encodeImText, fromWireText, normalizeScreenName } from './text.js';
import { decodeTlvs, encodeTlvs, findTlv, hasTlv, tlv, tlvStr, tlvU32, tlvU8 } from './tlv.js';
import type { Tlv } from './tlv.js';
import { OscarSendError } from './types.js';
import type { ImEvent, InviteEvent, Logger, Presence, SendReceipt, TimerApi } from './types.js';

const BRING_UP_FAMILIES = [FAMILY_OSERVICE, FAMILY_LOCATE, FAMILY_BUDDY, FAMILY_ICBM];
const IM_OVERHEAD_BYTES = 512;

export type ServiceRedirect = { host: string; port: number; cookie: Uint8Array; ssl: boolean };

export class ServiceRefusedError extends Error {
  readonly code: number;

  constructor(code: number) {
    super(`service request refused (0x${code.toString(16)})`);
    this.name = 'ServiceRefusedError';
    this.code = code;
  }
}

export type BosCallbacks = {
  im(e: ImEvent): void;
  presence(e: { name: string } & Presence): void;
  rate(status: RateStatus): void;
  channel2(icbmBody: Uint8Array): void;
};

export type BosOptions = {
  log: Logger;
  now: () => number;
  timers: TimerApi;
  defaultPort: number;
  callbacks: BosCallbacks;
};

export function decodeImFragments(data: Uint8Array): { charset: number; text: Uint8Array }[] {
  const r = new ByteReader(data);
  const out: { charset: number; text: Uint8Array }[] = [];
  while (r.remaining > 0) {
    const id = r.u8();
    r.u8();
    const payload = new ByteReader(r.bytes(r.u16()));
    if (id !== ICBM_FRAGMENT_TEXT) continue;
    const charset = payload.u16();
    payload.u16();
    out.push({ charset, text: payload.rest() });
  }
  return out;
}

export function encodeImFragments(charset: number, text: Uint8Array): Uint8Array {
  return new ByteWriter()
    .u8(ICBM_FRAGMENT_CAPS)
    .u8(ICBM_FRAGMENT_VERSION)
    .u16(ICBM_FRAGMENT_CAPS_TEXT.length)
    .bytes(ICBM_FRAGMENT_CAPS_TEXT)
    .u8(ICBM_FRAGMENT_TEXT)
    .u8(ICBM_FRAGMENT_VERSION)
    .u16(4 + text.length)
    .u16(charset)
    .u16(0)
    .bytes(text)
    .toBytes();
}

export function newCookie(): bigint {
  // Cookie 0 means "no id" on this server: TOC clients and server notices all use it.
  for (;;) {
    const cookie = new ByteReader(new Uint8Array(randomBytes(8))).u64();
    if (cookie !== 0n) return cookie;
  }
}

export function encodeClientVersions(): Uint8Array {
  const w = new ByteWriter();
  for (const family of BRING_UP_FAMILIES) w.u16(family).u16(FOOD_GROUP_VERSION);
  return w.toBytes();
}

export function encodeClientOnline(): Uint8Array {
  const w = new ByteWriter();
  for (const family of BRING_UP_FAMILIES) w.u16(family).u16(FOOD_GROUP_VERSION).u16(CLIENT_TOOL_ID).u16(CLIENT_TOOL_VERSION);
  return w.toBytes();
}

export function encodeNameList(names: readonly string[]): Uint8Array {
  const w = new ByteWriter();
  for (const name of names) w.str8(name);
  return w.toBytes();
}

export function encodeCapabilities(): Uint8Array {
  // A caps TLV that is not a multiple of 16 bytes drops the connection server-side.
  if (CAP_CHAT.length % CAPABILITY_LENGTH !== 0) throw new Error('capability block must be a multiple of 16 bytes');
  return encodeTlvs([tlv.bytes(LOCATE_TLV_CAPABILITIES, CAP_CHAT)]);
}

export function encodeAway(text: string | null): Uint8Array {
  return encodeTlvs([tlv.str(LOCATE_TLV_AWAY_TEXT, text ?? '')]);
}

export function encodeImToHost(cookie: bigint, to: string, charset: number, text: Uint8Array, store: boolean): Uint8Array {
  const tlvs = [tlv.bytes(ICBM_TLV_IM_DATA, encodeImFragments(charset, text)), tlv.empty(ICBM_TLV_REQUEST_HOST_ACK)];
  if (store) tlvs.push(tlv.empty(ICBM_TLV_STORE));
  return new ByteWriter().u64(cookie).u16(ICBM_CHANNEL_IM).str8(to).bytes(encodeTlvs(tlvs)).toBytes();
}

export function encodeTyping(to: string, event: number): Uint8Array {
  return new ByteWriter().u64(0n).u16(ICBM_CHANNEL_IM).str8(to).u16(event).toBytes();
}

export function encodeServiceRequest(family: number, req: { useSsl: boolean; roomInfo?: Uint8Array }): Uint8Array {
  const tlvs: Tlv[] = [];
  if (req.roomInfo) tlvs.push(tlv.bytes(SERVICE_TLV_ROOM_INFO, req.roomInfo));
  if (req.useSsl) tlvs.push(tlv.empty(SERVICE_TLV_USE_SSL));
  return new ByteWriter().u16(family).bytes(encodeTlvs(tlvs)).toBytes();
}

export type InboundMessage = { cookie: bigint; channel: number; sender: UserInfo; tlvs: Tlv[] };

export function decodeImToClient(body: Uint8Array): InboundMessage {
  const r = new ByteReader(body);
  const cookie = r.u64();
  const channel = r.u16();
  const { info, next } = decodeUserInfo(body, r.offset);
  return { cookie, channel, sender: info, tlvs: decodeTlvs(body.subarray(next)) };
}

export class BosClient {
  private readonly governors = new Map<number, RateGovernor>();
  private classOf: (family: number, subtype: number) => number | undefined = () => undefined;
  private exempt = false;
  private readonly presence = new Map<string, Presence>();
  private readonly sleepers = new Set<() => void>();
  private readonly lateAcks = new Map<bigint, () => void>();
  private buddies = new Set<string>();
  private lastRate: RateStatus = 'clear';

  constructor(
    readonly conn: OscarConnection,
    private readonly opts: BosOptions,
  ) {
    conn.onClose(() => this.wakeSleepers());
  }

  async bringUp(buddies: readonly string[]): Promise<{ screenName: string; bot: boolean }> {
    await this.waitForHostOnline();
    this.conn.onSnac((snac) => this.dispatch(snac));

    await this.ask(FAMILY_OSERVICE, OSERVICE_CLIENT_VERSIONS, encodeClientVersions());

    const rates = await this.ask(FAMILY_OSERVICE, OSERVICE_RATE_PARAMS_QUERY);
    if (rates.subtype === OSERVICE_RATE_PARAMS_REPLY) {
      const reply = decodeRateParamsReply(rates.body);
      this.classOf = reply.classOf;
      for (const params of reply.classes) {
        const governor = new RateGovernor({ now: this.opts.now });
        governor.seed(params);
        this.governors.set(params.id, governor);
      }
    }
    const classIds = new ByteWriter();
    for (const id of this.governors.keys()) classIds.u16(id);
    this.send(FAMILY_OSERVICE, OSERVICE_RATE_PARAMS_SUB_ADD, classIds.toBytes());

    this.send(FAMILY_LOCATE, LOCATE_SET_INFO, encodeCapabilities());

    // Sent even when empty: only this (or a feedbag) makes the server announce the account as online.
    this.buddies = new Set(this.cleanNames(buddies));
    this.send(FAMILY_BUDDY, BUDDY_ADD_BUDDIES, encodeNameList([...this.buddies]));

    this.send(FAMILY_OSERVICE, OSERVICE_CLIENT_ONLINE, encodeClientOnline());

    const info = await this.ask(FAMILY_OSERVICE, OSERVICE_USER_INFO_QUERY);
    if (info.subtype !== OSERVICE_USER_INFO_UPDATE) throw new Error('no user info reply');
    const self = decodeUserInfo(info.body, 0).info;
    const bot = (userFlags(self) & USER_FLAG_BOT) !== 0;
    // The operator-set bot flag exempts the BOS session from rate limits server-side.
    this.exempt = bot;

    // Only after ClientOnline: v0.24.0 deletes the stored queue even when no live instance got the replay.
    this.ask(FAMILY_ICBM, ICBM_OFFLINE_RETRIEVE).catch((error: unknown) => {
      this.opts.log.warn('offline retrieve got no reply', { error: (error as Error).message });
    });
    return { screenName: self.name, bot };
  }

  private waitForHostOnline(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let offSnac = (): void => {};
      let offClose = (): void => {};
      const done = (error?: Error): void => {
        if (settled) return;
        settled = true;
        this.opts.timers.clearTimeout(timer);
        offSnac();
        offClose();
        if (error) reject(error);
        else resolve();
      };
      const timer = this.opts.timers.setTimeout(() => done(new RequestTimeoutError()), REQUEST_TIMEOUT_MS);
      offSnac = this.conn.onSnac((snac) => {
        if (snac.family === FAMILY_OSERVICE && snac.subtype === OSERVICE_HOST_ONLINE) done();
      });
      offClose = this.conn.onClose((info) => done(new ConnectionClosedError(info)));
      if (settled) {
        offSnac();
        offClose();
      }
    });
  }

  private governorFor(family: number, subtype: number, fallbackClass?: number): RateGovernor | undefined {
    if (this.exempt) return undefined;
    return this.governors.get(this.classOf(family, subtype) ?? fallbackClass ?? -1);
  }

  private account(family: number, subtype: number): void {
    this.governorFor(family, subtype)?.sent();
    this.publishRate();
  }

  private send(family: number, subtype: number, body?: Uint8Array): void {
    this.conn.send(family, subtype, body);
    this.account(family, subtype);
  }

  private ask(family: number, subtype: number, body?: Uint8Array, timeoutMs?: number): Promise<Snac> {
    const reply = this.conn.request(family, subtype, body, timeoutMs);
    this.account(family, subtype);
    return reply;
  }

  private publishRate(): void {
    let worst: RateStatus = 'clear';
    for (const governor of this.exempt ? [] : this.governors.values()) {
      const s = governor.status();
      if (s === 'limited') worst = 'limited';
      else if (s === 'alert' && worst === 'clear') worst = 'alert';
    }
    if (worst === this.lastRate) return;
    this.lastRate = worst;
    this.opts.callbacks.rate(worst);
  }

  // At v0.24.0 a BOS rate notice can arrive on the ChatNav socket, so this is public for the room code to call.
  handleRateNotice(body: Uint8Array): void {
    const { code, params } = decodeRateParamChange(body);
    let governor = this.governors.get(params.id);
    if (!governor) {
      governor = new RateGovernor({ now: this.opts.now });
      this.governors.set(params.id, governor);
    }
    governor.notice(code, params);
    this.publishRate();
    this.wakeSleepers();
  }

  private wakeSleepers(): void {
    for (const wake of [...this.sleepers]) wake();
  }

  sawRateTrouble(): boolean {
    for (const governor of this.governors.values()) if (governor.troubledWithin(RATE_RECENT_MS)) return true;
    return false;
  }

  private async waitForRate(governor: RateGovernor | undefined, settled: () => boolean = () => false): Promise<void> {
    for (;;) {
      if (settled()) return;
      if (!this.conn.isOpen) throw new OscarSendError('closed');
      const delay = governor?.waitMs() ?? 0;
      if (delay <= 0) return;
      await new Promise<void>((resolve) => {
        const wake = (): void => {
          this.opts.timers.clearTimeout(timer);
          this.sleepers.delete(wake);
          resolve();
        };
        const timer = this.opts.timers.setTimeout(wake, delay);
        this.sleepers.add(wake);
      });
    }
  }

  private cleanNames(names: readonly string[]): string[] {
    const out = new Set<string>();
    for (const raw of names) {
      const name = normalizeScreenName(raw);
      if (name.length > 0 && Buffer.byteLength(name, 'utf8') <= 0xff) out.add(name);
    }
    return [...out];
  }

  setBuddies(names: readonly string[]): void {
    const want = new Set(this.cleanNames(names));
    const added = [...want].filter((n) => !this.buddies.has(n));
    const removed = [...this.buddies].filter((n) => !want.has(n));
    if (added.length > 0) this.send(FAMILY_BUDDY, BUDDY_ADD_BUDDIES, encodeNameList(added));
    if (removed.length > 0) this.send(FAMILY_BUDDY, BUDDY_DEL_BUDDIES, encodeNameList(removed));
    for (const name of removed) this.presence.delete(name);
    this.buddies = want;
  }

  presenceOf(name: string): Presence | undefined {
    return this.presence.get(normalizeScreenName(name));
  }

  async sendIm(to: string, html: string): Promise<SendReceipt> {
    const { charset, bytes } = encodeImText(html);
    if (bytes.length + IM_OVERHEAD_BYTES > FLAP_MAX_PAYLOAD) throw new OscarSendError('too-long');
    if (Buffer.byteLength(to, 'utf8') === 0 || Buffer.byteLength(to, 'utf8') > 0xff) {
      throw new OscarSendError('recipient-unavailable', 'bad screen name');
    }
    const cookie = newCookie();
    const governor = this.governorFor(FAMILY_ICBM, ICBM_MSG_TO_HOST, RATE_CLASS_IM);
    // At v0.24.0 the store TLV reaches an online recipient, whose client may then show us as offline.
    let store = this.presenceOf(to)?.online === false;
    let resentWithStore = false;
    let retriedAfterDrop = false;
    let ackedLate = false;
    const receipt = (): SendReceipt => ({ id: cookie.toString(16).padStart(16, '0'), storedOffline: store });
    try {
      for (;;) {
        await this.waitForRate(governor, () => ackedLate);
        if (ackedLate) return receipt();
        const body = encodeImToHost(cookie, to, charset, bytes, store);
        let reply: Snac;
        try {
          reply = await this.ask(FAMILY_ICBM, ICBM_MSG_TO_HOST, body, RECEIPT_TIMEOUT_MS);
        } catch (error) {
          if (!(error instanceof RequestTimeoutError)) throw new OscarSendError('closed');
          // No ack and no error on a live socket: the limiter dropped it. Dropped SNACs still lower the
          // server's average, so wait for the model or a clear notice, then try once more with the same cookie.
          governor?.dropped();
          this.publishRate();
          if (retriedAfterDrop) throw new OscarSendError('rate-limited');
          retriedAfterDrop = true;
          // An ack that lands during that wait still proves the IM went out; the retry would say it twice.
          this.lateAcks.set(cookie, () => {
            ackedLate = true;
            this.wakeSleepers();
          });
          continue;
        }
        if (reply.family === FAMILY_ICBM && reply.subtype === ICBM_HOST_ACK) return receipt();
        const code = reply.subtype === ICBM_ERR ? decodeSnacError(reply.body).code : -1;
        if (code === ICBM_ERROR_NOT_LOGGED_ON && !store && !resentWithStore) {
          store = true;
          resentWithStore = true;
          continue;
        }
        throw new OscarSendError('recipient-unavailable', `send refused (0x${(code >>> 0).toString(16)})`);
      }
    } finally {
      this.lateAcks.delete(cookie);
    }
  }

  // Outbound only, and that is all it can be over OSCAR. The server appends the "want events"
  // TLV 0x0B to the IMs we send only while Session.TypingEventsEnabled() is true
  // (foodgroup/icbm.go:201-204), and the one OSCAR setter for that flag is setSessionBuddyPrefs,
  // which reads FeedbagBuddyPrefsDiscloseTyping off a FeedbagClassIdBuddyPrefs item
  // (foodgroup/feedbag.go:1004-1013 -> state/session.go:863-867). We carry a client-side buddy
  // list and send no feedbag item, so the flag stays false, peers never see 0x0B, and a
  // well-behaved client will not send us typing notifications. Our own ClientEvent is relayed
  // regardless (foodgroup/icbm.go:415-441). Inbound typing needs a feedbag BuddyPrefs item first.
  sendTyping(to: string, state: 'typing' | 'typed' | 'none'): void {
    if (!this.conn.isOpen) return;
    if (this.governorFor(FAMILY_ICBM, ICBM_CLIENT_EVENT)?.status() === 'limited') return;
    const event = state === 'typing' ? ICBM_EVENT_TYPING : state === 'typed' ? ICBM_EVENT_TYPED : ICBM_EVENT_NONE;
    this.send(FAMILY_ICBM, ICBM_CLIENT_EVENT, encodeTyping(to, event));
  }

  // Away is driven through Locate only. A status bitmask is never sent: at main, leaving an
  // "unavailable" status wipes the Locate away text.
  //
  // Setting a non-empty away text also sets OServiceUserFlagUnavailable on this instance
  // (foodgroup/locate.go:113-120), which makes SessionInstance.active() false
  // (state/session.go:1181-1193). ChannelMsgToHost routes on Session.Inactive()
  // (foodgroup/icbm.go:205-223): if any other instance of this account is signed on and is
  // neither idle nor away, delivery goes through RelayToScreenNameActiveOnly, which skips every
  // inactive instance (state/session_manager.go:190-203) - so while we are away we would receive
  // nothing, silently, with no error and no offline store. When ours is the only instance,
  // Inactive() is true and delivery falls back to RelayToScreenName, so the single-instance case
  // is unaffected. Same at v0.24.0. A bot that must keep receiving should not set away text while
  // another instance of the same name is online.
  setAway(text: string | null): void {
    this.send(FAMILY_LOCATE, LOCATE_SET_INFO, encodeAway(text));
  }

  async requestService(family: number, req: { useSsl: boolean; roomInfo?: Uint8Array }): Promise<ServiceRedirect> {
    const reply = await this.ask(FAMILY_OSERVICE, OSERVICE_SERVICE_REQUEST, encodeServiceRequest(family, req));
    if (reply.subtype !== OSERVICE_SERVICE_RESPONSE) {
      throw new ServiceRefusedError(reply.subtype === OSERVICE_ERR ? decodeSnacError(reply.body).code : 0);
    }
    const out = decodeTlvs(reply.body);
    const where = tlvStr(out, SERVICE_TLV_RECONNECT_HERE);
    const cookie = findTlv(out, SERVICE_TLV_COOKIE);
    if (!where || !cookie) throw new ServiceRefusedError(0);
    return { ...parseHostPort(where, this.opts.defaultPort), cookie, ssl: (tlvU8(out, SERVICE_TLV_SSL_STATE) ?? 0) !== 0 };
  }

  private dispatch(snac: Snac): void {
    try {
      if (snac.family === FAMILY_ICBM && snac.subtype === ICBM_MSG_TO_CLIENT) this.onMessage(snac.body);
      else if (snac.family === FAMILY_BUDDY && snac.subtype === BUDDY_ARRIVED) this.onBuddy(snac.body, true);
      else if (snac.family === FAMILY_BUDDY && snac.subtype === BUDDY_DEPARTED) this.onBuddy(snac.body, false);
      else if (snac.family === FAMILY_OSERVICE && snac.subtype === OSERVICE_RATE_PARAM_CHANGE) this.handleRateNotice(snac.body);
      else if (snac.family === FAMILY_ICBM && snac.subtype === ICBM_HOST_ACK) this.lateAcks.get(new ByteReader(snac.body).u64())?.();
    } catch (error) {
      this.opts.log.warn('dropped an unreadable SNAC', {
        family: snac.family,
        subtype: snac.subtype,
        error: (error as Error).message,
      });
    }
  }

  private onBuddy(body: Uint8Array, online: boolean): void {
    const { info } = decodeUserInfo(body, 0);
    const name = normalizeScreenName(info.name);
    const flags = userFlags(info);
    const presence: Presence = {
      online,
      away: online && (flags & USER_FLAG_AWAY) !== 0,
      bot: online && (flags & USER_FLAG_BOT) !== 0,
      at: this.opts.now(),
    };
    this.presence.set(name, presence);
    this.opts.callbacks.presence({ name, ...presence });
  }

  private onMessage(body: Uint8Array): void {
    // Channel 2 goes to the room code whole and before the strict decode below: its invite parser
    // forgives TLVs that other clients cut short, and an invite must never surface as an IM.
    if (body.length >= 10 && (((body[8] ?? 0) << 8) | (body[9] ?? 0)) === ICBM_CHANNEL_RENDEZVOUS) {
      this.opts.callbacks.channel2(body);
      return;
    }
    const { cookie, channel, sender, tlvs } = decodeImToClient(body);
    const from = normalizeScreenName(sender.name);
    if (channel !== ICBM_CHANNEL_IM) return;
    const data = findTlv(tlvs, ICBM_TLV_IM_DATA);
    if (!data) return;
    const text = decodeImFragments(data)
      .map((f) => fromWireText(f.text, f.charset))
      .join('');
    const sentAt = tlvU32(tlvs, ICBM_TLV_SEND_TIME);
    const event: ImEvent = {
      from,
      fromDisplay: sender.name,
      text,
      cookie,
      autoResponse: hasTlv(tlvs, ICBM_TLV_AUTO_RESPONSE),
      // Display and ordering only: v0.24.0 forwards a sender-supplied send time on live messages.
      offline: sentAt !== undefined,
      // Server notices come from this literal name with an empty user-info block, cookie 0 and no send time.
      // An offline replay has an empty block too, so a stored message from an account that took the name
      // would pass without the last check; the server stamps the send time on every replay.
      system: from === SYSTEM_SENDER && sender.tlvs.length === 0 && cookie === 0n && sentAt === undefined,
    };
    if (sentAt !== undefined) event.sentAt = sentAt * 1000;
    this.opts.callbacks.im(event);
  }
}

function tolerantTlvs(buf: Buffer): Tlv[] {
  const out: Tlv[] = [];
  let at = 0;
  while (at + 4 <= buf.length) {
    const tag = buf.readUInt16BE(at);
    const len = buf.readUInt16BE(at + 2);
    if (at + 4 + len > buf.length) break;
    out.push({ tag, value: buf.subarray(at + 4, at + 4 + len) });
    at += 4 + len;
  }
  return out;
}

export function parseInvite(icbmBody: Uint8Array): InviteEvent | null {
  const b = Buffer.from(icbmBody.buffer, icbmBody.byteOffset, icbmBody.byteLength);
  if (b.length < 10 || b.readUInt16BE(8) !== ICBM_CHANNEL_RENDEZVOUS) return null;
  let fragment: Uint8Array | undefined;
  let display: string;
  try {
    const { info, next } = decodeUserInfo(b, 10);
    display = info.name;
    fragment = findTlv(tolerantTlvs(b.subarray(next)), ICBM_TLV_RENDEZVOUS);
  } catch {
    return null;
  }
  if (!fragment || fragment.length < RDV_FRAGMENT_MIN_BYTES) return null;
  const f = Buffer.from(fragment.buffer, fragment.byteOffset, fragment.byteLength);
  if (f.readUInt16BE(0) !== RDV_TYPE_PROPOSE) return null;
  if (!f.subarray(10, 26).equals(Buffer.from(CAP_CHAT))) return null;
  const inner = tolerantTlvs(f.subarray(RDV_FRAGMENT_MIN_BYTES));
  const data = findTlv(inner, RDV_TLV_SERVICE_DATA);
  if (!data || data.length < 3) return null;
  const d = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const exchange = d.readUInt16BE(0);
  const len = d.readUInt8(2);
  if (d.length < 3 + len) return null;
  const roomCookie = d.toString('utf8', 3, 3 + len);
  const ref = roomFromCookie(roomCookie);
  if (!ref || (exchange !== 4 && exchange !== 5)) return null;
  const charset = findTlv(inner, RDV_TLV_CHARSET);
  const text = findTlv(inner, RDV_TLV_INVITATION);
  return {
    from: normalizeScreenName(display),
    fromDisplay: display,
    room: { exchange, name: ref.name },
    roomCookie,
    text: text ? fromWireText(text, charset ? Buffer.from(charset).toString('ascii') : undefined) : '',
  };
}
