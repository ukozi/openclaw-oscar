import { bucpLogin, md5Available, strongHash } from './auth.js';
import { BosClient, ServiceRefusedError } from './bos.js';
import type { ServiceRedirect } from './bos.js';
import { RedirectRefusedError, decideRedirect, isTlsError, isUnroutableHost, openConnection } from './connection.js';
import type { CloseInfo, OscarConnection } from './connection.js';
import {
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  BACKOFF_FACTOR,
  BACKOFF_FLOOR_AFTER_FAILURES,
  BACKOFF_FLOOR_MS,
  BACKOFF_JITTER,
  LOGIN_BUDGET_PER_MINUTE,
  LOGIN_STAGGER_MS,
  SERVER_DISCONNECT_BACKOFF_MS,
  SERVICE_COOKIE_TTL_MS,
  SIGNOFF_TLV_DISCONNECT_REASON,
  STABLE_ONLINE_MS,
  TYPING_KEEPALIVE_MS,
  TYPING_MAX_MS,
} from './constants.js';
import { hasTlv } from './tlv.js';
import { normalizeScreenName } from './text.js';
import { OscarSendError } from './types.js';
import type {
  LoginBudget,
  OscarEvents,
  OscarSessionOptions,
  Presence,
  SendPriority,
  SendReceipt,
  ServiceGrant,
  SessionState,
  StateReason,
  TimerApi,
} from './types.js';

type Timer = ReturnType<typeof setTimeout>;
type Endpoint = { host: string; port: number };

const FATAL: ReadonlySet<StateReason> = new Set<StateReason>([
  'bad-password',
  'unknown-name',
  'suspended',
  'md5-unavailable',
]);
const PRIORITIES: readonly SendPriority[] = ['reply', 'control', 'notice'];

export function connectFailureReason(error: unknown, followedUnroutable: boolean): StateReason {
  if (isTlsError(error)) return 'tls';
  return followedUnroutable ? 'redirect-unroutable' : 'network';
}

export function backoffDelay(failures: number, random: number): number {
  const raw = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * BACKOFF_FACTOR ** Math.max(0, failures - 1));
  const floored = failures >= BACKOFF_FLOOR_AFTER_FAILURES ? Math.max(raw, BACKOFF_FLOOR_MS) : raw;
  return Math.round(floored * (1 + BACKOFF_JITTER * random));
}

// The server allows 10 auth connections per minute per source address, shared by every account behind it.
export function createLoginBudget(
  opts: { perMinute?: number; staggerMs?: number; now?: () => number; timers?: TimerApi } = {},
): LoginBudget {
  const perMinute = opts.perMinute ?? LOGIN_BUDGET_PER_MINUTE;
  const staggerMs = opts.staggerMs ?? LOGIN_STAGGER_MS;
  const now = opts.now ?? Date.now;
  const timers = opts.timers ?? { setTimeout, clearTimeout };
  const grants: number[] = [];
  const waiting: (() => void)[] = [];
  let timer: Timer | null = null;

  const pump = (): void => {
    timer = null;
    while (waiting.length > 0) {
      const t = now();
      while (grants.length > 0 && (grants[0] ?? 0) <= t - 60_000) grants.shift();
      const last = grants[grants.length - 1];
      let wait = last === undefined ? 0 : last + staggerMs - t;
      if (grants.length >= perMinute) wait = Math.max(wait, (grants[0] ?? 0) + 60_000 - t);
      if (wait > 0) {
        timer = timers.setTimeout(pump, wait);
        return;
      }
      grants.push(t);
      waiting.shift()?.();
    }
  };

  return {
    take() {
      return new Promise<void>((resolve) => {
        waiting.push(resolve);
        if (timer === null) pump();
      });
    },
  };
}

type Job = { run: () => Promise<SendReceipt>; resolve: (r: SendReceipt) => void; reject: (e: Error) => void };

class SendQueue {
  private readonly lanes: Record<SendPriority, Job[]> = { reply: [], control: [], notice: [] };
  private busy = false;

  push(priority: SendPriority, run: () => Promise<SendReceipt>): Promise<SendReceipt> {
    return new Promise<SendReceipt>((resolve, reject) => {
      this.lanes[priority].push({ run, resolve, reject });
      void this.pump();
    });
  }

