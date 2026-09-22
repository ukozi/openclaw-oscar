import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copy } from '../../src/copy.js';
import type { RoomRef } from '../../src/oscar/types.js';
import { gatewayConfig } from './support/config.js';
import { liveEnv } from './support/env.js';
import { bootGateway, type AgentScript, type GatewayTurn, type LiveGateway } from './support/gateway.js';
import { freePorts, Oos } from './support/oos.js';
import { startSession, type Captured } from './support/session.js';
import { Tap } from './support/tap.js';
import { holds, sleep, until } from './support/wait.js';

const env = liveEnv();
const ROSTER = ['botone', 'bottwo', 'botthree', 'botfour', 'botfive', 'botsix', 'botseven'];
// ranks alternate between the two gateways, so freezing gateway A silences the lead and leaves rank 2 awake
const ON_A = ['botone', 'botthree', 'botfive', 'botseven'];
const ON_B = ['bottwo', 'botfour', 'botsix'];
const ROOM: RoomRef = { exchange: 4, name: `team${Date.now().toString(36)}` };
const CHAIN = { takeoverMs: 4000, ackAfterMs: 3000, floorSeconds: 120, maxHops: 2 };
const pw = (name: string) => `${name.slice(0, 8)}pw1`;

describe.skipIf(env.mode !== 'local')('must 3: chain of command', () => {
  let oos: Oos;
  let tapA: Tap;
  let tapB: Tap;
  let direct: Tap;
  let gwA: LiveGateway;
  let gwB: LiveGateway;
  let alice: Captured;
  let bob: Captured;
  const room: string[] = [];
  let script: AgentScript = async () => {};

  const runs = (): GatewayTurn[] => [...gwA.runs(), ...gwB.runs()];
  const runsSince = (t: number, account?: string) => runs().filter((r) => r.startedAt >= t && (!account || r.accountId === account));
  const say = (who: Captured, text: string) => who.session.sendRoom(ROOM, text);

  beforeAll(async () => {
    if (env.mode !== 'local') return;
    const [oscar, ssl, toc, api] = (await freePorts(4)) as [number, number, number, number];
    direct = await Tap.start({ targetHost: '127.0.0.1', targetPort: oscar });
    tapA = await Tap.start({ targetHost: '127.0.0.1', targetPort: oscar });
    tapB = await Tap.start({ targetHost: '127.0.0.1', targetPort: oscar });
    oos = await Oos.start({ bin: env.bin, generation: env.generation, ports: { oscar, ssl, toc, api }, advertisedPort: direct.port });
    for (const name of [...ROSTER, 'alice', 'bob']) await oos.createUser(name, pw(name));

    const make = (accounts: string[], tap: Tap) => bootGateway({
      cfg: gatewayConfig({
        target: { host: '127.0.0.1', port: tap.port, tls: false }, redirect: 'pin',
        accounts: Object.fromEntries(accounts.map((a) => [a, pw(a)])),
        owners: ['alice'], allowFrom: ['alice', 'bob'], room: ROOM.name, roster: ROSTER, chain: CHAIN,
      }),
    });
    gwA = await make(ON_A, tapA);
    gwB = await make(ON_B, tapB);
    for (const gw of [gwA, gwB]) gw.setAgent((turn, agent) => script(turn, agent));
    await Promise.all([gwA.start(), gwB.start()]);

    const humans = { host: '127.0.0.1', port: direct.port, tls: false };
    alice = await startSession(humans, 'alice', pw('alice'));
    bob = await startSession(humans, 'bob', pw('bob'));
    await alice.session.joinRoom(ROOM);
    await bob.session.joinRoom(ROOM);
    alice.session.on('roomMessage', (m) => room.push(`${m.from}: ${m.text}`));

    // seven logins and seven password probes against a limit of ten a minute per address can take a few minutes
    await until(async () => {
      const occupants = await oos.roomOccupants(ROOM.name);
      return ROSTER.every((b) => occupants.includes(b));
    }, { timeoutMs: 420_000, everyMs: 1000, what: 'all seven bots in the room' });
    // peers are lead-eligible 5 s after their join is seen, self after 8 s
    await sleep(10_000);
  }, 480_000);

  afterAll(async () => {
    await gwA?.stop();
    await gwB?.stop();
    await alice?.session.stop();
    await bob?.session.stop();
    await Promise.all([tapA?.stop(), tapB?.stop(), direct?.stop()]);
    await oos?.stop();
  });

  it('an unnamed owner line starts exactly one run, on the lead', async () => {
    script = async (_turn, agent) => agent.reply('the lead here');
    const t = Date.now();
    await say(alice, 'what is the plan for today?');
    await until(() => room.some((l) => l === 'botone: the lead here'), { timeoutMs: 20_000, what: "the lead's answer" });
    await sleep(CHAIN.takeoverMs + 3000);
    expect(runsSince(t).map((r) => r.accountId)).toEqual(['botone']);
    expect(room.filter((l) => l.includes(copy.takeover('botone')))).toEqual([]);
  }, 60_000);

  it('rank 2 takes the line when the lead is frozen', async () => {
    script = async (turn, agent) => agent.reply(`${turn.accountId} answering`);
    // let the floor from the last test pass to nobody: the lead spoke last, and the lead is who we freeze
    tapA.freeze();
    const t = Date.now();
    await say(alice, 'is anyone there?');
    await until(() => runsSince(t, 'bottwo').length === 1, { timeoutMs: CHAIN.takeoverMs + 2000 + 3000, what: 'rank 2 to take the line' });
    const tookAfter = (runsSince(t, 'bottwo')[0]?.startedAt ?? 0) - t;
    expect(tookAfter).toBeGreaterThanOrEqual(CHAIN.takeoverMs - 500);
    expect(tookAfter).toBeLessThanOrEqual(CHAIN.takeoverMs + 2000);
    await until(() => room.some((l) => l === `bottwo: ${copy.takeover('botone')}`), { timeoutMs: 10_000, what: 'the takeover line' });
    await sleep(CHAIN.takeoverMs * 2);
    expect(runsSince(t).filter((r) => ON_B.includes(r.accountId)).map((r) => r.accountId)).toEqual(['bottwo']);
    tapA.thaw();
    await sleep(8000);
  }, 90_000);

  it('a question holds the floor, a report does not', async () => {
    script = async (turn, agent) => agent.reply(`${turn.accountId} says hi, shall I go on?`);
    await say(alice, 'botfour: say hi');
    await until(() => room.includes('botfour: botfour says hi, shall I go on?'), { timeoutMs: 20_000, what: 'the worker to speak' });
    const t = Date.now();
    script = async (turn, agent) => agent.reply(`${turn.accountId} carried on`);
    await say(alice, 'and once more please');
    await until(() => runsSince(t, 'botfour').length === 1, { timeoutMs: 20_000, what: 'the follow-up on the worker' });
    await sleep(CHAIN.takeoverMs + 3000);
    expect(runsSince(t).map((r) => r.accountId)).toEqual(['botfour']);

    const t2 = Date.now();
    await say(alice, 'and one more time');
    await until(() => runsSince(t2, 'botone').length === 1, { timeoutMs: 20_000, what: 'the follow-up on the lead' });
    await sleep(CHAIN.takeoverMs + 3000);
    expect(runsSince(t2).map((r) => r.accountId)).toEqual(['botone']);
  }, 120_000);

  it('hands a job down by tool, closes it, and keeps owner tools on the worker', async () => {
    let delegated = { ok: false, text: '' };
    script = async (turn, agent) => {
      if (turn.accountId === 'botone') delegated = await agent.tool('oscar_delegate', { to: 'botthree', task: 'list the open files' });
      else agent.reply('three files are open');
    };
    const t = Date.now();
    await say(alice, 'botone: find out which files are open');
    await until(() => room.some((l) => /^botone: botthree: list the open files \[d:[^ \]]+ h:1 o:alice\]$/.test(l)), { timeoutMs: 30_000, what: 'the public hand-off line' });
    await until(() => room.some((l) => /^botthree: .*three files are open.*\[d:[^ \]]+\]/.test(l)), { timeoutMs: 30_000, what: 'the tagged result' });
    expect(delegated.ok).toBe(true);
    const worker = runsSince(t, 'botthree');
    expect(worker).toHaveLength(1);
    expect(worker[0]?.body).toContain('list the open files');
    expect(worker[0]?.toolDeny).not.toContain('group:runtime');
    expect(worker[0]?.commandAuthorized).toBe(false);

    // the ledger is closed: an owner turn no longer lists the hand-off as open
    const id = /\[d:([^ \]]+) h:1/.exec(room.find((l) => l.includes('list the open files')) ?? '')?.[1] ?? 'missing';
    script = async (_turn, agent) => agent.reply('noted');
    const t2 = Date.now();
    await alice.session.sendIm('botone', 'anything still open?');
    await until(() => runsSince(t2, 'botone').length === 1, { timeoutMs: 20_000, what: 'the owner IM turn' });
    const context = JSON.parse(runsSince(t2, 'botone')[0]?.context ?? '[]') as { type?: string; payload?: { openHandoffs?: unknown[] } }[];
    const awareness = context.find((entry) => entry.type === 'awareness');
    expect(awareness?.payload?.openHandoffs).toBeDefined();
    expect(JSON.stringify(awareness?.payload?.openHandoffs)).not.toContain(id);
  }, 120_000);

  it('hands a job down by text', async () => {
    script = async (turn, agent) => {
      if (turn.accountId === 'botone') agent.reply('botfive: tighten the intro');
      else agent.reply('intro tightened');
    };
    const t = Date.now();
    await say(alice, 'botone: get the intro tightened');
    await until(() => room.some((l) => /^botone: botfive: tighten the intro \[d:[^ \]]+ h:1 o:alice\]$/.test(l)), { timeoutMs: 30_000, what: 'the stamped hand-off line' });
    await until(() => room.some((l) => l.startsWith('botfive: ') && l.includes('intro tightened')), { timeoutMs: 30_000, what: 'the result' });
    expect(runsSince(t, 'botfive')).toHaveLength(1);
  }, 90_000);

  it('refuses a third hop', async () => {
    const results: Record<string, { ok: boolean; text: string }> = {};
    const next: Record<string, string> = { botone: 'bottwo', bottwo: 'botthree', botthree: 'botfour' };
    script = async (turn, agent) => {
      const to = next[turn.accountId];
      if (to) results[turn.accountId] = await agent.tool('oscar_delegate', { to, task: 'pass it on' });
    };
    const t = Date.now();
    await say(alice, 'botone: pass this down as far as it goes');
    await until(() => results.botthree !== undefined, { timeoutMs: 60_000, what: 'the third bot to try' });
    expect(results.botone?.ok).toBe(true);
    expect(results.bottwo?.ok).toBe(true);
    expect(results.botthree?.ok).toBe(false);
    expect(results.botthree?.text).toMatch(/too many hops/);
    await sleep(5000);
    expect(runsSince(t, 'botfour')).toEqual([]);
  }, 120_000);

  it("keeps an approved person's limits on handed-down work", async () => {
    script = async (turn, agent) => {
      if (turn.accountId === 'botone') await agent.tool('oscar_delegate', { to: 'botsix', task: 'check the disk' });
      else agent.reply('disk checked');
    };
    const t = Date.now();
    await say(bob, 'botone: have someone check the disk');
    await until(() => runsSince(t, 'botsix').length === 1, { timeoutMs: 45_000, what: 'the worker run' });
    expect(runsSince(t, 'botone')[0]?.toolDeny).toContain('group:runtime');
    expect(runsSince(t, 'botsix')[0]?.toolDeny).toContain('group:runtime');
    expect(room.some((l) => /check the disk \[d:[^ \]]+ h:1 o:bob\]$/.test(l))).toBe(true);
  }, 90_000);

  it('acks only a run that is still working', async () => {
    script = async (_turn, agent) => {
      await agent.tool('oscar_status', { text: 'Thinking it over' });
      await agent.sleep(CHAIN.ackAfterMs + 3000);
      agent.reply('slow answer');
    };
    const before = room.filter((l) => l === `botone: ${copy.ack('on it')}`).length;
    const t = Date.now();
    await say(alice, 'botone: take your time with this');
    await until(() => room.filter((l) => l === `botone: ${copy.ack('on it')}`).length === before + 1, { timeoutMs: CHAIN.ackAfterMs + 4000, what: 'the ack' });
    expect(Date.now() - t).toBeGreaterThanOrEqual(CHAIN.ackAfterMs - 200);
    await until(() => room.includes('botone: slow answer'), { timeoutMs: 20_000, what: 'the answer' });

    script = async (_turn, agent) => agent.reply('fast answer');
    await say(alice, 'botone: quick one');
    await until(() => room.includes('botone: fast answer'), { timeoutMs: 20_000, what: 'the fast answer' });
    await sleep(CHAIN.ackAfterMs + 2000);
    expect(room.filter((l) => l === `botone: ${copy.ack('on it')}`).length).toBe(before + 1);
  }, 120_000);

  it('an echoing room never runs the rest of the team', async () => {
    script = async (_turn, agent) => agent.reply('echo this back to me');
    const stop = bob.session.on('roomMessage', (m) => {
      if (m.from === 'botone' && !m.whisper) void bob.session.sendRoom(ROOM, `botone: ${m.text}`).catch(() => {});
    });
    const t = Date.now();
    await say(bob, 'botone: start');
    await sleep(45_000);
    stop();
    const count = runsSince(t).length;
    expect(count).toBeGreaterThanOrEqual(2);
    expect(runsSince(t).every((r) => r.accountId === 'botone')).toBe(true);
    await holds(() => runsSince(t).every((r) => r.accountId === 'botone'), { forMs: 8000, what: 'the echo staying on one bot' });
  }, 120_000);
});
