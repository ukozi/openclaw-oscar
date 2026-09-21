import { vi } from 'vitest';
import type { Mock } from 'vitest';
import { ChainController } from '../../../src/chain/controller.js';
import type { ChainDeps } from '../../../src/chain/controller.js';
import { roomKeyOf } from '../../../src/chain/types.js';
import type { RoomTurn } from '../../../src/chain/types.js';
import type { RoomMessageEvent, SendPriority, SendReceipt } from '../../../src/oscar/types.js';
import type { RoomRef } from '../../../src/names.js';
import { FakeRunTracker } from '../../fake/run-tracker.js';
import { ROOM, policyFixture, roomFixture } from './fixtures.js';

export const RK = roomKeyOf(ROOM);

export function kit(self = 'botone', over: Partial<ChainDeps> = {}) {
  const state = { policy: policyFixture(), wildcard: false, chunk: 900 };
  const room = roomFixture();
  const tracker = new FakeRunTracker();
  const wakes: { turn: RoomTurn; resolve: () => void; reject: (err: Error) => void }[] = [];
  const sink: {
    wake: Mock<(turn: RoomTurn) => Promise<void>>;
    record: Mock<(ev: RoomMessageEvent) => void>;
    count: Mock<(ev: RoomMessageEvent) => void>;
  } = {
    wake: vi.fn((turn: RoomTurn) => new Promise<void>((resolve, reject) => { wakes.push({ turn, resolve, reject }); })),
    record: vi.fn(),
    count: vi.fn(),
  };
  const say: Mock<(room: RoomRef, markdown: string, opts?: { whisperTo?: string; priority?: SendPriority }) => Promise<SendReceipt>> =
    vi.fn(async () => ({ id: 'receipt', storedOffline: false }));
  const sendIm: Mock<(to: string, text: string) => void> = vi.fn();
  const sk = `sk|${self}`;
  const log: Record<'debug' | 'info' | 'warn' | 'error', Mock<(msg: string, fields?: Record<string, unknown>) => void>> = {
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  };
  const c = new ChainController({
    accountId: self,
    self: () => self,
    policy: () => state.policy,
    ownerWildcard: () => state.wildcard,
    roomChunkLimit: () => state.chunk,
    room: (roomKey) => (roomKey === RK ? room : undefined),
    sessionKeyFor: (roomKey) => (roomKey === RK ? sk : undefined),
    roomKeyForSession: (sessionKey) => (sessionKey === sk ? RK : undefined),
    tracker,
    sink,
    say,
    sendIm,
    log,
    ...over,
  });
  return { c, state, room, tracker, wakes, sink, say, sendIm, sk, log };
}

export function line(from: string, text: string, over: Partial<RoomMessageEvent> = {}): RoomMessageEvent {
  return { room: ROOM, from, fromDisplay: from, text, cookie: 77n, whisper: false, serverGenerated: false, ...over };
}

export async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

export function said(say: ReturnType<typeof kit>['say']): string[] {
  return say.mock.calls.filter((call) => !(call as unknown[])[2]).map((call) => String((call as unknown[])[1]));
}