  failAll(error: Error): void {
    for (const p of PRIORITIES) for (const job of this.lanes[p].splice(0)) job.reject(error);
  }

  private async pump(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (;;) {
        const job = PRIORITIES.map((p) => this.lanes[p]).find((lane) => lane.length > 0)?.shift();
        if (!job) return;
        await job.run().then(job.resolve, job.reject);
      }
    } finally {
      this.busy = false;
    }
  }
}

type Listeners = { [E in keyof OscarEvents]: Set<(payload: OscarEvents[E]) => void> };

export class OscarSessionImpl {
  private readonly now: () => number;
  private readonly timers: TimerApi;
  private readonly listeners: Listeners = {
    state: new Set(),
    im: new Set(),
    invite: new Set(),
    roomMessage: new Set(),
    roomJoin: new Set(),
    roomLeave: new Set(),
    roomReady: new Set(),
    roomClosed: new Set(),
    presence: new Set(),
    rate: new Set(),
  };
  private readonly channel2Listeners = new Set<(icbmBody: Uint8Array) => void>();
  private readonly queue = new SendQueue();
  private readonly typing = new Map<string, { timer: Timer; stopAt: number }>();
  private state: SessionState;
  private generation = 0;
  private failures = 0;
  private onlineSince = 0;
  private retryTimer: Timer | null = null;
  private bos: BosClient | null = null;
  private pendingConn: OscarConnection | null = null;
  private self: { screenName: string; bot: boolean } | null = null;

  constructor(private readonly opts: OscarSessionOptions) {
    this.now = opts.now ?? Date.now;
    this.timers = opts.timers ?? { setTimeout, clearTimeout };
    this.state = { phase: 'idle', since: this.now(), attempts: 0 };
  }

  on<E extends keyof OscarEvents>(event: E, fn: (payload: OscarEvents[E]) => void): () => void {
    this.listeners[event].add(fn);
    return () => {
      this.listeners[event].delete(fn);
    };
  }

  // Invites arrive as raw channel 2 frames; the room code turns them into `invite` events.
  onChannel2(fn: (icbmBody: Uint8Array) => void): () => void {
    this.channel2Listeners.add(fn);
    return () => {
      this.channel2Listeners.delete(fn);
    };
  }

  private emit<E extends keyof OscarEvents>(event: E, payload: OscarEvents[E]): void {
    for (const fn of [...this.listeners[event]]) {
      try {
        fn(payload);
      } catch (error) {
        this.opts.log.error('oscar event listener threw', { event, error: (error as Error).message });
      }
    }
  }

  private setState(phase: SessionState['phase'], reason?: StateReason, detail?: string): void {
    const next: SessionState = { phase, since: this.now(), attempts: this.failures };
    if (reason) next.reason = reason;
    if (detail) next.detail = detail;
    this.state = next;
    this.opts.log.info('oscar session state', { screenName: this.opts.screenName, phase, reason, detail });
    this.emit('state', next);
  }

  getState(): SessionState {
    return this.state;
  }

  selfInfo(): { screenName: string; bot: boolean } | null {
    return this.self;
  }

  presenceOf(name: string): Presence | undefined {
    return this.bos?.presenceOf(name);
  }

  start(): void {
    if (this.state.phase !== 'idle' && this.state.phase !== 'stopped' && this.state.phase !== 'fatal') return;
    this.failures = 0;
    void this.attempt(++this.generation);
  }

  async stop(): Promise<void> {
    this.generation++;
    if (this.retryTimer) this.timers.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const bos = this.bos;
    this.dropBos(new OscarSendError('closed'));
    bos?.conn.close();
    this.pendingConn?.destroy();
    this.pendingConn = null;
    if (this.state.phase !== 'stopped') this.setState('stopped');
  }

  private configured(): Endpoint & { tls: boolean } {
    return { host: this.opts.host, port: this.opts.port, tls: this.opts.tls };
  }

  private open(target: Endpoint, label: string, cookie?: Uint8Array): Promise<OscarConnection> {
    return openConnection({
      host: target.host,
      port: target.port,
      tls: this.opts.tls,
      caFile: this.opts.caFile,
      cookie,
      label,
      log: this.opts.log,
      timers: this.timers,
    });
  }

