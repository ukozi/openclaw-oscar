import { SignOnError, adapterTicketSource, backoffDelay } from 'open-oscar-client-kit/client';
import type { DropEvidence, IssuedTicket, ReconnectPolicy, TicketRequest } from 'open-oscar-client-kit/client';
import {
  ConnectionClosedError,
  OscarDecodeError,
  PASSWORD_CHECK_CACHE_MS,
  RATE_RECENT_MS,
  RequestTimeoutError,
  SERVER_DISCONNECT_BACKOFF_MS,
  STABLE_ONLINE_MS,
  isTlsError,
  normalizeScreenName,
  strongHash,
} from 'open-oscar-client-kit/wire';
import { toDirectImOfferEvent, toDirectMessageEvent, toFileOfferEvent, toImEvent, toInviteEvent, toTransferEvent } from './events.js';
import { makeKitClient } from './kit-client.js';
import type { KitClient } from './kit-client.js';
import { login, probeLogin } from './login.js';
import type { LoginOutcome } from './login.js';
import { RoomList } from './room-list.js';
import { SendQueue, Typing, sendWithResend, toSendError } from './send.js';
import { OscarSendError } from './types.js';
import type {
  FileSink,
  InviteEvent,
  OscarEvents,
  OscarSession,
  OscarSessionOptions,
  OutgoingFile,
  OutgoingPicture,
  PasswordCheck,
  Presence,
  RoomRef,
  SendPriority,
  SendReceipt,
  SessionState,
  StateReason,
  TimerApi,
} from './types.js';

const FATAL: ReadonlySet<StateReason> = new Set<StateReason>(['bad-password', 'unknown-name', 'suspended', 'md5-unavailable']);
const EVENTS = [
  'state',
  'im',
  'invite',
  'roomMessage',
  'roomJoin',
  'roomLeave',
  'roomReady',
  'roomClosed',
  'presence',
  'rate',
  'directImOffer',
  'directIm',
  'directMessage',
  'fileOffer',
  'transfer',
] as const;

type Listeners = { [E in keyof OscarEvents]: Set<(payload: OscarEvents[E]) => void> };
type Failure = [reason: StateReason, detail: string];

const messageOf = (error: unknown): string | undefined => (error instanceof Error ? error.message : undefined);
// An error of the link itself means the connection opened.
const afterConnect = (cause: unknown): boolean =>
  cause instanceof ConnectionClosedError || cause instanceof RequestTimeoutError || cause instanceof OscarDecodeError;

export class KitSession implements OscarSession {
  // The client never retries by itself: each attempt takes this session's one path.
  readonly reconnect: ReconnectPolicy = {
    next: (input) => {
      this.evidence = input.evidence;
      return { retry: false, reason: { kind: 'unreachable' } };
    },
  };
  private readonly client: KitClient;
  private readonly now: () => number;
  private readonly timers: TimerApi;
  private readonly listeners = Object.fromEntries(EVENTS.map((event) => [event, new Set()])) as Listeners;
  private readonly queue = new SendQueue();
  private readonly typing: Typing;
  private readonly roomList: RoomList;
  private readonly seenAt = new Map<string, number>();
  // Direct IM sessions that have not ended, and whether each one opened.
  private readonly directIms = new Map<string, boolean>();
  private state: SessionState;
  private generation = 0;
  private failures = 0;
  private onlineSince = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private self: { screenName: string } | null = null;
  private outcome: LoginOutcome | null = null;
  private evidence: DropEvidence | null = null;
  private limited = false;
  private limitedAt: number | null = null;
  private everOnline = false;
  private passwordCheck: { result: PasswordCheck; at: number } | null = null;
  private probing: Promise<PasswordCheck> | null = null;

