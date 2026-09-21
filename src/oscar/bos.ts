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
  FOOD_GROUP_VERSION,
  ICBM_CHANNEL_IM,
  ICBM_FRAGMENT_CAPS,
  ICBM_FRAGMENT_CAPS_TEXT,
  ICBM_FRAGMENT_TEXT,
  ICBM_FRAGMENT_VERSION,
  ICBM_OFFLINE_RETRIEVE,
  ICBM_TLV_IM_DATA,
  ICBM_TLV_REQUEST_HOST_ACK,
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
  RATE_RECENT_MS,
  REQUEST_TIMEOUT_MS,
  SERVICE_TLV_COOKIE,
  SERVICE_TLV_RECONNECT_HERE,
  SERVICE_TLV_ROOM_INFO,
  SERVICE_TLV_SSL_STATE,
  SERVICE_TLV_USE_SSL,
  USER_FLAG_AWAY,
  USER_FLAG_BOT,
} from './constants.js';
import { ConnectionClosedError, RequestTimeoutError, parseHostPort } from './connection.js';
import type { OscarConnection } from './connection.js';
import { RateGovernor, decodeRateParamChange, decodeRateParamsReply } from './rate.js';
import type { RateStatus } from './rate.js';
import { decodeSnacError, decodeUserInfo, userFlags } from './snac.js';
import type { Snac, UserInfo } from './snac.js';
import { normalizeScreenName } from './text.js';
import { decodeTlvs, encodeTlvs, findTlv, tlv, tlvStr, tlvU8 } from './tlv.js';
import type { Tlv } from './tlv.js';
import type { Logger, Presence, TimerApi } from './types.js';

const BRING_UP_FAMILIES = [FAMILY_OSERVICE, FAMILY_LOCATE, FAMILY_BUDDY, FAMILY_ICBM];

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
  presence(e: { name: string } & Presence): void;
  rate(status: RateStatus): void;
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
  private buddies = new Set<string>();
  private lastRate: RateStatus = 'clear';

  constructor(
    readonly conn: OscarConnection,
    private readonly opts: BosOptions,
  ) {}

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
  }

  sawRateTrouble(): boolean {
    for (const governor of this.governors.values()) if (governor.troubledWithin(RATE_RECENT_MS)) return true;
    return false;
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
      if (snac.family === FAMILY_BUDDY && snac.subtype === BUDDY_ARRIVED) this.onBuddy(snac.body, true);
      else if (snac.family === FAMILY_BUDDY && snac.subtype === BUDDY_DEPARTED) this.onBuddy(snac.body, false);
      else if (snac.family === FAMILY_OSERVICE && snac.subtype === OSERVICE_RATE_PARAM_CHANGE) this.handleRateNotice(snac.body);
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

}
