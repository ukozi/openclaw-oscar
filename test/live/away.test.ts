import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copy } from '../../src/copy.js';
import { gatewayConfig } from './support/config.js';
import { liveEnv } from './support/env.js';
import { bootGateway, type LiveGateway } from './support/gateway.js';
import { RawPeer } from './support/raw-peer.js';
import { startSession, type Captured } from './support/session.js';
import { startStack, type Stack } from './support/stack.js';
import { holds, until } from './support/wait.js';

const env = liveEnv();
const PASSWORDS = { botone: 'botonepass', alice: 'alicepass1', bob: 'bobpasswd1' };
const AWAY_DEFAULT = 'Working on something. Back in a bit.';

describe.skipIf(env.mode !== 'local')('must 2: the away line', () => {
  let stack: Stack;
  let gateway: LiveGateway;
  let alice: Captured;
  let bob: RawPeer;
  const toAlice: string[] = [];

  function boot(): Promise<LiveGateway> {
    return bootGateway({
      cfg: gatewayConfig({
        target: stack.target, accounts: { botone: PASSWORDS.botone }, owners: ['alice'], allowFrom: ['alice', 'bob'],
        channel: { away: { enabled: true, message: AWAY_DEFAULT, blurb: 'agent', graceMs: 2000, maxLength: 100 } },
      }),
    });
  }

  async function awayText(): Promise<string | null> {
    const s = await stack.oos.session('botone');
    return s && s.away ? s.awayMessage : null;
  }

  beforeAll(async () => {
    if (env.mode !== 'local') return;
    stack = await startStack(env);
    for (const [name, password] of Object.entries(PASSWORDS)) await stack.oos.createUser(name, password);
    alice = await startSession(stack.target, 'alice', PASSWORDS.alice, { buddies: () => ['botone'] });
    alice.session.on('im', (m) => toAlice.push(m.text));
    bob = await RawPeer.signOn({ host: '127.0.0.1', port: stack.oos.ports.oscar, screenName: 'bob', password: PASSWORDS.bob });
    gateway = await boot();
    await gateway.start();
    await until(async () => (await stack.oos.session('botone')) !== null, { timeoutMs: 60_000, what: 'the bot to sign on' });
  }, 120_000);

  afterAll(async () => {
    await gateway?.stop();
    await alice?.session.stop();
    bob?.signOff();
    await stack?.stop();
  });

  it('is not away when idle', async () => {
    expect(copy.awayDefault()).toBe(AWAY_DEFAULT);
    expect(await awayText()).toBeNull();
    expect((await bob.userInfo('botone')).away).toBeNull();
  });

  it('goes up after the grace time with no tool call at all, is readable by a peer, and clears within a second', async () => {
    gateway.setAgent(async (_turn, agent) => {
      await agent.sleep(7000);
      agent.reply('finished the long job');
    });
    const sentAt = Date.now();
    await alice.session.sendIm('botone', 'do the long job');
    const text = await until(() => awayText(), { timeoutMs: 15_000, everyMs: 100, what: 'the away line' });
    // 2 s debounce before the turn starts, then the 2 s grace
    expect(Date.now() - sentAt).toBeGreaterThan(2000);
    expect(text).toBe(AWAY_DEFAULT);

    const seenByPeer = await bob.userInfo('botone');
    expect(seenByPeer.away).toBe(AWAY_DEFAULT);
    expect(seenByPeer.flags & 0x0020).toBe(0x0020);
    expect(/^[\x20-\x7e]{1,100}$/.test(seenByPeer.away ?? '')).toBe(true);

    // the fake host delivers the reply after the run has ended, so the clock starts at the end of the run
    const endedAt = await until(() => gateway.runs('botone').find((r) => r.body.includes('do the long job'))?.endedAt ?? null, {
      timeoutMs: 20_000, everyMs: 20, what: 'the run to end',
    });
    await until(async () => (await awayText()) === null, { timeoutMs: 5000, everyMs: 50, what: 'the away line to clear' });
    expect(Date.now() - endedAt).toBeLessThanOrEqual(1000);
    await until(() => toAlice.includes('finished the long job'), { timeoutMs: 20_000, what: 'the reply' });
    expect((await bob.userInfo('botone')).away).toBeNull();
  }, 90_000);

  it('stays down for a run shorter than the grace time', async () => {
    gateway.setAgent(async (_turn, agent) => agent.reply('quick answer'));
    toAlice.length = 0;
    await alice.session.sendIm('botone', 'quick question');
    let sawAway = false;
    await until(async () => {
      sawAway = sawAway || (await awayText()) !== null;
      return toAlice.includes('quick answer');
    }, { timeoutMs: 20_000, everyMs: 50, what: 'the quick reply' });
    await holds(async () => (await awayText()) === null, { forMs: 3000, what: 'not away after a quick run' });
    expect(sawAway).toBe(false);
  }, 60_000);

  it("shows the agent's own line", async () => {
    let accepted = false;
    gateway.setAgent(async (_turn, agent) => {
      accepted = (await agent.tool('oscar_status', { text: 'Reading some docs' })).ok;
      await agent.sleep(9000);
      agent.reply('read them');
    });
    toAlice.length = 0;
    await alice.session.sendIm('botone', 'read the docs');
    await until(async () => (await awayText()) === 'Reading some docs', { timeoutMs: 20_000, what: "the agent's line" });
    await until(() => toAlice.includes('read them'), { timeoutMs: 20_000, what: 'the reply' });
    expect(accepted).toBe(true);
  }, 90_000);

  it('replaces a line that holds a path with a phrase', async () => {
    gateway.setAgent(async (_turn, agent) => {
      await agent.tool('oscar_status', { text: 'editing /etc/passwd right now' });
      await agent.sleep(9000);
      agent.reply('edited');
    });
    toAlice.length = 0;
    await alice.session.sendIm('botone', 'edit the file');
    const text = await until(() => awayText(), { timeoutMs: 20_000, what: 'an away line' });
    expect(text).not.toContain('/');
    expect(text).not.toContain('passwd');
    expect(text.length).toBeGreaterThan(0);
    await until(() => toAlice.includes('edited'), { timeoutMs: 20_000, what: 'the reply' });
    await until(async () => (await awayText()) === null, { timeoutMs: 5000, what: 'the away line to clear' });
  }, 90_000);

  it('is not away after the gateway dies mid-run and starts again', async () => {
    gateway.setAgent(async (_turn, agent) => {
      await agent.sleep(60_000);
    });
    await alice.session.sendIm('botone', 'start something long');
    await until(async () => (await awayText()) !== null, { timeoutMs: 20_000, what: 'the away line' });

    // the network-level picture of kill -9: every socket dies with no sign-off, then the process is gone
    stack.tap?.severAll();
    await gateway.stop();
    await until(async () => (await stack.oos.session('botone')) === null, { timeoutMs: 30_000, what: 'the server to drop the dead session' });

    gateway = await boot();
    gateway.setAgent(async () => {});
    await gateway.start();
    await until(async () => (await stack.oos.session('botone')) !== null, { timeoutMs: 120_000, what: 'the bot to sign on again' });
    await holds(async () => (await awayText()) === null, { forMs: 6000, what: 'not away after the restart' });
    expect((await bob.userInfo('botone')).away).toBeNull();
  }, 300_000);
});
