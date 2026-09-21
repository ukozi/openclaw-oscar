import { randomBytes } from 'node:crypto';
import { ByteReader, ByteWriter } from './bytes.js';
import {
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
  ICBM_TLV_IM_DATA,
  ICBM_TLV_REQUEST_HOST_ACK,
  ICBM_TLV_STORE,
  LOCATE_TLV_AWAY_TEXT,
  LOCATE_TLV_CAPABILITIES,
  SERVICE_TLV_ROOM_INFO,
  SERVICE_TLV_USE_SSL,
} from './constants.js';
import { decodeUserInfo } from './snac.js';
import type { UserInfo } from './snac.js';
import { decodeTlvs, encodeTlvs, tlv } from './tlv.js';
import type { Tlv } from './tlv.js';

const BRING_UP_FAMILIES = [FAMILY_OSERVICE, FAMILY_LOCATE, FAMILY_BUDDY, FAMILY_ICBM];

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
