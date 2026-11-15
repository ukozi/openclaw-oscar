import { randomBytes } from 'node:crypto';
import {
  MULTI_CONN_SINGLE,
  RedirectRefusedError,
  bucpLogin,
  decideRedirect,
  isTlsError,
  isUnroutableHost,
  md5Available,
  openConnection,
  strongHash,
} from 'open-oscar-client-kit/wire';
import type { OscarConnection, RedirectDecision } from 'open-oscar-client-kit/wire';
import type { Logger, PasswordCheck, StateReason, TimerApi } from './types.js';

// Short on purpose: screen name plus client id must stay far under the ~200 bytes the login cookie can hold.
export const CLIENT_ID = 'openclaw-oscar';
const LOGIN = { clientId: CLIENT_ID, multiConn: MULTI_CONN_SINGLE };

export type LoginOptions = {
  host: string;
  port: number;
  tls: boolean;
  caFile?: string | undefined;
  redirect: 'auto' | 'follow' | 'pin';
  screenName: string;
  hash: (key: string) => Promise<Uint8Array> | Uint8Array;
  log: Logger;
  timers?: TimerApi;
  timeoutMs?: number | undefined;
  track?: (conn: OscarConnection) => void;
};
export type LoginOutcome =
  | { ok: true; host: string; port: number; cookie: Uint8Array; decision: RedirectDecision; advertised: string; followedUnroutable: boolean }
  | { ok: false; reason: StateReason; detail?: string; code?: number };

export function connectFailureReason(error: unknown, followedUnroutable: boolean): StateReason {
  if (isTlsError(error)) return 'tls';
  return followedUnroutable ? 'redirect-unroutable' : 'network';
}

export function redirectProblem(decision: RedirectDecision, advertised: string, followedUnroutable: boolean): string | null {
  if (decision.why === 'unroutable' || decision.why === 'loopback') return `the server advertises ${advertised}, which cannot be reached from here; using the configured address`;
  if (decision.why === 'tls-mismatch') return `the server advertises ${advertised} without TLS; staying on the configured TLS address`;
  if (decision.why === 'malformed') return 'the server advertises an address that cannot be read; using the configured address';
  if (followedUnroutable) return `redirect "follow" leads to ${advertised}, which cannot be reached from here`;
  return null;
}

const timersOf = (opts: { timers?: TimerApi | undefined }): TimerApi => opts.timers ?? { setTimeout, clearTimeout };

async function openAuth(opts: Omit<LoginOptions, 'hash' | 'redirect'>): Promise<OscarConnection> {
  const conn = await openConnection({
    host: opts.host,
    port: opts.port,
    tls: opts.tls,
    caFile: opts.caFile,
    label: 'auth',
    log: opts.log,
    timers: opts.timers,
    connectTimeoutMs: opts.timeoutMs,
  });
  opts.track?.(conn);
  return conn;
}

// A login that stops at the cookie: no session exists on the server until the cookie is presented.
export async function login(opts: LoginOptions): Promise<LoginOutcome> {
  if (!md5Available()) return { ok: false, reason: 'md5-unavailable', detail: 'this Node build disables MD5' };
  if (Buffer.byteLength(opts.screenName, 'utf8') < 2) return { ok: false, reason: 'unknown-name', detail: 'screen name too short' };
  let conn: OscarConnection;
  try {
    conn = await openAuth(opts);
  } catch (error) {
    return { ok: false, reason: connectFailureReason(error, false), detail: (error as Error).message };
  }
  const result = await bucpLogin(conn, timersOf(opts), opts.screenName, opts.port, opts.hash, LOGIN, opts.timeoutMs);
  if (!result.ok) return { ok: false, reason: result.reason, detail: result.detail, ...(result.code === undefined ? {} : { code: result.code }) };
  const advertised = `${result.host}:${result.port}`;
  const decision = decideRedirect(opts.redirect, opts, result);
  if (decision.refused) return { ok: false, reason: decision.refused, detail: new RedirectRefusedError(advertised).message };
  if (decision.pinned && decision.why !== 'mode') opts.log.info('ignoring the advertised BOS address', { why: decision.why, advertised });
  const followedUnroutable = !decision.pinned && isUnroutableHost(decision.host) && !isUnroutableHost(opts.host);
  return { ok: true, host: decision.host, port: decision.port, cookie: result.cookie, decision, advertised, followedUnroutable };
}

// A random hash: refused means the server checks passwords. The cookie is dropped unread.
export async function probeLogin(opts: Omit<LoginOptions, 'hash' | 'redirect'>): Promise<PasswordCheck> {
  try {
    const conn = await openAuth(opts);
    const result = await bucpLogin(conn, timersOf(opts), opts.screenName, opts.port, () => new Uint8Array(randomBytes(16)), LOGIN, opts.timeoutMs);
    if (result.ok) return 'does-not-check';
    return result.reason === 'bad-password' || result.reason === 'unknown-name' ? 'checks' : 'unknown';
  } catch {
    return 'unknown';
  }
}

export type LoginCheckOptions = {
  host: string;
  port: number;
  tls: boolean;
  caFile?: string | undefined;
  redirect: 'auto' | 'follow' | 'pin';
  screenName: string;
  log: Logger;
  timeoutMs?: number | undefined;
};
export type LoginCheckResult =
  | { ok: true; bosHost: string; bosPort: number; redirectProblem: string | null }
  | { ok: false; reason: StateReason; detail?: string };

// For setup and status probes; a live sign-on of the same name is not displaced.
export async function checkLogin(opts: LoginCheckOptions & { password: string }): Promise<LoginCheckResult> {
  const out = await login({ ...opts, hash: (key) => strongHash(opts.password, key) });
  if (!out.ok) return out.code === undefined ? { ok: false, reason: out.reason, ...(out.detail === undefined ? {} : { detail: out.detail }) } : { ok: false, reason: out.reason };
  return { ok: true, bosHost: out.host, bosPort: out.port, redirectProblem: redirectProblem(out.decision, out.advertised, out.followedUnroutable) };
}

// Only for a screen name that has logged in before: on a server with auth disabled, probing a missing name creates it.
export function checkPasswordEnforced(opts: LoginCheckOptions): Promise<PasswordCheck> {
  return probeLogin(opts);
}
