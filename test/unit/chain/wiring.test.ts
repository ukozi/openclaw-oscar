import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEAM_FACT_NOTE } from '../../../src/chain/prompts.js';
import type { RoomTurn } from '../../../src/chain/types.js';
import type { RoomBrain } from '../../../src/inbound/room.js';
import { encodePeerId } from '../../../src/names.js';
import type { ImEvent, OscarEvents, OscarSession } from '../../../src/oscar/index.js';
import type { AccountRuntime } from '../../../src/runtime.js';
import { clearRuntime, setRuntime } from '../../../src/runtime.js';
import { FakeRunTracker } from '../../fake/run-tracker.js';
import { ROOM, policyFixture, roomFixture } from './fixtures.js';

const seams = vi.hoisted(() => ({
  brain: null as RoomBrain | null,
  filter: null as unknown,
  im: null as unknown,
  awareness: [] as ((accountId: string) => string[])[],
  wake: vi.fn(async (_turn: RoomTurn) => {}),
  sendRoomLine: vi.fn(async () => ({ id: 'r', storedOffline: false })),
  star: false,
}));

vi.mock('../../../src/inbound/room.js', () => ({
  setRoomBrain: (_id: string, brain: RoomBrain | null) => { seams.brain = brain; },
  roomSink: () => ({ wake: seams.wake, record: vi.fn(), count: vi.fn() }),
}));
vi.mock('../../../src/outbound.js', () => ({
  setOutboundTextFilter: (_id: string, filter: unknown) => { seams.filter = filter; },
  sendRoomLine: seams.sendRoomLine,
}));
vi.mock('../../../src/inbound/im.js', () => ({
  setImControlHandler: (_id: string, fn: unknown) => { seams.im = fn; },
}));
vi.mock('../../../src/status.js', () => ({ hostOwnerListHasStar: () => seams.star }));
vi.mock('../../../src/presence/away.js', () => ({
  rosterPresence: (_session: unknown, roster: { screenName: string }[], self: string) =>
    roster.filter((entry) => entry.screenName !== self).map((entry) => ({ name: entry.screenName, online: true, away: entry.screenName === 'botthree' })),
}));
vi.mock('../../../src/awareness.js', () => ({ registerAwarenessSource: (fn: never) => { seams.awareness.push(fn); } }));
vi.mock('../../../src/config.js', async (original) => ({
  ...(await original<typeof import('../../../src/config.js')>()),
  readPolicy: () => policyFixture(),
  resolveAccount: () => ({ roomTextChunkLimit: 900, screenName: 'bottwo' }),
  listAccountIds: () => ['bottwo'],
}));

const { chainToolPolicy, installChain, registerChainHooks, uninstallChain } =
  await import('../../../src/chain/wiring.js');

function fakeSession() {
  const listeners = new Map<string, ((payload: never) => void)[]>();
  const session = {
    selfInfo: () => ({ screenName: 'Bot Two', bot: false }),
    sendIm: vi.fn(async () => ({ id: 'im', storedOffline: false })),
    on: (event: string, fn: (payload: never) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), fn]);
      return () => listeners.set(event, (listeners.get(event) ?? []).filter((f) => f !== fn));
    },
  };
  const emit = <E extends keyof OscarEvents>(event: E, payload: OscarEvents[E]) => {
    for (const fn of listeners.get(event) ?? []) fn(payload as never);
  };
  return { session: session as unknown as OscarSession, sendIm: session.sendIm, emit, listeners };
}

function runtime(session: OscarSession, room = roomFixture()): AccountRuntime {
  return {
    accountId: 'bottwo',
    session,
    rooms: new Map([['room:4:testroom', room]]),
    sessionKeys: new Map([['sk-room', { accountId: 'bottwo', peer: { kind: 'room', bot: 'bottwo', room: ROOM } }]]),
    lastReplyAt: new Map(),
    counters: { droppedSends: 0, eventGaps: 0 },
  };
}

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => {
  vi.useRealTimers();
  clearRuntime('bottwo');
  seams.star = false;
});

