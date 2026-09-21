import { createHash } from 'node:crypto';
import {
  LOGIN_ERR_BAD_PASSWORD,
  LOGIN_ERR_DELETED,
  LOGIN_ERR_EXPIRED,
  LOGIN_ERR_INVALID_ACCOUNT,
  LOGIN_ERR_RATE_LIMITED,
  LOGIN_ERR_SUSPENDED,
  LOGIN_ERR_SUSPENDED_AGE,
  LOGIN_ERR_UNKNOWN_NAME,
  LOGIN_HASH_SUFFIX,
  LOGIN_TLV_COOKIE,
  LOGIN_TLV_ERROR,
  LOGIN_TLV_RECONNECT_HERE,
  LOGIN_TLV_SSL_STATE,
} from './constants.js';
import { parseHostPort } from './connection.js';
import { findTlv, tlvStr, tlvU16, tlvU8 } from './tlv.js';
import type { Tlv } from './tlv.js';
import type { StateReason } from './types.js';

// Short on purpose: screen name plus client id must stay far under the ~200 bytes the login cookie can hold.
export const CLIENT_ID = 'openclaw-oscar';

export function md5Available(): boolean {
  try {
    createHash('md5').update('probe').digest();
    return true;
  } catch {
    return false;
  }
}

export function strongHash(password: string, key: string): Uint8Array {
  const inner = createHash('md5').update(password, 'utf8').digest();
  return new Uint8Array(createHash('md5').update(key, 'utf8').update(inner).update(LOGIN_HASH_SUFFIX, 'utf8').digest());
}

export function loginErrorReason(code: number): StateReason {
  switch (code) {
    case LOGIN_ERR_UNKNOWN_NAME:
    case LOGIN_ERR_INVALID_ACCOUNT:
      return 'unknown-name';
    case LOGIN_ERR_BAD_PASSWORD:
      return 'bad-password';
    case LOGIN_ERR_RATE_LIMITED:
      return 'login-rate-limited';
    case LOGIN_ERR_DELETED:
    case LOGIN_ERR_EXPIRED:
    case LOGIN_ERR_SUSPENDED:
    case LOGIN_ERR_SUSPENDED_AGE:
      return 'suspended';
    default:
      return 'network';
  }
}

export type LoginResult =
  | { ok: true; host: string; port: number; cookie: Uint8Array; ssl: boolean }
  | { ok: false; reason: StateReason; code?: number; detail: string };

function failure(code: number): LoginResult {
  return { ok: false, reason: loginErrorReason(code), code, detail: `login error 0x${code.toString(16).padStart(4, '0')}` };
}

export function parseLoginReply(tlvs: readonly Tlv[], defaultPort: number): LoginResult {
  const code = tlvU16(tlvs, LOGIN_TLV_ERROR);
  if (code !== undefined) return failure(code);
  const where = tlvStr(tlvs, LOGIN_TLV_RECONNECT_HERE);
  const cookie = findTlv(tlvs, LOGIN_TLV_COOKIE);
  if (!where || !cookie || cookie.length === 0) {
    return { ok: false, reason: 'network', detail: 'login reply had no address or cookie' };
  }
  return { ok: true, ...parseHostPort(where, defaultPort), cookie, ssl: (tlvU8(tlvs, LOGIN_TLV_SSL_STATE) ?? 0) !== 0 };
}
