import { ByteReader, ByteWriter } from './bytes.js';

export type Tlv = { tag: number; value: Uint8Array };

export const tlv = {
  bytes(tag: number, value: Uint8Array): Tlv {
    return { tag, value };
  },
  empty(tag: number): Tlv {
    return { tag, value: new Uint8Array(0) };
  },
  str(tag: number, value: string): Tlv {
    return { tag, value: new Uint8Array(Buffer.from(value, 'utf8')) };
  },
  u8(tag: number, value: number): Tlv {
    return { tag, value: new ByteWriter().u8(value).toBytes() };
  },
  u16(tag: number, value: number): Tlv {
    return { tag, value: new ByteWriter().u16(value).toBytes() };
  },
  u32(tag: number, value: number): Tlv {
    return { tag, value: new ByteWriter().u32(value).toBytes() };
  },
};

export function writeTlvs(w: ByteWriter, list: readonly Tlv[]): void {
  for (const t of list) {
    if (t.value.length > 0xffff) throw new RangeError(`TLV 0x${t.tag.toString(16)} longer than 65535 bytes`);
    w.u16(t.tag).u16(t.value.length).bytes(t.value);
  }
}

export function encodeTlvs(list: readonly Tlv[]): Uint8Array {
  const w = new ByteWriter();
  writeTlvs(w, list);
  return w.toBytes();
}

export function readTlv(r: ByteReader): Tlv {
  const tag = r.u16();
  return { tag, value: r.bytes(r.u16()) };
}

export function decodeTlvs(bytes: Uint8Array): Tlv[] {
  const r = new ByteReader(bytes);
  const out: Tlv[] = [];
  while (r.remaining > 0) out.push(readTlv(r));
  return out;
}

export function encodeTlvBlock(list: readonly Tlv[]): Uint8Array {
  const w = new ByteWriter().u16(list.length);
  writeTlvs(w, list);
  return w.toBytes();
}

export function decodeTlvBlock(buf: Uint8Array, offset: number): { tlvs: Tlv[]; next: number } {
  const r = new ByteReader(buf, offset);
  const count = r.u16();
  const tlvs: Tlv[] = [];
  for (let i = 0; i < count; i++) tlvs.push(readTlv(r));
  return { tlvs, next: r.offset };
}

export function findTlv(list: readonly Tlv[], tag: number): Uint8Array | undefined {
  return list.find((t) => t.tag === tag)?.value;
}

export function hasTlv(list: readonly Tlv[], tag: number): boolean {
  return list.some((t) => t.tag === tag);
}

export function tlvU8(list: readonly Tlv[], tag: number): number | undefined {
  const v = findTlv(list, tag);
  return v && v.length >= 1 ? v[0] : undefined;
}

export function tlvU16(list: readonly Tlv[], tag: number): number | undefined {
  const v = findTlv(list, tag);
  return v && v.length >= 2 ? new ByteReader(v).u16() : undefined;
}

export function tlvU32(list: readonly Tlv[], tag: number): number | undefined {
  const v = findTlv(list, tag);
  return v && v.length >= 4 ? new ByteReader(v).u32() : undefined;
}

export function tlvStr(list: readonly Tlv[], tag: number): string | undefined {
  const v = findTlv(list, tag);
  return v ? Buffer.from(v).toString('utf8') : undefined;
}