  constructor(
    private readonly opts: OscarSessionOptions,
    client?: KitClient,
  ) {
    this.now = opts.now ?? Date.now;
    this.timers = opts.timers ?? { setTimeout, clearTimeout };
    this.state = { phase: 'idle', since: this.now(), attempts: 0 };
    this.client = client ?? makeKitClient(opts, { reconnect: this.reconnect });
    const online = (): KitClient | null => (this.isOnline() ? this.client : null);
    this.typing = new Typing({ client: online, limited: () => this.limited, now: this.now, timers: this.timers });
    this.roomList = new RoomList({
      client: () => this.client,
      isOnline: () => this.isOnline(),
      emit: (event, payload) => this.emit(event, payload),
      log: opts.log,
      now: this.now,
      timers: this.timers,
      random: Math.random,
    });
    this.client.on('state', (s) => {
      if (s.state === 'offline' && this.isOnline()) this.dropped();
    });
    this.client.on('im', (im) => this.emit('im', toImEvent(im)));
    this.client.on('roomInvite', (invite) => {
      this.emit('invite', toInviteEvent(invite));
      // No invitation stays open here, so none may count toward the client's cap.
      this.client.forgetInvite(invite.id);
    });
    this.client.on('presence', (p) => {
      const name = normalizeScreenName(p.screenName);
      this.seenAt.set(name, this.now());
      this.emit('presence', { name, online: p.online, away: p.away, at: this.now() });
    });
    this.client.on('rate', ({ limited }) => {
      if (limited || this.limited) this.limitedAt = this.now();
      this.limited = limited;
      this.emit('rate', { scope: 'bos', status: limited ? 'limited' : 'clear' });
    });
    this.client.on('directImOffer', (offer) => this.emit('directImOffer', toDirectImOfferEvent(offer)));
    this.client.on('directIm', (s) => {
      // The client reports an open session again when the peer shows the cookie.
      const repeat = s.state === 'open' && this.directIms.get(s.id) === true;
      if (s.state === 'closed') this.directIms.delete(s.id);
      else this.directIms.set(s.id, s.state === 'open');
      if (repeat || (s.state !== 'open' && s.state !== 'closed')) return;
      this.emit('directIm', {
        id: s.id,
        peer: normalizeScreenName(s.peer),
        role: s.role,
        state: s.state,
        ...(s.end === undefined ? {} : { end: s.end }),
        ...(s.by === undefined ? {} : { by: s.by }),
      });
    });
    this.client.on('directMessage', (message) => {
      if (this.directIms.has(message.id)) this.emit('directMessage', toDirectMessageEvent(message));
    });
    this.client.on('fileOffer', (offer) => this.emit('fileOffer', toFileOfferEvent(offer)));
    this.client.on('transfer', (t) => this.emit('transfer', toTransferEvent(t)));
  }