describe('installChain', () => {
  it('puts the controller behind the three seams and on the runtime', () => {
    const s = fakeSession();
    const rt = runtime(s.session);
    setRuntime(rt);
    const controller = installChain({ rt, getCfg: () => ({}), tracker: new FakeRunTracker(), log });
    expect(rt.chain).toBe(controller);
    expect(seams.brain).not.toBeNull();
    expect(typeof seams.filter).toBe('function');
    expect(typeof seams.im).toBe('function');
  });

  it('routes room messages through the controller and uses the canonical own name', () => {
    const s = fakeSession();
    const rt = runtime(s.session);
    setRuntime(rt);
    installChain({ rt, getCfg: () => ({}), tracker: new FakeRunTracker(), log });
    seams.wake.mockClear();
    seams.brain?.onRoomMessage({ room: ROOM, from: 'alice', fromDisplay: 'alice', text: 'Bot Two: report', cookie: 5n, whisper: false, serverGenerated: false });
    expect(seams.wake).toHaveBeenCalledTimes(1);
    expect(seams.wake.mock.calls[0]?.[0]).toMatchObject({ why: 'named', sender: 'alice' });
  });

  it('gives an acting lead the teammates who are away, with an empty job list', () => {
    const s = fakeSession();
    const rt = runtime(s.session, roomFixture({ occupants: new Set(['alice', 'bottwo', 'botthree']) }));
    setRuntime(rt);
    installChain({ rt, getCfg: () => ({}), tracker: new FakeRunTracker(), log });
    seams.wake.mockClear();
    seams.brain?.onRoomMessage({ room: ROOM, from: 'alice', fromDisplay: 'alice', text: 'what is the status?', cookie: 7n, whisper: false, serverGenerated: false });
    expect(seams.wake.mock.calls[0]?.[0].untrusted?.[0]?.payload).toEqual({
      teammates: [
        { name: 'botone', role: 'lead, planning, anything unassigned', online: true, busy: false },
        { name: 'botthree', role: 'code and shell work', online: true, busy: true },
      ],
      openJobs: [],
      watchingMinutes: expect.any(Number),
      note: TEAM_FACT_NOTE,
    });
  });

  it('refuses hand-off intake while the host owner list has a star', () => {
    const s = fakeSession();
    const rt = runtime(s.session);
    setRuntime(rt);
    installChain({ rt, getCfg: () => ({}), tracker: new FakeRunTracker(), log });
    seams.wake.mockClear();
    seams.star = true;
    seams.brain?.onRoomMessage({ room: ROOM, from: 'botone', fromDisplay: 'botone', text: 'bottwo: read the log [d:1-k7f3 h:1 o:alice]', cookie: 8n, whisper: false, serverGenerated: false });
    expect(seams.wake).not.toHaveBeenCalled();
  });

  it('answers a hello through the IM seam and listens to the session', () => {
    const s = fakeSession();
    const rt = runtime(s.session);
    setRuntime(rt);
    const controller = installChain({ rt, getCfg: () => ({}), tracker: new FakeRunTracker(), log });
    const im = seams.im as (ev: ImEvent) => 'handled' | 'pass';
    const hello: ImEvent = { from: 'botone', fromDisplay: 'botone', text: '#oc hello r=1 h=deadbeef', cookie: 1n, autoResponse: false, offline: false, system: false };
    expect(im(hello)).toBe('handled');
    expect(im({ ...hello, from: 'alice', text: 'hi' })).toBe('pass');
    expect(s.sendIm).toHaveBeenCalledTimes(1);
    expect(s.sendIm.mock.calls[0]).toEqual(['botone', expect.stringContaining('#oc hello r=2 h='), { priority: 'control' }]);
    expect(controller.facts().mismatches).toHaveLength(1);
    for (const event of ['roomReady', 'roomJoin', 'roomLeave', 'presence', 'rate']) expect(s.listeners.get(event)).toHaveLength(1);
    s.emit('roomLeave', { room: ROOM, name: 'botthree', display: 'botthree' });
    s.emit('presence', { name: 'botone', online: true, away: false, bot: false, at: 1 });
    s.emit('rate', { scope: ROOM, status: 'limited' });
    expect(controller.roomLimited('room:4:testroom')).toBe(true);
  });

  it('uninstall removes every hook', () => {
    const s = fakeSession();
    const rt = runtime(s.session);
    setRuntime(rt);
    installChain({ rt, getCfg: () => ({}), tracker: new FakeRunTracker(), log });
    uninstallChain(rt);
    expect(rt.chain).toBeUndefined();
    expect(seams.brain).toBeNull();
    expect(seams.filter).toBeNull();
    expect(seams.im).toBeNull();
    expect([...s.listeners.values()].every((list) => list.length === 0)).toBe(true);
  });
});

