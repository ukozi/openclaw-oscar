import { ByteReader, ByteWriter, OscarDecodeError, concatBytes } from './bytes.js';
import {
  FLAP_HEADER_LENGTH,
  FLAP_MAX_PAYLOAD,
  FLAP_SIGNOFF,
  FLAP_START,
  FLAP_VERSION,
} from './constants.js';
import { decodeTlvs, writeTlvs } from './tlv.js';
import type { Tlv } from './tlv.js';

export type FlapFrame = { type: number; seq: number; payload: Uint8Array; truncated?: boolean };

export function encodeFlap(type: number, seq: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  if (payload.length > FLAP_MAX_PAYLOAD) throw new RangeError('FLAP payload too large');
  return new ByteWriter()
    .u8(FLAP_START)
    .u8(type)
    .u16(seq & 0xffff)
    .u16(payload.length)
    .bytes(payload)
    .toBytes();
}

export function encodeSignonPayload(tlvs: readonly Tlv[] = []): Uint8Array {
  const w = new ByteWriter().u32(FLAP_VERSION);
  writeTlvs(w, tlvs);
  return w.toBytes();
}

export function decodeSignonPayload(payload: Uint8Array): { version: number; tlvs: Tlv[] } {
  const r = new ByteReader(payload);
  const version = r.u32();
  return { version, tlvs: decodeTlvs(r.rest()) };
}

export class FlapDecoder {
  private buf: Uint8Array = new Uint8Array(0);

  push(chunk: Uint8Array): FlapFrame[] {
    this.buf = this.buf.length === 0 ? chunk : concatBytes([this.buf, chunk]);
    const frames: FlapFrame[] = [];
    while (this.buf.length >= FLAP_HEADER_LENGTH) {
      if (this.buf[0] !== FLAP_START) throw new OscarDecodeError('bad FLAP start marker');
      const r = new ByteReader(this.buf);
      r.u8();
      const type = r.u8();
      const seq = r.u16();
      const length = r.u16();
      if (r.remaining < length) break;
      frames.push({ type, seq, payload: r.bytes(length).slice() });
      this.buf = this.buf.subarray(FLAP_HEADER_LENGTH + length);
    }
    if (this.buf.length > 0 && this.buf[0] !== FLAP_START) throw new OscarDecodeError('bad FLAP start marker');
    return frames;
  }

  // A server-closed connection whose instance has multi-conn flag 0, and every
  // chat connection, ends with `2A 04 seq seq` and EOF: a signoff with no length field.
  end(): FlapFrame | null {
    const b = this.buf;
    this.buf = new Uint8Array(0);
    if (b.length === 4 && b[0] === FLAP_START && b[1] === FLAP_SIGNOFF) {
      return { type: FLAP_SIGNOFF, seq: ((b[2] ?? 0) << 8) | (b[3] ?? 0), payload: new Uint8Array(0), truncated: true };
    }
    if (b.length > 0) throw new OscarDecodeError(`connection closed inside a FLAP frame (${b.length} bytes left)`);
    return null;
  }
}
