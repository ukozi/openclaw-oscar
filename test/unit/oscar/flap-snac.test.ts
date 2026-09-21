import { describe, expect, it } from 'vitest';
import { OscarDecodeError, fromHex, toHex } from '../../../src/oscar/bytes.js';
import { FlapDecoder, decodeSignonPayload, encodeFlap, encodeSignonPayload } from '../../../src/oscar/flap.js';
import { decodeSnac, decodeSnacError, decodeUserInfo, encodeSnac, encodeUserInfo, userFlags } from '../../../src/oscar/snac.js';
import { decodeTlvs, findTlv, tlv, tlvStr, tlvU16, tlvU8 } from '../../../src/oscar/tlv.js';
import { bytesOf, loadVectors, vector } from './vectors.js';

const flap = loadVectors('flap.json');
const snac = loadVectors('snac.json');

describe('FLAP', () => {
  it('encodes frames like the server', () => {
    expect(toHex(encodeFlap(1, 100, encodeSignonPayload()))).toBe(vector(flap, 'server signon, sequence 100').hex);
    expect(toHex(encodeFlap(1, 0, encodeSignonPayload([tlv.bytes(0x06, fromHex('deadbeef'))])))).toBe(
      vector(flap, 'client signon with a 4-byte cookie, sequence 0').hex,
    );
    expect(toHex(encodeFlap(5, 7))).toBe(vector(flap, 'keepalive, sequence 7').hex);
    expect(toHex(encodeFlap(4, 102))).toBe(vector(flap, 'empty signoff, sequence 102').hex);
    expect(toHex(encodeFlap(2, 5, encodeSnac({ family: 1, subtype: 0x1f, requestId: 9 })))).toBe(
      vector(flap, 'data frame holding a probe request, sequence 5').hex,
    );
  });

  it('wraps the sequence number at 16 bits and refuses an oversized payload', () => {
    expect(toHex(encodeFlap(5, 0x10000))).toBe('2a0500000000');
    expect(() => encodeFlap(2, 0, new Uint8Array(0xfffa))).toThrow(RangeError);
  });

  it('decodes a signon payload', () => {
    const [frame] = new FlapDecoder().push(bytesOf(flap, 'client signon with a 4-byte cookie, sequence 0'));
    expect(frame).toMatchObject({ type: 1, seq: 0 });
    const signon = decodeSignonPayload(frame?.payload ?? new Uint8Array());
    expect(signon.version).toBe(1);
    expect(toHex(findTlv(signon.tlvs, 0x06) ?? new Uint8Array())).toBe('deadbeef');
  });

  it('reassembles frames from a byte stream cut at every possible point', () => {
    const stream = fromHex(
      vector(flap, 'server signon, sequence 100').hex +
        vector(flap, 'data frame holding a probe request, sequence 5').hex +
        vector(flap, 'keepalive, sequence 7').hex,
    );
    for (let cut = 0; cut <= stream.length; cut++) {
      const d = new FlapDecoder();
      const frames = [...d.push(stream.subarray(0, cut)), ...d.push(stream.subarray(cut))];
      expect(frames.map((f) => [f.type, f.seq, f.payload.length])).toEqual([[1, 100, 4], [2, 5, 10], [5, 7, 0]]);
      expect(d.end()).toBeNull();
    }
  });

  it('copies payloads out of the receive buffer', () => {
    const chunk = bytesOf(flap, 'server signon, sequence 100').slice();
    const [frame] = new FlapDecoder().push(chunk);
    chunk.fill(0);
    expect(toHex(frame?.payload ?? new Uint8Array())).toBe('00000001');
  });

  it('reads the signoff TLVs the server sends', () => {
    const [closed] = new FlapDecoder().push(bytesOf(flap, 'signoff after a server-side close, sequence 101'));
    const list = decodeTlvs(closed?.payload ?? new Uint8Array());
    expect([closed?.type, tlvU8(list, 0x09), tlvStr(list, 0x0b)]).toEqual([4, 1, 'https://github.com/mk6i/open-oscar-server']);
    const [limited] = new FlapDecoder().push(bytesOf(flap, 'signoff from the login limiter, sequence 101'));
    expect(tlvU16(decodeTlvs(limited?.payload ?? new Uint8Array()), 0x08)).toBe(0x001d);
    const [full] = new FlapDecoder().push(bytesOf(flap, 'signoff when five instances are already online, sequence 101'));
    const fullTlvs = decodeTlvs(full?.payload ?? new Uint8Array());
    expect([tlvU16(fullTlvs, 0x08), tlvU8(fullTlvs, 0x08)]).toEqual([undefined, 0x18]);
  });

  it('accepts the truncated four-byte signoff at end of stream, also after other frames', () => {
    const d = new FlapDecoder();
    expect(d.push(bytesOf(flap, 'truncated signoff, sequence 101'))).toEqual([]);
    expect(d.end()).toEqual({ type: 4, seq: 101, payload: new Uint8Array(0), truncated: true });

    const e = new FlapDecoder();
    const frames = e.push(fromHex(vector(flap, 'keepalive, sequence 7').hex + vector(flap, 'truncated signoff, sequence 101').hex));
    expect(frames).toHaveLength(1);
    expect(e.end()).toMatchObject({ type: 4, truncated: true });
  });

  it('treats any other leftover as an error', () => {
    const d = new FlapDecoder();
    d.push(fromHex('2a0200660010aabb'));
    expect(() => d.end()).toThrow(OscarDecodeError);
    const four = new FlapDecoder();
    four.push(fromHex('2a020065'));
    expect(() => four.end()).toThrow(OscarDecodeError);
  });

  it('rejects a bad start marker at once', () => {
    expect(() => new FlapDecoder().push(fromHex('16030100'))).toThrow('bad FLAP start marker');
    const d = new FlapDecoder();
    expect(() => d.push(fromHex(vector(flap, 'keepalive, sequence 7').hex + '00'))).toThrow('bad FLAP start marker');
  });
});