  on<E extends keyof OscarEvents>(event: E, fn: (payload: OscarEvents[E]) => void): () => void {
    this.listeners[event].add(fn);
    return () => {
      this.listeners[event].delete(fn);
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

  private isOnline(): boolean {
    return this.state.phase === 'online';
  }

  getState(): SessionState {
    return this.state;
  }

  selfInfo(): { screenName: string } | null {
    return this.self;
  }

  presenceOf(name: string): Presence | undefined {
    const p = this.isOnline() ? this.client.presenceOf(name) : undefined;
    return p && { online: p.online, away: p.away, at: this.seenAt.get(normalizeScreenName(name)) ?? this.now() };
  }

  start(): void {
    if (this.state.phase !== 'idle' && this.state.phase !== 'stopped' && this.state.phase !== 'fatal') return;
    this.failures = 0;
    void this.attempt(++this.generation);
  }

  async stop(): Promise<void> {
    this.generation++;
    this.roomList.stop();
    if (this.retryTimer) this.timers.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.down();
    if (this.state.phase !== 'stopped') this.setState('stopped');
    await this.client.signOff();
  }

  private async attempt(gen: number): Promise<void> {
    this.setState('connecting');
    await this.opts.loginBudget.take();
    if (gen !== this.generation) return;
    this.outcome = null;
    this.evidence = null;
    this.limitedAt = null;
    try {
      const source = adapterTicketSource((request) => this.ticket(request));
      const result = await this.client.signOnWith(source, { host: this.opts.host, port: this.opts.port });
      if (gen !== this.generation || result !== 'online') return;
    } catch (error) {
      if (gen === this.generation) this.fail(gen, ...this.signOnFailure(error));
      return;
    }
    this.self = { screenName: this.client.self?.screenName ?? this.opts.screenName };
    this.everOnline = true;
    this.onlineSince = this.now();
    this.setState('online');
    this.roomList.online();
  }

  private async ticket(request: TicketRequest): Promise<IssuedTicket> {
    const o = this.opts;
    const out = await login({
      host: o.host,
      port: o.port,
      tls: o.tls,
      caFile: o.caFile,
      redirect: o.redirect,
      screenName: o.screenName,
      hash: async (key) => strongHash(await o.getPassword(), key),
      log: o.log,
      timers: this.timers,
      track: request.track,
    });
    this.outcome = out;
    if (!out.ok) throw new SignOnError({ kind: 'unreachable' });
    return { ticket: { host: out.host, port: out.port, cookie: out.cookie }, source: 'adapter', obtainedAt: this.now(), expiresAt: null };
  }

  private signOnFailure(error: unknown): Failure {
    const out = this.outcome;
    if (out && !out.ok) return [out.reason, out.detail ?? ''];
    const evidence = error instanceof SignOnError ? error.evidence : undefined;
    if (evidence?.kind === 'signed-off') return ['disconnected-by-server', this.disconnectDetail()];
    const cause = error instanceof SignOnError ? error.cause : error;
    const detail = messageOf(cause) ?? evidence?.kind ?? 'unreachable';
    if (isTlsError(cause)) return ['tls', detail];
    const connect = evidence?.kind === 'connect-refused' || (evidence?.kind === 'unreachable' && cause !== undefined && !afterConnect(cause));
    return [connect && out?.followedUnroutable ? 'redirect-unroutable' : 'network', detail];
  }

  // A sign-off with a reason is what a newer login, a rate-limit disconnect and an operator kick all look like.
  private disconnectDetail(): string {
    const recent = this.limitedAt !== null && this.now() - this.limitedAt <= RATE_RECENT_MS;
    return this.limited || recent ? 'rate limit' : 'signed on elsewhere or kicked';
  }

  private down(): void {
    this.typing.clearAll();
    this.seenAt.clear();
    this.queue.failAll(new OscarSendError('closed'));
  }

  private dropped(): void {
    const evidence = this.evidence;
    const detail = this.disconnectDetail();
    this.roomList.offline();
    if (this.now() - this.onlineSince >= STABLE_ONLINE_MS) this.failures = 0;
    this.down();
    if (evidence?.kind === 'signed-off') this.fail(this.generation, 'disconnected-by-server', detail);
    else this.fail(this.generation, 'network', evidence?.kind === 'closed' ? evidence.close : (evidence?.kind ?? 'closed'));
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
    // Two gateways on one screen name would evict each other in a tight loop, and a limited login only burns another token.
    if (reason === 'disconnected-by-server' || reason === 'login-rate-limited') delay = Math.max(delay, SERVER_DISCONNECT_BACKOFF_MS);
    this.setState('backoff', reason, detail);
    this.retryTimer = this.timers.setTimeout(() => {
      this.retryTimer = null;
      void this.attempt(gen);
    }, delay);
  }

  joinRoom(room: RoomRef, opts?: { persistent?: boolean }): Promise<void> {
    return this.roomList.joinRoom(room, opts);
  }

  joinInvited(invite: InviteEvent): Promise<void> {
    return this.roomList.joinInvited(invite);
  }

  leaveRoom(room: RoomRef): Promise<void> {
    return this.roomList.leaveRoom(room);
  }

  rooms(): { room: RoomRef; occupants: string[]; joinedAt: number }[] {
    return this.roomList.rooms();
  }

  sendRoom(room: RoomRef, html: string, opts?: { whisperTo?: string; priority?: SendPriority }): Promise<SendReceipt> {
    return this.roomList.sendRoom(room, html, opts);
  }

  probePasswordCheck(): Promise<PasswordCheck> {
    const cached = this.passwordCheck;
    if (cached && this.now() - cached.at < PASSWORD_CHECK_CACHE_MS) return Promise.resolve(cached.result);
    // Only after a real login: on a server with auth disabled, probing a missing name would create it.
    if (!this.everOnline) return Promise.resolve('unknown');
    // Callers that overlap share one probe; each probe costs a slot in the server's per-address login limiter.
    this.probing ??= this.runProbe().finally(() => {
      this.probing = null;
    });
    return this.probing;
  }

  private async runProbe(): Promise<PasswordCheck> {
    const { host, port, tls, caFile, screenName, log } = this.opts;
    const result = await this.opts.loginBudget.take().then(
      () => probeLogin({ host, port, tls, caFile, screenName, log, timers: this.timers }),
      () => 'unknown' as const,
    );
    if (result !== 'unknown') this.passwordCheck = { result, at: this.now() };
    return result;
  }

  updateBuddies(): void {
    if (!this.isOnline()) return;
    this.client.refreshSessionBuddies().catch((error: unknown) => {
      this.opts.log.warn('buddy list update failed', { error: messageOf(error) });
    });
  }

  sendIm(to: string, html: string, opts?: { priority?: SendPriority; auto?: boolean }): Promise<SendReceipt> {
    const send = (): Promise<SendReceipt> =>
      this.isOnline() ? sendWithResend(this.client, to, html, opts?.auto === true) : Promise.reject(new OscarSendError('not-online'));
    return this.isOnline() ? this.queue.push(opts?.priority ?? 'reply', send) : send();
  }

  sendTyping(to: string, state: 'typing' | 'typed' | 'none'): void {
    this.typing.send(to, state);
  }

  async setAway(text: string | null): Promise<void> {
    if (!this.isOnline()) throw new OscarSendError('not-online');
    await this.client.setAway(text === null ? null : { html: text }).catch((error: unknown) => {
      throw toSendError(error);
    });
  }

  acceptDirectIm(id: string): Promise<void> {
    return this.client.acceptDirectIm(id);
  }

  declineDirectIm(id: string): Promise<void> {
    return this.client.declineDirectIm(id);
  }

  closeDirectIm(id: string): Promise<void> {
    return this.client.closeDirectIm(id);
  }

  acceptFileOffer(id: string, sink: FileSink): Promise<void> {
    return this.client.acceptFileOffer(id, sink);
  }

  declineFileOffer(id: string): Promise<void> {
    return this.client.declineFileOffer(id);
  }

  cancelTransfer(id: string): Promise<void> {
    return this.client.cancelTransfer(id);
  }

  async sendFiles(to: string, files: readonly OutgoingFile[]): Promise<string> {
    if (!this.isOnline()) throw new OscarSendError('not-online');
    return this.client.sendFiles(to, files);
  }

  async openDirectIm(to: string): Promise<string> {
    if (!this.isOnline()) throw new OscarSendError('not-online');
    return this.client.openDirectIm(to);
  }

  async sendDirectMessage(id: string, message: { pictures: readonly OutgoingPicture[] }): Promise<void> {
    if (!this.isOnline()) throw new OscarSendError('not-online');
    await this.client.sendDirectMessage(id, { pictures: message.pictures });
  }

  async setOwnIcon(bytes: Uint8Array): Promise<void> {
    if (!this.isOnline()) throw new OscarSendError('not-online');
    await this.client.setOwnIcon(bytes);
  }
}

export function createOscarSession(opts: OscarSessionOptions): OscarSession {
  return new KitSession(opts);
}
