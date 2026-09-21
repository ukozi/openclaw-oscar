import { createHash, randomBytes } from 'node:crypto';
import { ByteReader } from './bytes.js';
import {
  BUCP_CHALLENGE_REQUEST,
  BUCP_CHALLENGE_RESPONSE,
  BUCP_LOGIN_REQUEST,
  BUCP_LOGIN_RESPONSE,
  FAMILY_BUCP,
  LOGIN_ERR_BAD_PASSWORD,
  LOGIN_ERR_DELETED,
  LOGIN_ERR_EXPIRED,
  LOGIN_ERR_INVALID_ACCOUNT,
  LOGIN_ERR_RATE_LIMITED,
  LOGIN_ERR_SUSPENDED,
  LOGIN_ERR_SUSPENDED_AGE,
  LOGIN_ERR_UNKNOWN_NAME,
  LOGIN_HASH_SUFFIX,
  LOGIN_TLV_CLIENT_ID,
  LOGIN_TLV_COOKIE,
  LOGIN_TLV_ERROR,
  LOGIN_TLV_MULTI_CONN,
  LOGIN_TLV_PASSWORD_HASH,
  LOGIN_TLV_RECONNECT_HERE,
  LOGIN_TLV_SCREEN_NAME,
  LOGIN_TLV_SSL_STATE,
  MULTI_CONN_SINGLE,
  REQUEST_TIMEOUT_MS,
} from './constants.js';
import { isTlsError, parseHostPort } from './connection.js';
import type { CloseInfo, OscarConnection } from './connection.js';
import type { Snac } from './snac.js';
import { decodeTlvs, encodeTlvs, findTlv, tlv, tlvStr, tlvU16, tlvU8 } from './tlv.js';
import type { Tlv } from './tlv.js';
import type { PasswordCheck, StateReason, TimerApi } from './types.js';

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

// state/user.go:98-108 IsUIN: a non-empty screen name of nothing but digits is an ICQ UIN.
// unicode.IsDigit is the Nd category, so match that rather than ASCII 0-9.
export function isUin(screenName: string): boolean {
  return /^\p{Nd}+$/u.test(screenName);
}

