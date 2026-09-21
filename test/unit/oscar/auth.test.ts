import { describe, expect, it } from 'vitest';
import { toHex } from '../../../src/oscar/bytes.js';
import { CLIENT_ID, loginErrorReason, md5Available, parseLoginReply, strongHash } from '../../../src/oscar/auth.js';
import { decodeTlvs, encodeTlvs, tlv } from '../../../src/oscar/tlv.js';
import { bytesOf, loadVectors, vector } from './vectors.js';

const auth = loadVectors('auth.json');

describe('strong hash', () => {
  it('matches every hash vector, the two from the server test suite included', () => {
    const rows = auth.vectors.filter((v) => v.name.startsWith('strong hash'));
    expect(rows).toHaveLength(3);
    for (const v of rows) {
      expect(toHex(strongHash(v.inputs?.['password'] ?? 'missing', v.inputs?.['key'] ?? 'missing'))).toBe(v.hex);
    }
  });

  it('pins the two values as they appear in wire/user_test.go', () => {
    expect(vector(auth, 'strong hash, empty password and key').hex).toBe('1fa2b6995984b01468a37c7742900ac9');
    expect(vector(auth, 'strong hash, password123 and authkey456').hex).toBe('b90791cccb5c5771bdcbc93982f79484');
  });

  it('finds MD5 on this Node build', () => {
    expect(md5Available()).toBe(true);
  });
});

describe('login bodies', () => {
  it('builds the login request the server expects', () => {
    const body = encodeTlvs([
      tlv.str(0x01, 'botone'),
      tlv.bytes(0x25, strongHash('password123', 'authkey456')),
      tlv.str(0x03, CLIENT_ID),
      tlv.u8(0x4a, 0x03),
    ]);
    expect(toHex(body)).toBe(vector(auth, 'login request body').hex);
    expect(toHex(encodeTlvs([tlv.str(0x01, 'botone')]))).toBe(vector(auth, 'challenge request body').hex);
  });

  it('keeps the client id short enough for the login cookie', () => {
    expect(Buffer.byteLength(CLIENT_ID) + 16).toBeLessThan(100);
  });

  it('parses a success reply', () => {
    const got = parseLoginReply(decodeTlvs(bytesOf(auth, 'login success body')), 5190);
    expect(got).toMatchObject({ ok: true, host: 'oscar.example.net', port: 5190, ssl: false });
    expect(got.ok && toHex(got.cookie)).toBe('0001020304050607');
    expect(parseLoginReply(decodeTlvs(bytesOf(auth, 'login success body on the SSL listener')), 5190)).toMatchObject({
      ok: true,
      port: 5193,
      ssl: true,
    });
  });

  it('parses failure replies in both limiter shapes', () => {
    expect(parseLoginReply(decodeTlvs(bytesOf(auth, 'login failure body, bad password')), 5190)).toMatchObject({
      ok: false,
      reason: 'bad-password',
      code: 5,
    });
    expect(parseLoginReply(decodeTlvs(bytesOf(auth, 'limiter body, SNAC shape')), 5190)).toMatchObject({
      ok: false,
      reason: 'login-rate-limited',
    });
  });

  it('treats a reply with no address or cookie as a network fault', () => {
    expect(parseLoginReply([tlv.str(0x01, 'botone')], 5190)).toMatchObject({ ok: false, reason: 'network' });
    expect(parseLoginReply([tlv.str(0x05, 'h:1'), tlv.empty(0x06)], 5190)).toMatchObject({ ok: false, reason: 'network' });
  });
});

describe('loginErrorReason', () => {
  const rows: [number, string][] = [
    [0x0001, 'unknown-name'],
    [0x0007, 'unknown-name'],
    [0x0005, 'bad-password'],
    [0x001d, 'login-rate-limited'],
    [0x0008, 'suspended'],
    [0x0009, 'suspended'],
    [0x0011, 'suspended'],
    [0x0022, 'suspended'],
    [0x0006, 'network'],
    [0x0018, 'network'],
  ];
  it.each(rows)('0x%s -> %s', (code, want) => {
    expect(loginErrorReason(code)).toBe(want);
  });
});
