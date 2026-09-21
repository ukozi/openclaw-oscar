import { readFile } from 'node:fs/promises';
import net from 'node:net';
import tls from 'node:tls';
import {
  CONNECT_TIMEOUT_MS,
  FAMILY_OSERVICE,
  FLAP_DATA,
  FLAP_KEEPALIVE,
  FLAP_SIGNOFF,
  FLAP_SIGNON,
  KEEPALIVE_INTERVAL_MS,
  LOGIN_TLV_COOKIE,
  OSERVICE_USER_INFO_QUERY,
  PROBE_INTERVAL_MS,
  PROBE_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
} from './constants.js';
import { FlapDecoder, encodeFlap, encodeSignonPayload } from './flap.js';
import type { FlapFrame } from './flap.js';
import { decodeSnac, encodeSnac } from './snac.js';
import type { Snac } from './snac.js';
import { decodeTlvs, tlv } from './tlv.js';
import type { Tlv } from './tlv.js';
import type { Logger, TimerApi } from './types.js';

export type CloseInfo =
  | { kind: 'signoff'; clean: true; tlvs: Tlv[]; truncated: boolean }
  | { kind: 'local'; clean: true }
  | { kind: 'eof'; clean: false }
  | { kind: 'error'; clean: false; error: Error }
  | { kind: 'probe-timeout'; clean: false };

export type ConnectionOptions = {
  host: string;
  port: number;
  tls: boolean;
  caFile?: string | undefined;
  cookie?: Uint8Array | undefined;
  label?: string | undefined;
  log: Logger;
  now?: (() => number) | undefined;
  timers?: TimerApi | undefined;
  connectTimeoutMs?: number | undefined;
};

export class ConnectionClosedError extends Error {
  readonly info: CloseInfo;

  constructor(info: CloseInfo) {
    super(`connection closed (${info.kind})`);
    this.name = 'ConnectionClosedError';
    this.info = info;
  }
}

export class RequestTimeoutError extends Error {
  constructor() {
    super('no reply in time');
    this.name = 'RequestTimeoutError';
  }
}

export function isTlsError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return (
    typeof code === 'string' &&
    /^(ERR_TLS|ERR_SSL|CERT_|DEPTH_ZERO|SELF_SIGNED|UNABLE_TO_|HOSTNAME_MISMATCH|EPROTO)/.test(code)
  );
}

export function parseHostPort(raw: string, defaultPort: number): { host: string; port: number } {
  const text = raw.trim();
  const bracket = /^\[([^\]]+)\](?::(\d+))?$/.exec(text);
  if (bracket) return { host: bracket[1] ?? '', port: bracket[2] ? Number(bracket[2]) : defaultPort };
  const at = text.lastIndexOf(':');
  if (at < 0 || text.indexOf(':') !== at) return { host: text, port: defaultPort };
  const port = Number(text.slice(at + 1));
  return { host: text.slice(0, at), port: Number.isInteger(port) && port > 0 && port < 65536 ? port : defaultPort };
}

function bareHost(host: string): string {
  return host.trim().toLowerCase().replace(/^\[|\]$/g, '');
}

export function isLoopbackHost(host: string): boolean {
  const h = bareHost(host);
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (net.isIPv4(h)) return h.startsWith('127.');
  return net.isIPv6(h) && h === '::1';
}

export function isUnroutableHost(host: string): boolean {
  const h = bareHost(host);
  if (h === '' || isLoopbackHost(h)) return true;
  if (net.isIPv4(h)) return /^(0\.|169\.254\.)/.test(h);
  if (net.isIPv6(h)) return h === '::' || /^fe[89ab]/.test(h);
  return false;
}

type Endpoint = { host: string; port: number };
export type RedirectMode = 'auto' | 'follow' | 'pin';
export type RedirectDecision = Endpoint & {
  pinned: boolean;
  why?: 'mode' | 'tls-mismatch' | 'loopback' | 'unroutable' | 'malformed' | undefined;
  refused?: 'tls' | undefined;
};

export class RedirectRefusedError extends Error {
  readonly reason = 'tls' as const;

  constructor(advertised: string) {
    super(`the server answered with the plaintext address ${advertised} and redirect is "follow"; a TLS session is never downgraded`);
    this.name = 'RedirectRefusedError';
  }
}

// One listener serves auth, BOS, ChatNav and Chat, so the configured address is always a valid place to go.
export function decideRedirect(
  mode: RedirectMode,
  configured: Endpoint & { tls: boolean },
  advertised: Endpoint & { ssl: boolean },
): RedirectDecision {
  const pin = (why: RedirectDecision['why']): RedirectDecision => ({ host: configured.host, port: configured.port, pinned: true, why });
  const follow: RedirectDecision = { host: advertised.host, port: advertised.port, pinned: false };
  if (mode === 'pin') return pin('mode');
  if (advertised.host === '' || !(advertised.port > 0 && advertised.port < 65536)) return pin('malformed');
  // v0.24.0 always advertises its plaintext listener, even to a client that arrived through TLS. A TLS
  // session is never downgraded: auto stays where it is, follow was told to go and so fails.
  if (configured.tls && !advertised.ssl) return mode === 'follow' ? { ...follow, refused: 'tls' } : pin('tls-mismatch');
  if (mode === 'follow') return follow;
  // The server's default advertisement is 127.0.0.1:5190. A loopback answer is real only for a client
  // that dialled loopback itself; any other unroutable answer is never real.
  if (isLoopbackHost(advertised.host)) return isLoopbackHost(configured.host) ? follow : pin('loopback');
  if (isUnroutableHost(advertised.host)) return pin('unroutable');
  return follow;
}