  private async attempt(gen: number): Promise<void> {
    const live = (): boolean => gen === this.generation;
    this.setState('connecting');
    if (!md5Available()) {
      this.fail(gen, 'md5-unavailable', 'this Node build disables MD5');
      return;
    }
    // A screen-name TLV under 2 bytes panics the server, so such a name never reaches the wire.
    if (Buffer.byteLength(this.opts.screenName, 'utf8') < 2) {
      this.fail(gen, 'unknown-name', 'screen name too short');
      return;
    }
    await this.opts.loginBudget.take();
    if (!live()) return;

    let target: Endpoint = this.configured();
    let unroutable = false;
    try {
      const auth = await this.open(target, 'auth');
      if (!live()) return auth.destroy();
      const login = await bucpLogin(auth, this.timers, this.opts.screenName, this.opts.port, async (key) =>
        strongHash(await this.opts.getPassword(), key),
      );
      if (!live()) return;
      if (!login.ok) {
        this.fail(gen, login.reason, login.detail);
        return;
      }
      const decision = decideRedirect(this.opts.redirect, this.configured(), login);
      if (decision.refused) {
        this.fail(gen, decision.refused, new RedirectRefusedError(`${login.host}:${login.port}`).message);
        return;
      }
      if (decision.pinned && decision.why !== 'mode') {
        this.opts.log.info('ignoring the advertised BOS address', { why: decision.why, advertised: `${login.host}:${login.port}` });
      }
      target = decision;
      unroutable = !decision.pinned && isUnroutableHost(decision.host) && !isUnroutableHost(this.opts.host);

      const conn = await this.open(target, 'bos', login.cookie);
      if (!live()) return conn.destroy();
      this.pendingConn = conn;
      const bos = new BosClient(conn, {
        log: this.opts.log,
        now: this.now,
        timers: this.timers,
        defaultPort: this.opts.port,
        callbacks: {
          im: (e) => this.emit('im', e),
          presence: (e) => this.emit('presence', e),
          rate: (status) => this.emit('rate', { scope: 'bos', status }),
          channel2: (icbmBody) => {
            for (const fn of [...this.channel2Listeners]) fn(icbmBody);
          },
        },
      });
      let closedEarly: CloseInfo | null = null;
      conn.onClose((info) => {
        if (this.bos === bos) this.onBosClosed(gen, bos, info);
        else closedEarly = info;
      });
      let self: { screenName: string; bot: boolean };
      try {
        self = await bos.bringUp(this.opts.buddies());
      } catch (error) {
        conn.destroy();
        if (live()) {
          this.pendingConn = null;
          this.failFromClose(gen, closedEarly, error);
        }
        return;
      }
      if (!live()) return conn.destroy();
      this.pendingConn = null;
      this.bos = bos;
      this.self = self;
      this.onlineSince = this.now();
      this.setState('online');
      if (!conn.isOpen) {
        this.onBosClosed(gen, bos, closedEarly ?? { kind: 'eof', clean: false });
        return;
      }
    } catch (error) {
      if (!live()) return;
      this.fail(gen, connectFailureReason(error, unroutable), (error as Error).message);
    }
  }

  private failFromClose(gen: number, info: CloseInfo | null, error: unknown): void {
    if (info && info.kind === 'signoff' && hasTlv(info.tlvs, SIGNOFF_TLV_DISCONNECT_REASON)) {
      this.fail(gen, 'disconnected-by-server', this.disconnectDetail(null));
      return;
    }
    this.fail(gen, 'network', (error as Error).message);
  }

  private disconnectDetail(bos: BosClient | null): string {
    return bos?.sawRateTrouble() ? 'rate limit' : 'signed on elsewhere or kicked';
  }

  private dropBos(error: Error): void {
    this.bos = null;
    for (const name of [...this.typing.keys()]) this.clearTyping(name);
    this.queue.failAll(error);
  }

