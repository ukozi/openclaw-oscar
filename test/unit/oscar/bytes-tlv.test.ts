import { describe, expect, it } from 'vitest';
import { ByteReader, ByteWriter, OscarDecodeError, fromHex, toHex } from '../../../src/oscar/bytes.js';
import { decodeTlvBlock, decodeTlvs, encodeTlvBlock, encodeTlvs, findTlv, hasTlv, tlv, tlvStr, tlvU16, tlvU32, tlvU8 } from '../../../src/oscar/tlv.js';
import { bytesOf, loadVectors, vector } from './vectors.js';

const tlvs = loadVectors('tlv.json');

describe('vector files', () => {
  it.each(['flap.json', 'snac.json', 'tlv.json', 'auth.json', 'oservice.json', 'icbm.json', 'locate-buddy.json'])('%s names its source', (file) => {
    expect(loadVectors(file).source).toContain('open-oscar-server 7bdd674afc482d700cc733be7c0b86a51f65883a');
  });
});

describe('bytes', () => {
  it('writes and reads big-endian integers and prefixed strings', () => {
    const bytes = new ByteWriter().u8(0x2a).u16(0x0102).u32(0x80000001).u64(0x1122334455667788n).str8('héllo').str16('key').toBytes();
    expect(toHex(bytes)).toBe('2a0102800000011122334455667788' + '0668c3a96c6c6f' + '00036b6579');
    const r = new ByteReader(bytes);
    expect([r.u8(), r.u16(), r.u32(), r.u64(), r.str8(), r.str16(), r.remaining]).toEqual([0x2a, 0x0102, 0x80000001, 0x1122334455667788n, 'héllo', 'key', 0]);
  });

  it('reads from an offset and says where it stopped', () => {
    const r = new ByteReader(fromHex('aabb0102'), 2);
    expect([r.offset, r.u16(), r.offset, r.remaining]).toEqual([2, 0x0102, 4, 0]);
    expect(() => new ByteReader(fromHex('aabb'), 3)).toThrow(OscarDecodeError);
    expect(() => new ByteReader(fromHex('aabb'), -1)).toThrow(OscarDecodeError);
  });

  it('throws a decode error instead of reading past the end', () => {
    expect(() => new ByteReader(fromHex('00')).u16()).toThrow(OscarDecodeError);
    expect(() => new ByteReader(fromHex('05616c')).str8()).toThrow(OscarDecodeError);
  });

  it('refuses a string that does not fit its length prefix', () => {
    expect(() => new ByteWriter().str8('x'.repeat(256))).toThrow(RangeError);
  });
});

describe('TLV', () => {
  const rows: [string, ReturnType<typeof tlv.u8>][] = [
    ['u8', tlv.u8(0x4a, 3)],
    ['u16', tlv.u16(0x08, 0x001d)],
    ['u32', tlv.u32(0x16, 1790000000)],
    ['string', tlv.str(0x01, 'botone')],
    ['empty', tlv.empty(0x03)],
  ];
  it.each(rows)('encodes %s like the server', (name, value) => {
    expect(toHex(encodeTlvs([value]))).toBe(vector(tlvs, name).hex);
  });

  it('round-trips a rest block', () => {
    const list = decodeTlvs(bytesOf(tlvs, 'rest block of two'));
    expect(list.map((t) => t.tag)).toEqual([0x01, 0x08]);
    expect(tlvStr(list, 0x01)).toBe('botone');
    expect(tlvU16(list, 0x08)).toBe(5);
    expect(toHex(encodeTlvs(list))).toBe(vector(tlvs, 'rest block of two').hex);
  });

  it('reads and writes a count-prefixed block', () => {
    const bytes = bytesOf(tlvs, 'count-prefixed block of two');
    const { tlvs: list, next } = decodeTlvBlock(bytes, 0);
    expect([tlvU16(list, 0x01), tlvU32(list, 0x03), next]).toEqual([0x0410, 1790000000, bytes.length]);
    expect(toHex(encodeTlvBlock(list))).toBe(vector(tlvs, 'count-prefixed block of two').hex);
    const shifted = fromHex('ffff' + vector(tlvs, 'count-prefixed block of two').hex + 'ee');
    expect(decodeTlvBlock(shifted, 2).next).toBe(shifted.length - 1);
    expect(() => decodeTlvBlock(fromHex('0002000100020410'), 0)).toThrow(OscarDecodeError);
  });

  it('getters return undefined for a missing or short value where the server would panic', () => {
    const list = [tlv.empty(0x01), tlv.u8(0x02, 7)];
    expect([tlvU8(list, 0x01), tlvU16(list, 0x02), tlvU32(list, 0x02), tlvU8(list, 0x09), findTlv(list, 0x09)]).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect([tlvU8(list, 0x02), hasTlv(list, 0x01), hasTlv(list, 0x09)]).toEqual([7, true, false]);
  });

  it('rejects a truncated TLV', () => {
    expect(() => decodeTlvs(fromHex('0001000662'))).toThrow(OscarDecodeError);
    expect(() => decodeTlvs(fromHex('000100'))).toThrow(OscarDecodeError);
  });
});