describe('group hooks', () => {
  it('gives a hand-off the intersection of delegator and originator, and leaves the rest to P2', () => {
    const s = fakeSession();
    const rt = runtime(s.session);
    setRuntime(rt);
    installChain({ rt, getCfg: () => ({}), tracker: new FakeRunTracker(), log });
    const groupId = encodePeerId({ kind: 'room', bot: 'bottwo', room: ROOM });
    expect(chainToolPolicy({ cfg: {}, groupId, accountId: 'bottwo', senderId: 'alice' })).toEqual({ handled: false });
    const unknownBotTurn = chainToolPolicy({ cfg: {}, groupId, accountId: 'bottwo', senderId: 'botone' });
    expect(unknownBotTurn.handled && unknownBotTurn.policy?.deny).toContain('group:runtime');

    seams.wake.mockImplementationOnce(() => new Promise<void>(() => {}));
    seams.brain?.onRoomMessage({ room: ROOM, from: 'botone', fromDisplay: 'botone', text: 'bottwo: read the log [d:1-k7f3 h:1 o:bob]', cookie: 6n, whisper: false, serverGenerated: false });
    const forBob = chainToolPolicy({ cfg: {}, groupId, accountId: 'bottwo', senderId: 'botone' });
    expect(forBob).toMatchObject({ handled: true });
    expect(forBob.handled && forBob.policy?.deny).toContain('group:runtime');
    expect(chainToolPolicy({ cfg: {}, groupId, senderId: 'botone' })).toEqual(forBob);

    expect(chainToolPolicy({ cfg: {}, groupId: encodePeerId({ kind: 'im', bot: 'bottwo', peer: 'alice' }), accountId: 'bottwo' })).toEqual({ handled: false });
    expect(chainToolPolicy({ cfg: {}, groupId: null, accountId: 'bottwo' })).toEqual({ handled: false });
  });

});

describe('registerChainHooks', () => {
  it('feeds tool starts to the controller, adds the awareness source and registers no lifecycle subscription', () => {
    const s = fakeSession();
    const rt = runtime(s.session);
    setRuntime(rt);
    const controller = installChain({ rt, getCfg: () => ({}), tracker: new FakeRunTracker(), log });
    const toolStarted = vi.spyOn(controller, 'toolStarted');
    const handlers = new Map<string, (event: unknown, ctx: { sessionKey?: string }) => void>();
    registerChainHooks({
      on: ((name: string, handler: never) => { handlers.set(name, handler); }) as never,
    });
    expect([...handlers.keys()]).toEqual(['before_tool_call']);
    handlers.get('before_tool_call')?.({ toolName: 'exec', params: {} }, { sessionKey: 'sk-room' });
    handlers.get('before_tool_call')?.({ toolName: 'exec', params: {} }, {});
    expect(toolStarted).toHaveBeenCalledTimes(1);
    expect(toolStarted).toHaveBeenCalledWith('sk-room');

    controller.ledger.open({ id: '2-k7f3', to: 'botthree', room: ROOM, originator: 'alice', hop: 1 });
    expect(seams.awareness.at(-1)?.('bottwo')).toEqual(['open hand-off 2-k7f3 to botthree in testroom for alice, 0 min']);
    expect(seams.awareness.at(-1)?.('nobody')).toEqual([]);
    controller.stop();
  });
});

describe('status', () => {
  it('collects chain issues next to the room issues', () => {
    const status = readFileSync('src/status.ts', 'utf8');
    expect(status).toContain("from './chain/report.js'");
    expect(status).toContain('chainIssues(');
  });
});
