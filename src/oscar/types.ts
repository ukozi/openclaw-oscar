type LogFn = (msg: string, f?: Record<string, unknown>) => void;
export type Logger = { debug: LogFn; info: LogFn; warn: LogFn; error: LogFn };

export type TimerApi = { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };

export type RoomRef = { exchange: 4 | 5; name: string };

export type SessionPhase = 'idle' | 'connecting' | 'online' | 'backoff' | 'stopped' | 'fatal';
export type StateReason =
  | 'bad-password'
  | 'unknown-name'
  | 'suspended'
  | 'login-rate-limited'
  | 'redirect-unroutable'
  | 'disconnected-by-server'
  | 'md5-unavailable'
  | 'network'
  | 'tls'
  | 'unauthenticated-server';
export type SessionState = { phase: SessionPhase; reason?: StateReason; detail?: string; since: number; attempts: number };

export type Presence = { online: boolean; away: boolean; bot: boolean; at: number };

export type ImEvent = {
  from: string;
  fromDisplay: string;
  text: string;
  cookie: bigint;
  autoResponse: boolean;
  offline: boolean;
  sentAt?: number;
  system: boolean;
};
export type InviteEvent = { from: string; fromDisplay: string; room: RoomRef; roomCookie: string; text: string };
export type RoomMessageEvent = {
  room: RoomRef;
  from: string;
  fromDisplay: string;
  text: string;
  cookie: bigint;
  whisper: boolean;
};
export type RoomRosterEvent = { room: RoomRef; name: string; display: string };
export type RoomClosedEvent = { room: RoomRef; willRejoin: boolean };
export type RateEvent = { scope: 'bos' | RoomRef; status: 'clear' | 'alert' | 'limited' };

export type OscarEvents = {
  state: SessionState;
  im: ImEvent;
  invite: InviteEvent;
  roomMessage: RoomMessageEvent;
  roomJoin: RoomRosterEvent;
  roomLeave: RoomRosterEvent;
  roomReady: { room: RoomRef; occupants: string[] };
  roomClosed: RoomClosedEvent;
  presence: { name: string } & Presence;
  rate: RateEvent;
};

export type SendPriority = 'reply' | 'control' | 'notice';
export type SendReceipt = { id: string; storedOffline: boolean };
// A service redirect after the redirect rule: where to dial, the 60 s cookie, whether the configured
// address replaced the advertised one, and when the cookie stops working (session clock, ms).
export type ServiceGrant = { host: string; port: number; cookie: Uint8Array; pinned: boolean; expiresAt: number };
export type SendErrorCode =
  | 'rate-limited'
  | 'not-online'
  | 'recipient-unavailable'
  | 'room-not-joined'
  | 'too-long'
  | 'closed';

export class OscarSendError extends Error {
  readonly code: SendErrorCode;

  constructor(code: SendErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'OscarSendError';
    this.code = code;
  }
}

export type PasswordCheck = 'checks' | 'does-not-check' | 'unknown';

export type LoginBudget = { take(): Promise<void> };

export type OscarSessionOptions = {
  host: string;
  port: number;
  tls: boolean;
  caFile?: string | undefined;
  redirect: 'auto' | 'follow' | 'pin';
  screenName: string;
  getPassword: () => Promise<string>;
  buddies: () => string[];
  log: Logger;
  loginBudget: LoginBudget;
  now?: () => number;
  timers?: TimerApi;
};

export interface OscarSession {
  start(): void;
  stop(): Promise<void>;
  getState(): SessionState;
  on<E extends keyof OscarEvents>(event: E, fn: (payload: OscarEvents[E]) => void): () => void;
  selfInfo(): { screenName: string; bot: boolean } | null;
  presenceOf(name: string): Presence | undefined;
  updateBuddies(): void;
  sendIm(to: string, html: string, opts?: { priority?: SendPriority }): Promise<SendReceipt>;
  sendTyping(to: string, state: 'typing' | 'typed' | 'none'): void;
  setAway(text: string | null): Promise<void>;
  probePasswordCheck(): Promise<PasswordCheck>;
  joinRoom(room: RoomRef, opts?: { persistent?: boolean }): Promise<void>;
  joinInvited(invite: InviteEvent): Promise<void>;
  leaveRoom(room: RoomRef): Promise<void>;
  rooms(): { room: RoomRef; occupants: string[]; joinedAt: number }[];
  sendRoom(room: RoomRef, html: string, opts?: { whisperTo?: string; priority?: SendPriority }): Promise<SendReceipt>;
}

export type SnacIn = { family: number; subtype: number; requestId: number; body: Uint8Array };
export type LinkClose = { clean: boolean };
export interface SnacLink {
  send(family: number, subtype: number, body: Uint8Array): number;
  request(family: number, subtype: number, body: Uint8Array, timeoutMs?: number): Promise<SnacIn>;
  onSnac(fn: (snac: SnacIn) => void): () => void;
  onClose(fn: (info: LinkClose) => void): () => void;
  close(): void;
}
export type RoomErrorCode = 'no-such-room' | 'too-long' | 'not-online' | 'unavailable';
export class OscarRoomError extends Error {
  readonly code: RoomErrorCode;
  constructor(code: RoomErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'OscarRoomError';
    this.code = code;
  }
}