describe('SNAC', () => {
  it('encodes headers like the server', () => {
    expect(toHex(encodeSnac({ family: 1, subtype: 0x1f, requestId: 9 }))).toBe(vector(snac, 'probe request, id 9').hex);
    expect(toHex(encodeSnac({ family: 1, subtype: 0x13, requestId: 0x80000000 }))).toBe(vector(snac, 'server-initiated id').hex);
  });

  it('decodes a header and body', () => {
    expect(decodeSnac(fromHex(vector(snac, 'probe ack, id 9').hex + 'aabb'))).toEqual({
      family: 1,
      subtype: 0x20,
      flags: 0,
      requestId: 9,
      body: fromHex('aabb'),
    });
    expect(decodeSnac(bytesOf(snac, 'server-initiated id')).requestId).toBe(0x80000000);
  });

  it('skips the TLV block that flag 0x8000 puts before the body', () => {
    const got = decodeSnac(bytesOf(snac, 'extended-info flag 0x8000'));
    expect(got).toMatchObject({ family: 0x13, subtype: 0x1c, flags: 0x8000, requestId: 0 });
    expect(toHex(got.body)).toBe('cafe');
  });

  it('rejects a short header and a lying extended-info length', () => {
    expect(() => decodeSnac(fromHex('000100'))).toThrow(OscarDecodeError);
    expect(() => decodeSnac(fromHex('0013001c8000000000000040'))).toThrow(OscarDecodeError);
  });

  it('decodes error bodies', () => {
    expect(decodeSnacError(bytesOf(snac, 'error body, code 4'))).toEqual({ code: 4, tlvs: [] });
    const withSub = decodeSnacError(bytesOf(snac, 'error body, code 4 with subcode 0x000F'));
    expect([withSub.code, tlvU16(withSub.tlvs, 0x08)]).toEqual([4, 0x000f]);
  });

  it('reads a user info block from an offset and says where it ends', () => {
    const body = bytesOf(loadVectors('icbm.json'), 'message to client body');
    const { info, next } = decodeUserInfo(body, 10);
    expect([info.name, info.warning, info.tlvs.map((t) => t.tag), userFlags(info)]).toEqual(['Alice', 0, [0x01, 0x03], 0x0010]);
    expect(decodeTlvs(body.subarray(next)).map((t) => t.tag)).toEqual([0x02]);
  });

  it('writes a user info block like the server', () => {
    const want = vector(loadVectors('oservice.json'), 'user info update body, bot account').hex;
    const { info, next } = decodeUserInfo(fromHex(want), 0);
    expect(next).toBe(want.length / 2);
    expect(toHex(encodeUserInfo(info))).toBe(want);
    expect(toHex(encodeUserInfo({ name: 'alice', warning: 0, tlvs: [] }))).toBe('05616c69636500000000');
  });

  it('reads flags as 0 when the block has none, and throws on a block cut short', () => {
    expect(userFlags({ name: 'alice', warning: 0, tlvs: [] })).toBe(0);
    expect(() => decodeUserInfo(fromHex('05616c6963650000000100010002'), 0)).toThrow(OscarDecodeError);
  });
});