  private onBosClosed(gen: number, bos: BosClient, info: CloseInfo): void {
    if (gen !== this.generation || this.bos !== bos) return;
    if (this.now() - this.onlineSince >= STABLE_ONLINE_MS) this.failures = 0;
    this.dropBos(new OscarSendError('closed'));
    // TLV 0x09 is what eviction by a newer login, a rate-limit disconnect, queue overflow and an operator kick all look like.
    if (info.kind === 'signoff' && hasTlv(info.tlvs, SIGNOFF_TLV_DISCONNECT_REASON)) {
      this.fail(gen, 'disconnected-by-server', this.disconnectDetail(bos));
      return;
    }
    const detail = info.kind === 'error' ? info.error.message : info.kind;
    this.fail(gen, info.kind === 'error' && isTlsError(info.error) ? 'tls' : 'network', detail);
  }

  private fail(gen: number, reason: StateReason, detail: string): void {
    if (gen !== this.generation) return;
    this.failures++;
    if (FATAL.has(reason)) {
      this.generation++;
      this.setState('fatal', reason, detail);
      return;
    }
    let delay = backoffDelay(this.failures, Math.random());
    // Two gateways on one screen name would otherwise evict each other in a tight loop, and a
    // limited login only burns another token from the address-wide budget.
    if (reason === 'disconnected-by-server' || reason === 'login-rate-limited') {
      delay = Math.max(delay, SERVER_DISCONNECT_BACKOFF_MS);
    }
    this.setState('backoff', reason, detail);
    this.retryTimer = this.timers.setTimeout(() => {
      this.retryTimer = null;
      void this.attempt(gen);
    }, delay);
  }

  updateBuddies(): void {
    this.bos?.setBuddies(this.opts.buddies());
  }

  sendIm(to: string, html: string, opts?: { priority?: SendPriority }): Promise<SendReceipt> {
    if (!this.bos) return Promise.reject(new OscarSendError('not-online'));
    return this.queue.push(opts?.priority ?? 'reply', () => {
      const bos = this.bos;
      return bos ? bos.sendIm(to, html) : Promise.reject(new OscarSendError('not-online'));
    });
  }

  private clearTyping(name: string): void {
    const entry = this.typing.get(name);
    if (entry) this.timers.clearTimeout(entry.timer);
    this.typing.delete(name);
  }

  sendTyping(to: string, state: 'typing' | 'typed' | 'none'): void {
    const bos = this.bos;
    if (!bos) return;
    const name = normalizeScreenName(to);
    const stopAt = this.typing.get(name)?.stopAt ?? this.now() + TYPING_MAX_MS;
    this.clearTyping(name);
    bos.sendTyping(to, state);
    if (state !== 'typing') return;
    const timer = this.timers.setTimeout(() => {
      this.sendTyping(to, this.now() >= stopAt ? 'none' : 'typing');
    }, TYPING_KEEPALIVE_MS);
    this.typing.set(name, { timer, stopAt });
  }

  async setAway(text: string | null): Promise<void> {
    if (!this.bos) throw new OscarSendError('not-online');
    this.bos.setAway(text);
  }

  // The one place a BOS service request (0x01/0x04) is made; rooms come here for ChatNav and Chat.
  // With TLS every request carries TLV 0x8C. A v0.24.0 listener without an SSL address answers that
  // with 0x01/0x01, so ask once more without it and stay on the configured address. The cookie in
  // the answer works for 60 s.
  async resolveService(family: number, roomInfo?: Uint8Array): Promise<ServiceGrant> {
    const bos = this.bos;
    if (!bos) throw new OscarSendError('not-online');
    const base = roomInfo ? { roomInfo } : {};
    const grant = (where: Endpoint, cookie: Uint8Array, pinned: boolean): ServiceGrant => ({
      host: where.host,
      port: where.port,
      cookie,
      pinned,
      expiresAt: this.now() + SERVICE_COOKIE_TTL_MS,
    });
    let r: ServiceRedirect;
    try {
      r = await bos.requestService(family, { ...base, useSsl: this.opts.tls });
    } catch (error) {
      if (!this.opts.tls || !(error instanceof ServiceRefusedError)) throw error;
      const plain = await bos.requestService(family, { ...base, useSsl: false });
      return grant(this.configured(), plain.cookie, true);
    }
    const where = decideRedirect(this.opts.redirect, this.configured(), r);
    if (where.refused) throw new RedirectRefusedError(`${r.host}:${r.port}`);
    return grant(where, r.cookie, where.pinned);
  }
}
