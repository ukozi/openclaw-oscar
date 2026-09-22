import { ChainController } from '../../src/chain/controller.js';
import { rosterNames } from '../../src/chain/route.js';
import { roomKeyOf } from '../../src/chain/types.js';
import type { RoomTurn, TimerHandle, Timers } from '../../src/chain/types.js';
import type { ChainConfig, RootPolicy } from '../../src/config.js';
import { normalizeName } from '../../src/names.js';
import { createOscarSession } from '../../src/oscar/session.js';
import type { OscarSession } from '../../src/oscar/session.js';
import { toAsciiEntities, toWireHtml } from '../../src/oscar/text.js';
import { handoffToolPolicy } from '../../src/policy.js';
import type { ToolPolicy } from '../../src/policy.js';
import type { RoomState } from '../../src/runtime.js';
import { FakeOscarServer } from '../fake/oscar-server.js';
import type { FakePeer } from '../fake/oscar-server.js';
import { FakeRunTracker } from '../fake/run-tracker.js';
import { ROOM, chainConfig, policyFixture } from '../unit/chain/fixtures.js';

export type AgentApi = {
  turn: RoomTurn;
  reply(text: string): Promise<void>;
  send(text: string): Promise<void>;
  tool(): void;
  delegate(to: string, task: string): Promise<string>;
};
export type Agent = (api: AgentApi) => Promise<void>;

export const RK = roomKeyOf(ROOM);
export const TAKEOVER_MS = 400;
export const ACK_MS = 200;

const quiet = { debug() {}, info() {}, warn() {}, error() {} };

export function gate(): { wait: Promise<void>; open(): void } {
  let open: () => void = () => {};
  const wait = new Promise<void>((resolve) => { open = resolve; });
  return { wait, open };
}

export class VirtualClock {
  private t = 1_700_000_000_000;
  private seq = 0;
  private readonly pending = new Map<number, { at: number; fn: () => void }>();

  readonly now = (): number => this.t;

  readonly timers: Timers = {
    setTimeout: (fn, ms) => {
      const id = ++this.seq;
      this.pending.set(id, { at: this.t + Math.max(0, ms), fn });
      return id as unknown as TimerHandle;
    },
    clearTimeout: (handle) => {
      this.pending.delete(handle as unknown as number);
    },
  };

  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | undefined;
      for (const entry of this.pending) if (entry[1].at <= end && (!next || entry[1].at < next[1].at)) next = entry;
      if (!next) break;
      this.pending.delete(next[0]);
      this.t = next[1].at;
      next[1].fn();
    }
    this.t = end;
  }
}