export function resolveRedirect(
  advertised: string,
  sslState: number,
  cfg: Endpoint & { tls: boolean; redirect: RedirectMode },
): RedirectDecision {
  const where = parseHostPort(advertised, cfg.port);
  return decideRedirect(cfg.redirect, cfg, { ...where, ssl: sslState !== 0 });
}

type Timer = ReturnType<typeof setTimeout>;
type Pending = { resolve: (s: Snac) => void; reject: (e: Error) => void; timer: Timer };

export class OscarConnection {
  private readonly decoder = new FlapDecoder();
  private readonly pending = new Map<number, Pending>();
  private readonly snacListeners: ((s: Snac) => void)[] = [];
  private readonly closeListeners: ((i: CloseInfo) => void)[] = [];
  private readonly timers: TimerApi;
  private readonly label: string;
  private backlog: Snac[] = [];
  private seq = 0;
  private nextRequestId = 1;
  private closed: CloseInfo | null = null;
  private keepaliveTimer: Timer | null = null;
  private probeTimer: Timer | null = null;
  private probeDeadline: Timer | null = null;
  private probeRequestId: number | null = null;
  private onFirstFrame: ((f: FlapFrame) => void) | null = null;

  private constructor(
    private readonly socket: net.Socket,
    private readonly opts: ConnectionOptions,
  ) {
    this.timers = opts.timers ?? { setTimeout, clearTimeout };
    this.label = opts.label ?? (opts.cookie ? 'service' : 'auth');
  }

  static async open(opts: ConnectionOptions): Promise<OscarConnection> {
    const ca = opts.tls && opts.caFile ? await readFile(opts.caFile) : undefined;
    const socket = opts.tls
      ? tls.connect({
          host: opts.host,
          port: opts.port,
          ca,
          servername: net.isIP(opts.host) === 0 ? opts.host : undefined,
        })
      : net.connect({ host: opts.host, port: opts.port });
    socket.setNoDelay(true);
    const conn = new OscarConnection(socket, opts);
    return new Promise<OscarConnection>((resolve, reject) => {
      const timer = conn.timers.setTimeout(() => {
        conn.destroy({ kind: 'error', clean: false, error: new Error('connect timeout') });
      }, opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS);
      const off = conn.onClose((info) => {
        conn.timers.clearTimeout(timer);
        reject(info.kind === 'error' ? info.error : new ConnectionClosedError(info));
      });
      conn.onFirstFrame = (frame) => {
        if (frame.type !== FLAP_SIGNON) {
          conn.destroy({ kind: 'error', clean: false, error: new Error('server did not start with a FLAP signon') });
          return;
        }
        conn.timers.clearTimeout(timer);
        off();
        opts.log.debug('oscar connection open', { conn: conn.label, host: opts.host, port: opts.port, tls: opts.tls });
        // The server routes on this frame: TLV 0x06 makes it a service connection, its absence starts BUCP.
        conn.sendFrame(FLAP_SIGNON, encodeSignonPayload(opts.cookie ? [tlv.bytes(LOGIN_TLV_COOKIE, opts.cookie)] : []));
        conn.startHeartbeat();
        resolve(conn);
      };
      conn.attach();
    });
  }

  private attach(): void {
    this.socket.on('data', (chunk: Buffer) => {
      let frames: FlapFrame[];
      try {
        frames = this.decoder.push(new Uint8Array(chunk));
      } catch (error) {
        this.destroy({ kind: 'error', clean: false, error: error as Error });
        return;
      }
      for (const frame of frames) this.onFrame(frame);
    });
    this.socket.on('error', (error) => this.destroy({ kind: 'error', clean: false, error }));
    this.socket.on('close', () => {
      try {
        const last = this.decoder.end();
        this.destroy(last ? { kind: 'signoff', clean: true, tlvs: [], truncated: true } : { kind: 'eof', clean: false });
      } catch (error) {
        this.destroy({ kind: 'error', clean: false, error: error as Error });
      }
    });
  }

