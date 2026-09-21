import { vi } from 'vitest';
import type { RootPolicy } from '../../src/config.js';
import { attachRooms } from '../../src/inbound/home.js';
import { recordRoomLine } from '../../src/inbound/room.js';
import type { InboundRunner, RoomDeps, TurnRequest } from '../../src/inbound/room.js';
import type { RoomRef } from '../../src/names.js';
import { createOscarSession } from '../../src/oscar/index.js';
import type { OscarSession } from '../../src/oscar/index.js';
import { clearRuntime, setRuntime } from '../../src/runtime.js';
import type { AccountRuntime } from '../../src/runtime.js';
import { createInboundKernel } from '../fake/openclaw.js';
import { FakeOscarServer } from '../fake/oscar-server.js';
import { policyFixture, silentLog } from '../unit/rooms-fixtures.js';
import { fastClock } from './room-kit.js';

const PASSWORD = 'hunter22';

export type RoomFlow = {
  server: FakeOscarServer;
  session: OscarSession;
  rt: AccountRuntime;
  deps: RoomDeps;
  turns: TurnRequest[];
  notices: { name: string; display: string }[];
  ownerNotes: string[];
  closed: { room: RoomRef; willRejoin: boolean }[];
  kernel: ReturnType<typeof createInboundKernel>;
  policy(): RootPolicy;
  setPolicy(next: RootPolicy): void;
  stop(): Promise<void>;
};

export async function startRoomFlow(
  opts: { policy?: Partial<RootPolicy>; fastReconnect?: boolean } = {},
): Promise<RoomFlow> {
  const server = await FakeOscarServer.start();
  server.addUser('botone', PASSWORD);
  let policy = policyFixture(opts.policy);
  const kernel = createInboundKernel();
  const turns: TurnRequest[] = [];
  const notices: { name: string; display: string }[] = [];
  const ownerNotes: string[] = [];

  const session = createOscarSession({
    host: '127.0.0.1',
    port: server.port,
    tls: false,
    redirect: 'auto',
    screenName: 'botone',
    getPassword: async () => PASSWORD,
    buddies: () => [...policy.allowFrom],
    log: silentLog,
    loginBudget: { take: async () => undefined },
    ...(opts.fastReconnect ? fastClock() : {}),
  });

  const rt = {
    accountId: 'botone',
    session,
    rooms: new Map(),
    sessionKeys: new Map(),
    lastReplyAt: new Map(),
    counters: { droppedSends: 0, eventGaps: 0 },
  } as AccountRuntime;
  setRuntime(rt);

  const deps: RoomDeps = {
    policy: () => policy,
    self: () => session.selfInfo()?.screenName ?? 'botone',
    now: Date.now,
    timers: { setTimeout, clearTimeout },
    log: silentLog,
    runTurn: async (req) => {
      turns.push(req);
    },
    record: (rec) => recordRoomLine(rec, kernel.run as unknown as InboundRunner),
    noticeStranger: (name, display) => {
      notices.push({ name, display });
    },
    tellOwners: async (text) => {
      ownerNotes.push(text);
    },
    contacts: () => [],
  };

  const closed: { room: RoomRef; willRejoin: boolean }[] = [];
  const offClosed = session.on('roomClosed', (ev) => {
    closed.push(ev);
  });
  const detach = attachRooms(rt, deps);
  session.start();
  await vi.waitFor(
    () => {
      if (session.getState().phase !== 'online') throw new Error(`session is ${session.getState().phase}`);
    },
    { timeout: 10_000, interval: 20 },
  );

  return {
    server,
    session,
    rt,
    deps,
    turns,
    notices,
    ownerNotes,
    closed,
    kernel,
    policy: () => policy,
    setPolicy(next) {
      policy = next;
    },
    async stop() {
      offClosed();
      detach();
      await session.stop();
      clearRuntime('botone');
      await server.stop();
    },
  };
}
