import { ByteReader, ByteWriter, OscarDecodeError } from './bytes.js';
import { SNAC_FLAG_EXTENDED, SNAC_HEADER_LENGTH, USER_INFO_FLAGS } from './constants.js';
import { decodeTlvBlock, decodeTlvs, encodeTlvBlock, tlvU16 } from './tlv.js';
import type { Tlv } from './tlv.js';

export type Snac = { family: number; subtype: number; flags: number; requestId: number; body: Uint8Array };

export function encodeSnac(
  head: { family: number; subtype: number; requestId: number; flags?: number },
  body: Uint8Array = new Uint8Array(0),
): Uint8Array {
  return new ByteWriter()
    .u16(head.family)
    .u16(head.subtype)
    .u16(head.flags ?? 0)
    .u32(head.requestId)
    .bytes(body)
    .toBytes();
}

export function decodeSnac(payload: Uint8Array): Snac {
  if (payload.length < SNAC_HEADER_LENGTH) throw new OscarDecodeError('short SNAC header');
  const r = new ByteReader(payload);
  const family = r.u16();
  const subtype = r.u16();
  const flags = r.u16();
  const requestId = r.u32();
  // Flag 0x8000: a length-prefixed TLV block sits between the header and the body.
  if (flags & SNAC_FLAG_EXTENDED) r.bytes(r.u16());
  return { family, subtype, flags, requestId, body: r.rest() };
}

export type SnacError = { code: number; tlvs: Tlv[] };

export function decodeSnacError(body: Uint8Array): SnacError {
  const r = new ByteReader(body);
  const code = r.u16();
  return { code, tlvs: decodeTlvs(r.rest()) };
}

export type UserInfo = { name: string; warning: number; tlvs: Tlv[] };

export function decodeUserInfo(buf: Uint8Array, offset: number): { info: UserInfo; next: number } {
  const r = new ByteReader(buf, offset);
  const name = r.str8();
  const warning = r.u16();
  const block = decodeTlvBlock(buf, r.offset);
  return { info: { name, warning, tlvs: block.tlvs }, next: block.next };
}

export function encodeUserInfo(info: UserInfo): Uint8Array {
  return new ByteWriter().str8(info.name).u16(info.warning).bytes(encodeTlvBlock(info.tlvs)).toBytes();
}

export function userFlags(info: UserInfo): number {
  return tlvU16(info.tlvs, USER_INFO_FLAGS) ?? 0;
}