function plain(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

export class Instance {
  suspended = false;
  readonly bots: Bot[] = [];
  readonly tracker = new FakeRunTracker();
}

export class Bot {
  agent: Agent = async (api) => { await api.reply('ok'); };
  readonly runs: { turn: RoomTurn; toolPolicy: ToolPolicy | undefined }[] = [];
  readonly steered: RoomTurn[] = [];
  readonly wakes: RoomTurn[] = [];
  readonly heard: string[] = [];
  readonly said: string[] = [];
  readonly sent: string[] = [];
  readonly rooms = new Map<string, RoomState>();
  readonly sessionKey: string;
  controller!: ChainController;
  session!: OscarSession;

  constructor(readonly name: string, readonly instance: Instance, readonly policy: () => RootPolicy, private readonly clock: VirtualClock) {
    this.sessionKey = `agent:main:oscar:group:${name}#4.${ROOM.name}`;
  }

  idle(): boolean {
    return this.instance.tracker.activeRun(this.sessionKey) === null && this.controller.turnOrigin(RK) === null;
  }

  async start(server: FakeOscarServer): Promise<void> {
    const { name, instance, clock } = this;
    server.addUser(name, `pw-${name}`);
    const session = createOscarSession({
      host: '127.0.0.1', port: server.port, tls: false, redirect: 'pin', screenName: name,
      getPassword: async () => `pw-${name}`,
      buddies: () => rosterNames(this.policy()).filter((n) => n !== name),
      log: quiet,
      loginBudget: { take: async () => {} },
    });
    this.session = session;
    this.controller = new ChainController({
      accountId: name,
      self: () => name,
      policy: this.policy,
      ownerWildcard: () => false,
      roomChunkLimit: () => 900,
      room: (roomKey) => this.rooms.get(roomKey),
      sessionKeyFor: (roomKey) => (roomKey === RK ? this.sessionKey : undefined),
      roomKeyForSession: (sessionKey) => (sessionKey === this.sessionKey ? RK : undefined),
      tracker: instance.tracker,
      sink: { wake: (turn) => this.run(turn), record: () => {}, count: () => {} },
      say: (room, markdown, opts) => {
        if (!opts?.whisperTo) this.said.push(markdown);
        return session.sendRoom(room, toAsciiEntities(toWireHtml(markdown)), opts);
      },
      sendIm: (to, line) => { session.sendIm(to, toWireHtml(line), { priority: 'control' }).catch(() => {}); },
      log: quiet,
      timers: clock.timers,
      now: clock.now,
    });
    const awake = <T>(fn: (payload: T) => void) => (payload: T) => { if (!instance.suspended) fn(payload); };
    session.on('roomReady', awake(({ room, occupants }) => {
      const names = occupants.map(normalizeName);
      this.rooms.set(roomKeyOf(room), { ref: room, occupants: new Set(names), joinSeenAt: new Map(), selfJoinedAt: clock.now(), omittedCount: 0 });
      this.controller.onRoomReady(room, names);
    }));
    session.on('roomJoin', awake((ev) => {
      const state = this.rooms.get(roomKeyOf(ev.room));
      if (state) {
        state.occupants.add(ev.name);
        state.joinSeenAt.set(ev.name, clock.now());
      }
      this.controller.onRoomJoin(ev);
    }));
    session.on('roomLeave', awake((ev) => {
      const state = this.rooms.get(roomKeyOf(ev.room));
      state?.occupants.delete(ev.name);
      state?.joinSeenAt.delete(ev.name);
      this.controller.onRoomLeave(ev);
    }));
    session.on('roomMessage', awake((ev) => {
      if (ev.from === name) return;
      this.heard.push(ev.text);
      this.controller.onRoomMessage(ev);
    }));
    session.on('im', awake((ev) => { this.controller.onIm(ev); }));
    session.on('presence', awake((p) => this.controller.onPresence(p.name, p.online)));
    session.on('rate', awake((ev) => this.controller.onRate(ev)));
    await new Promise<void>((resolve, reject) => {
      const off = session.on('state', (state) => {
        if (state.phase === 'online') { off(); resolve(); }
        if (state.phase === 'fatal') { off(); reject(new Error(`${name}: ${state.reason ?? 'fatal'}`)); }
      });
      session.start();
    });
    await session.joinRoom(ROOM, { persistent: true });
  }

  private async run(turn: RoomTurn): Promise<void> {
    const { instance, name, controller, sessionKey, session } = this;
    this.wakes.push(turn);
    if (instance.tracker.activeRun(sessionKey)) {
      this.steered.push(turn);
      return;
    }
    const origin = controller.turnOrigin(RK) ?? { originator: turn.originator };
    this.runs.push({ turn, toolPolicy: handoffToolPolicy(origin, this.policy(), ROOM.name) });
    instance.tracker.start(sessionKey, name, turn.origin);
    const out = (kind: 'final' | 'send') => async (text: string) => {
      const filtered = await controller.filterOutbound({ accountId: name, target: { kind: 'room', room: ROOM }, kind }, text);
      if (filtered === null) return;
      this.sent.push(filtered);
      await session.sendRoom(ROOM, toAsciiEntities(toWireHtml(filtered)));
    };
    try {
      await this.agent({
        turn,
        reply: out('final'),
        send: out('send'),
        tool: () => controller.toolStarted(sessionKey),
        delegate: (to, task) => controller.delegate({ roomKey: RK, requester: turn.sender, to, task }),
      });
      instance.tracker.end(sessionKey);
    } catch {
      instance.tracker.end(sessionKey, 'error');
    }
  }
}

export class Team {
  readonly instances: Instance[] = [];
  readonly clock = new VirtualClock();
  private readonly byName = new Map<string, Bot>();

  private constructor(readonly server: FakeOscarServer, readonly alice: FakePeer, readonly bob: FakePeer) {}

  static async start(opts: {
    instances: string[][];
    ghosts?: string[];
    chain?: Partial<ChainConfig>;
    policyFor?: (name: string, base: RootPolicy) => RootPolicy;
  }): Promise<Team> {
    const server = await FakeOscarServer.start({ generation: 'main' });
    const alice = server.peer('alice');
    const bob = server.peer('bob');
    alice.joinRoom(ROOM);
    bob.joinRoom(ROOM);
    const team = new Team(server, alice, bob);
    const live = opts.instances.flat();
    const rosterOrder = [...(opts.ghosts ?? []), ...live];
    const base = policyFixture({
      chain: chainConfig({
        roster: rosterOrder.map((screenName) => ({ screenName, role: `${screenName} work`, aliases: [] })),
        takeoverMs: TAKEOVER_MS, ackAfterMs: ACK_MS, ...opts.chain,
      }),
    });
    for (const names of opts.instances) {
      const instance = new Instance();
      team.instances.push(instance);
      for (const name of names) {
        const policy = opts.policyFor ? opts.policyFor(name, base) : base;
        const bot = new Bot(name, instance, () => policy, team.clock);
        instance.bots.push(bot);
        team.byName.set(name, bot);
        await bot.start(server);
      }
    }
    await team.until(() => live.every((name) => live.every((other) => team.bot(name).rooms.get(RK)?.occupants.has(other))));
    team.settle();
    return team;
  }

  bot(name: string): Bot {
    const bot = this.byName.get(name);
    if (!bot) throw new Error(`no bot ${name}`);
    return bot;
  }

  bots(): Bot[] {
    return [...this.byName.values()];
  }

  settle(): void {
    this.clock.advance(60_000);
  }

  async until(condition: () => boolean | undefined, what = 'condition', timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  everyoneHeard(text: string, except: string[] = []): Promise<void> {
    return this.until(
      () => this.bots().every((bot) => except.includes(bot.name) || bot.instance.suspended || bot.heard.includes(text)),
      `every bot to hear "${text}"`,
    );
  }

  standDown(): Promise<void> {
    return this.until(() => this.bots().every((bot) => bot.controller.standbys() === 0), 'every standby to be cancelled');
  }

  seenByAlice(): string[] {
    return this.alice.roomLines(ROOM)
      .filter((l) => !['alice', 'bob'].includes(normalizeName(l.from)))
      .map((l) => plain(l.text));
  }

  totalRuns(): number {
    return this.bots().reduce((n, bot) => n + bot.runs.length, 0);
  }

  async stop(): Promise<void> {
    for (const bot of this.bots()) {
      bot.controller.stop();
      await bot.session.stop();
    }
    await this.server.stop();
  }
}
