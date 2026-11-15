import type { LoginBudget } from 'open-oscar-client-kit/client';
import type { Logger, RoomRef, SendPriority, SendReceipt, StateReason, TimerApi } from 'open-oscar-client-kit/wire';

export type { LoginBudget } from 'open-oscar-client-kit/client';
export { OscarRoomError, OscarSendError } from 'open-oscar-client-kit/wire';
export type {
  LinkClose,
  Logger,
  RoomErrorCode,
  RoomRef,
  SendErrorCode,
  SendPriority,
  SendReceipt,
  ServiceGrant,
  SnacIn,
  SnacLink,
  StateReason,
  TimerApi,
} from 'open-oscar-client-kit/wire';

export type SessionPhase = 'idle' | 'connecting' | 'online' | 'backoff' | 'stopped' | 'fatal';
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
  // true when the server wrote this line itself in place of what a member sent, attributing it to its
  // own pseudo user. It is a real room event, but nobody in the room said it.
  serverGenerated: boolean;
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

export type PasswordCheck = 'checks' | 'does-not-check' | 'unknown';

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
  sendIm(to: string, html: string, opts?: { priority?: SendPriority; auto?: boolean }): Promise<SendReceipt>;
  sendTyping(to: string, state: 'typing' | 'typed' | 'none'): void;
  setAway(text: string | null): Promise<void>;
  probePasswordCheck(): Promise<PasswordCheck>;
  joinRoom(room: RoomRef, opts?: { persistent?: boolean }): Promise<void>;
  joinInvited(invite: InviteEvent): Promise<void>;
  leaveRoom(room: RoomRef): Promise<void>;
  rooms(): { room: RoomRef; occupants: string[]; joinedAt: number }[];
  sendRoom(room: RoomRef, html: string, opts?: { whisperTo?: string; priority?: SendPriority }): Promise<SendReceipt>;
}