// 0x0008 is two errors under one number: wire/snacs.go:123 LoginErrDeletedAccount and
// wire/snacs.go:131 LoginErrICQUserErr ("ICQ user doesn't exist"). foodgroup/auth.go:566-574 and
// 649-654 return it when the screen name is a UIN and no such account exists, so for a numeric
// name it is the ICQ spelling of an unknown name, not a deleted account.
export function loginErrorReason(code: number, screenName?: string): StateReason {
  switch (code) {
    case LOGIN_ERR_UNKNOWN_NAME:
    case LOGIN_ERR_INVALID_ACCOUNT:
      return 'unknown-name';
    case LOGIN_ERR_BAD_PASSWORD:
      return 'bad-password';
    case LOGIN_ERR_RATE_LIMITED:
      return 'login-rate-limited';
    case LOGIN_ERR_DELETED:
      return screenName !== undefined && isUin(screenName) ? 'unknown-name' : 'suspended';
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

function failure(code: number, screenName?: string): LoginResult {
  return {
    ok: false,
    reason: loginErrorReason(code, screenName),
    code,
    detail: `login error 0x${code.toString(16).padStart(4, '0')}`,
  };
}

export function parseLoginReply(tlvs: readonly Tlv[], defaultPort: number, screenName?: string): LoginResult {
  const code = tlvU16(tlvs, LOGIN_TLV_ERROR);
  if (code !== undefined) return failure(code, screenName);
  const where = tlvStr(tlvs, LOGIN_TLV_RECONNECT_HERE);
  const cookie = findTlv(tlvs, LOGIN_TLV_COOKIE);
  if (!where || !cookie || cookie.length === 0) {
    return { ok: false, reason: 'network', detail: 'login reply had no address or cookie' };
  }
  return { ok: true, ...parseHostPort(where, defaultPort), cookie, ssl: (tlvU8(tlvs, LOGIN_TLV_SSL_STATE) ?? 0) !== 0 };
}

function closeResult(info: CloseInfo, screenName?: string): LoginResult {
  if (info.kind === 'signoff') {
    // Which shape a refused client sees is decided by the cached per-IP entry's isBUCP tag
    // (server/oscar/server.go:415-435), not by whether this is the client's first connection: the
    // bucket's burst is 10 (cmd/server/factory.go:356), so a first connection always passes, and
    // server.go:452 tags the IP as BUCP only after Allow() returns. A BUCP client that exhausts the
    // bucket has therefore already tagged its own address and gets the SNAC shape; this bare
    // signoff shape arrives when a FLAP-auth client on the same address created the entry, or when
    // enough connections race Allow() before any SetBUCP lands. Both shapes must keep working.
    const code = tlvU16(info.tlvs, LOGIN_TLV_ERROR) ?? tlvU8(info.tlvs, LOGIN_TLV_ERROR);
    if (code !== undefined) return failure(code, screenName);
  }
  if (info.kind === 'error' && isTlsError(info.error)) return { ok: false, reason: 'tls', detail: info.error.message };
  return { ok: false, reason: 'network', detail: `auth connection closed (${info.kind})` };
}

type AuthEvent = { snac: Snac } | { closed: CloseInfo } | { timeout: true };

function eventQueue(
  conn: OscarConnection,
  timers: TimerApi,
  timeoutMs: number,
): { next: () => Promise<AuthEvent>; stop: () => void } {
  const events: AuthEvent[] = [];
  let wake: (() => void) | null = null;
  const push = (e: AuthEvent): void => {
    events.push(e);
    wake?.();
  };
  const offSnac = conn.onSnac((snac) => push({ snac }));
  const offClose = conn.onClose((closed) => push({ closed }));
  return {
    async next() {
      if (events.length === 0) {
        const timer = timers.setTimeout(() => push({ timeout: true }), timeoutMs);
        await new Promise<void>((resolve) => (wake = resolve));
        wake = null;
        timers.clearTimeout(timer);
      }
      return events.shift() ?? { timeout: true };
    },
    stop() {
      offSnac();
      offClose();
    },
  };
}

export async function bucpLogin(
  conn: OscarConnection,
  timers: TimerApi,
  screenName: string,
  defaultPort: number,
  hashFor: (key: string) => Promise<Uint8Array> | Uint8Array,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<LoginResult> {
  // Local refusal, not a server rule: the server reads the BUCP screen name with list.String()
  // (foodgroup/auth.go:234), which cannot panic, and answers a too-short name with a normal
  // 0x0001. The panic lives on the FLAP-auth path only - server/oscar/server.go:448 calls
  // flap.Uint16BE(LoginTLVTagsScreenName) on the signon frame and wire/tlv.go:52-55 has no length
  // guard - and we never put TLV 0x01 in a signon frame (connection.ts sends the cookie or
  // nothing). Keep the guard if a FLAP-auth path is ever added; do not rely on it for BUCP.
  if (Buffer.byteLength(screenName, 'utf8') < 2) {
    conn.destroy();
    return { ok: false, reason: 'unknown-name', detail: 'screen name too short' };
  }
  const queue = eventQueue(conn, timers, timeoutMs);
  try {
    conn.send(FAMILY_BUCP, BUCP_CHALLENGE_REQUEST, encodeTlvs([tlv.str(LOGIN_TLV_SCREEN_NAME, screenName)]));
    let sentLogin = false;
    for (;;) {
      const event = await queue.next();
      if ('timeout' in event) return { ok: false, reason: 'network', detail: 'login timed out' };
      if ('closed' in event) return closeResult(event.closed, screenName);
      const { snac } = event;
      if (snac.family !== FAMILY_BUCP) continue;
      if (snac.subtype === BUCP_LOGIN_RESPONSE) return parseLoginReply(decodeTlvs(snac.body), defaultPort, screenName);
      if (snac.subtype !== BUCP_CHALLENGE_RESPONSE || sentLogin) continue;
      const key = new ByteReader(snac.body).str16();
      const hash = await hashFor(key);
      sentLogin = true;
      // Never TLV 0x133A: it would make the server mint a login cookie valid for up to a year.
      conn.send(
        FAMILY_BUCP,
        BUCP_LOGIN_REQUEST,
        encodeTlvs([
          tlv.str(LOGIN_TLV_SCREEN_NAME, screenName),
          tlv.bytes(LOGIN_TLV_PASSWORD_HASH, hash),
          tlv.str(LOGIN_TLV_CLIENT_ID, CLIENT_ID),
          tlv.u8(LOGIN_TLV_MULTI_CONN, MULTI_CONN_SINGLE),
        ]),
      );
    }
  } catch (error) {
    return { ok: false, reason: 'network', detail: (error as Error).message };
  } finally {
    queue.stop();
    conn.destroy();
  }
}

// A BUCP success only mints a cookie; no session exists until the cookie is presented, so
// the probe drops it unread and cannot displace the live sign-on.
export async function probeLogin(
  conn: OscarConnection,
  timers: TimerApi,
  screenName: string,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<PasswordCheck> {
  const result = await bucpLogin(conn, timers, screenName, 0, () => new Uint8Array(randomBytes(16)), timeoutMs);
  if (result.ok) return 'does-not-check';
  return result.reason === 'bad-password' || result.reason === 'unknown-name' ? 'checks' : 'unknown';
}