  private onFrame(frame: FlapFrame): void {
    if (this.closed) return;
    if (this.onFirstFrame) {
      const first = this.onFirstFrame;
      this.onFirstFrame = null;
      first(frame);
      return;
    }
    if (frame.type === FLAP_SIGNOFF) {
      let tlvs: Tlv[] = [];
      try {
        tlvs = decodeTlvs(frame.payload);
      } catch {
        tlvs = [];
      }
      this.destroy({ kind: 'signoff', clean: true, tlvs, truncated: false });
      return;
    }
    if (frame.type !== FLAP_DATA) return;
    let snac: Snac;
    try {
      snac = decodeSnac(frame.payload);
    } catch (error) {
      this.opts.log.warn('dropped a malformed SNAC', { conn: this.label, error: (error as Error).message });
      return;
    }
    // Any SNAC carrying the liveness request's id proves the link is alive, the 0x01/0x0F reply or an error.
    if (snac.requestId === this.probeRequestId) {
      this.probeRequestId = null;
      if (this.probeDeadline) this.timers.clearTimeout(this.probeDeadline);
      this.probeDeadline = null;
    }
    const waiter = this.pending.get(snac.requestId);
    if (waiter) {
      this.pending.delete(snac.requestId);
      this.timers.clearTimeout(waiter.timer);
      waiter.resolve(snac);
    }
    if (this.snacListeners.length > 0) for (const fn of [...this.snacListeners]) fn(snac);
    else if (!waiter) this.backlog.push(snac);
  }

  get isOpen(): boolean {
    return this.closed === null;
  }

  onSnac(fn: (s: Snac) => void): () => void {
    this.snacListeners.push(fn);
    const queued = this.backlog;
    this.backlog = [];
    for (const snac of queued) fn(snac);
    return () => {
      const i = this.snacListeners.indexOf(fn);
      if (i >= 0) this.snacListeners.splice(i, 1);
    };
  }

  onClose(fn: (i: CloseInfo) => void): () => void {
    if (this.closed) {
      fn(this.closed);
      return () => {};
    }
    this.closeListeners.push(fn);
    return () => {
      const i = this.closeListeners.indexOf(fn);
      if (i >= 0) this.closeListeners.splice(i, 1);
    };
  }

  private sendFrame(type: number, payload?: Uint8Array): void {
    if (this.closed) return;
    this.socket.write(encodeFlap(type, this.seq, payload));
    this.seq = (this.seq + 1) & 0xffff;
  }

  private allocRequestId(): number {
    const id = this.nextRequestId;
    this.nextRequestId = id >= 0x7fffffff ? 1 : id + 1;
    return id;
  }

  send(family: number, subtype: number, body?: Uint8Array, requestId: number = this.allocRequestId()): number {
    this.sendFrame(FLAP_DATA, encodeSnac({ family, subtype, requestId }, body));
    return requestId;
  }

  request(family: number, subtype: number, body?: Uint8Array, timeoutMs: number = REQUEST_TIMEOUT_MS): Promise<Snac> {
    if (this.closed) return Promise.reject(new ConnectionClosedError(this.closed));
    const requestId = this.allocRequestId();
    return new Promise<Snac>((resolve, reject) => {
      const timer = this.timers.setTimeout(() => {
        this.pending.delete(requestId);
        reject(new RequestTimeoutError());
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      this.send(family, subtype, body, requestId);
    });
  }

  private startHeartbeat(): void {
    const keepalive = (): void => {
      this.keepaliveTimer = this.timers.setTimeout(() => {
        this.sendFrame(FLAP_KEEPALIVE);
        keepalive();
      }, KEEPALIVE_INTERVAL_MS);
    };
    // The liveness request is the OService user-info query (0x01,0x0E), answered by 0x01,0x0F. Never use
    // the OService probe (0x01,0x1F): its route exists on every connection but its handler builds a reply
    // with a nil body (foodgroup/oservice.go:365), wire/encode.go:15 refuses to marshal a nil SNAC, and
    // the read loop returns on that error (server/oscar/server.go:620-629), so the server closes the
    // socket. Both server generations do this. The user-info query is in the same route table, so it is
    // answered on the main connection and on a room connection alike.
    const probe = (): void => {
      this.probeTimer = this.timers.setTimeout(() => {
        this.probeRequestId = this.send(FAMILY_OSERVICE, OSERVICE_USER_INFO_QUERY);
        this.probeDeadline = this.timers.setTimeout(() => this.destroy({ kind: 'probe-timeout', clean: false }), PROBE_TIMEOUT_MS);
        probe();
      }, PROBE_INTERVAL_MS);
    };
    keepalive();
    probe();
  }

  close(): void {
    if (this.closed) return;
    this.sendFrame(FLAP_SIGNOFF);
    this.finish({ kind: 'local', clean: true }, false);
    this.socket.end(() => this.socket.destroy());
  }

  destroy(info: CloseInfo = { kind: 'local', clean: true }): void {
    this.finish(info, true);
  }

  private finish(info: CloseInfo, destroy: boolean): void {
    if (this.closed) return;
    this.closed = info;
    for (const t of [this.keepaliveTimer, this.probeTimer, this.probeDeadline]) {
      if (t) this.timers.clearTimeout(t);
    }
    if (destroy) this.socket.destroy();
    const err = new ConnectionClosedError(info);
    for (const waiter of this.pending.values()) {
      this.timers.clearTimeout(waiter.timer);
      waiter.reject(err);
    }
    this.pending.clear();
    this.opts.log.debug('oscar connection closed', { conn: this.label, kind: info.kind });
    for (const fn of [...this.closeListeners]) fn(info);
  }
}

export function openConnection(opts: ConnectionOptions): Promise<OscarConnection> {
  return OscarConnection.open(opts);
}
