import type { ChannelBotLoopProtectionFacts } from 'openclaw/plugin-sdk/channel-inbound';
import { formatTarget } from '../names.js';
import type { RoomRef, Target } from '../names.js';
import type { RoomMessageEvent } from '../oscar/types.js';
import type { OriginClass } from '../policy.js';

export type TimerHandle = ReturnType<typeof setTimeout>;
export type Timers = {
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
};
export const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};
export type Clock = () => number;

export type WakeWhy = 'named' | 'lead' | 'floor' | 'invited' | 'handoff' | 'review' | 'takeover';

export type UntrustedFact = { label: string; source?: string; type?: string; payload: unknown };

export type RoomTurn = {
  room: RoomRef;
  sender: string;
  originator: string;
  origin: OriginClass;
  why: WakeWhy;
  body: string;
  systemPrompt: string;
  commandAuthorized: boolean;
  cookie: bigint;
  untrusted?: UntrustedFact[];
  botLoopProtection?: ChannelBotLoopProtectionFacts;
};

export type RoomSink = {
  wake(turn: RoomTurn): Promise<void>;
  record(ev: RoomMessageEvent): void;
  count(ev: RoomMessageEvent): void;
};

export type OutboundKind = 'final' | 'block' | 'tool' | 'send' | 'plugin';
export type OutboundFormat = 'markdown' | 'wire';
export type OutboundMeta = { accountId: string; target: Target; kind: OutboundKind; format?: OutboundFormat };

export function roomKeyOf(room: RoomRef): string {
  return formatTarget({ kind: 'room', room });
}
