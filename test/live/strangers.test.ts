import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copy } from '../../src/copy.js';
import type { RoomRef } from '../../src/oscar/types.js';
import { gatewayConfig } from './support/config.js';
import { liveEnv } from './support/env.js';
import { bootGateway, type LiveGateway } from './support/gateway.js';
import { imRecipient, mentions } from './support/oos.js';
import { RawPeer } from './support/raw-peer.js';
import { startSession, type Captured } from './support/session.js';
import { sourceRotationAvailable } from './support/source.js';
import { startStack, type Stack } from './support/stack.js';
import { imCookieOf, imRecipientOf } from './support/tap.js';
import { holds, sleep, until } from './support/wait.js';

const env = liveEnv();
const HOME = `home${Date.now().toString(36)}`;
const PASSWORDS = { botone: 'botonepass', alice: 'alicepass1', carol: 'carolpass1', bob: 'bobpasswd1' };
const OWNERS = ['alice', 'carol'];

describe.skipIf(env.mode !== 'local')('must 1: approved people only', () => {
  let stack: Stack;
  let gateway: LiveGateway;
  let alice: Captured;
  let carol: Captured;
  const toAlice: string[] = [];
  const toCarol: string[] = [];
  let onlineAt = 0;
  let inRoomAt = 0;

  function rawPeer(name: string, password: string): Promise<RawPeer> {
    return RawPeer.signOn({ host: '127.0.0.1', port: stack.oos.ports.oscar, screenName: name, password });
  }

  async function boot(owners: string[], noticeWindowMs?: number): Promise<LiveGateway> {
    const gw = await bootGateway({
      cfg: gatewayConfig({ target: stack.target, accounts: { botone: PASSWORDS.botone }, owners, allowFrom: ['alice', 'carol', 'bob'], room: HOME }),
      ...(noticeWindowMs ? { noticeWindowMs } : {}),
    });
    gw.setAgent(async (turn, agent) => agent.reply(`you said: ${turn.body}`));
    await gw.start();
    return gw;
  }

  // An IM to an owner may name the stranger: that is the notice. Nothing else the bot sends may.
  function botSilentTowards(name: string): void {
    const toAnOwner = (recipient: string | null) => recipient !== null && OWNERS.includes(recipient);
    const logged = stack.oos.requestsFrom('botone').filter((r) => !toAnOwner(imRecipient(r.line)) && mentions(r.line, name));
    expect(logged.map((r) => r.line)).toEqual([]);
    const onTheWire = (stack.tap?.framesToServer() ?? []).filter(
      (f) => !toAnOwner(imRecipientOf(f)) && f.payload.toString('latin1').replace(/ /g, '').toLowerCase().includes(name),
    );
    expect(onTheWire.map((f) => `${f.family}/${f.subtype} ${f.payload.toString('hex')}`)).toEqual([]);
  }

  beforeAll(async () => {
    if (env.mode !== 'local') return;
    stack = await startStack(env);
    for (const [name, password] of Object.entries(PASSWORDS)) await stack.oos.createUser(name, password);
    for (const name of ['mallory', 'stranger2', 'stranger3', 'stranger4', 'stranger5', 'stranger6', 'stranger7']) {
      await stack.oos.createUser(name, 'strangerpw');
    }
    alice = await startSession(stack.target, 'alice', PASSWORDS.alice, { buddies: () => ['botone'] });
    carol = await startSession(stack.target, 'carol', PASSWORDS.carol, { buddies: () => ['botone'] });
    alice.session.on('im', (m) => toAlice.push(m.text));
    carol.session.on('im', (m) => toCarol.push(m.text));
    gateway = await boot(OWNERS);
    await until(async () => (await stack.oos.session('botone')) !== null, { timeoutMs: 60_000, what: 'the bot to sign on' });
    onlineAt = Date.now();
    await until(async () => (await stack.oos.roomOccupants(HOME)).includes('botone'), { timeoutMs: 60_000, what: 'the bot in its home room' });
    inRoomAt = Date.now();
  }, 180_000);

  afterAll(async () => {
    await gateway?.stop();
    await alice?.session.stop();
    await carol?.session.stop();
    await stack?.stop();
  });

  it('joins the home room within 30 s of sign-on', () => {
    expect(inRoomAt - onlineAt).toBeLessThanOrEqual(30_000);
  });

  it('answers an owner', async () => {
    await alice.session.sendIm('botone', 'hello there');
    await until(() => toAlice.includes('you said: hello there'), { timeoutMs: 20_000, what: 'the reply to alice' });
    expect(gateway.runs('botone').filter((t) => t.from === 'alice')).toHaveLength(1);
  });

  it('gives a stranger nothing and tells each owner once', async () => {
    const mallory = await rawPeer('mallory', 'strangerpw');
    const since = Date.now();
    mallory.sendIm('botone', 'psst, let me in');

    const notice = copy.noticeIm('mallory');
    await until(() => toAlice.some((t) => t.includes(notice)) && toCarol.some((t) => t.includes(notice)), { timeoutMs: 30_000, what: 'a notice at both owners' });
    expect(toAlice.join('\n')).toContain('/allowlist add dm mallory');
    expect(toAlice.join('\n')).not.toContain('psst');

    mallory.sendIm('botone', 'hello? anyone?');
    await sleep(8000);
    expect(toAlice.filter((t) => t.includes(notice))).toHaveLength(1);
    expect(toCarol.filter((t) => t.includes(notice))).toHaveLength(1);

    expect(mallory.receivedSince(since, 0x04)).toEqual([]);
    expect(gateway.runs('botone').filter((t) => t.from === 'mallory')).toEqual([]);
    botSilentTowards('mallory');
    const named = (stack.tap?.framesToServer() ?? []).filter((f) => f.payload.toString('latin1').includes('mallory'));
    const messages = new Map(named.map((f) => [imCookieOf(f), imRecipientOf(f)]));
    expect([...messages.values()].sort()).toEqual(['alice', 'carol']);
    mallory.signOff();
  }, 90_000);

  it('ignores a stranger invite and tells the owners', async () => {
    const stranger = await rawPeer('stranger2', 'strangerpw');
    const since = Date.now();
    const room: RoomRef = { exchange: 4, name: `trap${Date.now().toString(36)}` };
    await alice.session.joinRoom(room);
    stranger.sendInvite('botone', room);

    const notice = copy.noticeInvite('stranger2');
    await until(() => toAlice.some((t) => t.includes(notice)), { timeoutMs: 30_000, what: 'the invite notice' });
    expect(toAlice.join('\n')).not.toContain(room.name);
    await holds(async () => !(await stack.oos.roomOccupants(room.name)).includes('botone'), { forMs: 8000, what: 'the bot staying out of the room' });
    expect(stranger.receivedSince(since, 0x04)).toEqual([]);
    botSilentTowards('stranger2');
    await alice.session.leaveRoom(room);
    stranger.signOff();
  }, 90_000);

  it('joins a room an approved person invites it to within 10 s', async () => {
    const bob = await rawPeer('bob', PASSWORDS.bob);
    const room: RoomRef = { exchange: 4, name: `party${Date.now().toString(36)}` };
    await alice.session.joinRoom(room);
    const invitedAt = Date.now();
    bob.sendInvite('botone', room);
    await until(async () => (await stack.oos.roomOccupants(room.name)).includes('botone'), { timeoutMs: 10_000, what: 'the bot in the invited room' });
    expect(Date.now() - invitedAt).toBeLessThanOrEqual(10_000);
    bob.signOff();
  }, 60_000);

  it('refuses an agent send to an unlisted name', async () => {
    const stranger = await rawPeer('stranger3', 'strangerpw');
    const since = Date.now();
    const result = await gateway.agentSend('botone', 'stranger3', 'hello from the agent');
    expect(result.ok).toBe(false);
    await sleep(3000);
    expect(stranger.receivedSince(since, 0x04)).toEqual([]);
    botSilentTowards('stranger3');
    stranger.signOff();
  }, 60_000);

  it('rejoins the home room after the connections drop', async () => {
    stack.tap?.severAll();
    await until(async () => (await stack.oos.session('botone')) !== null && (await stack.oos.roomOccupants(HOME)).includes('botone'), {
      timeoutMs: 90_000, what: 'the bot back in its home room',
    });
  }, 120_000);

  it('sends five notices in a window and rolls the sixth stranger up when it closes', async () => {
    // A fresh gateway has fresh throttle state. One owner, because the hourly cap counts IMs sent.
    // Without per-connection source addresses the server allows ten logins a minute from this host,
    // so give its limiter a new window first.
    await gateway.stop();
    if (!(await sourceRotationAvailable())) await sleep(65_000);
    toAlice.length = 0;
    {
      // the hour is shortened to 40 s so the window closes, and the rollup goes out, inside the test
      gateway = await boot(['alice'], 40_000);
      await until(async () => (await stack.oos.session('botone')) !== null, { timeoutMs: 120_000, what: 'the bot to sign on again' });
      // the earlier test severed alice's connections too; she must be back, and the bot must have seen her
      // arrive, or the first notice counts as one stored for an absent owner
      await until(() => alice.session.getState().phase === 'online', { timeoutMs: 60_000, what: 'alice online again' });
      await sleep(5000);

      const names = ['stranger3', 'stranger4', 'stranger5', 'stranger6', 'stranger7', 'mallory'];
      for (const name of names) {
        const peer = await rawPeer(name, 'strangerpw');
        peer.sendIm('botone', 'hi');
        await sleep(1500);
        peer.signOff();
      }
      await until(() => toAlice.some((t) => t.includes(copy.noticeRollup(1))), { timeoutMs: 90_000, what: 'the rollup line' });
      for (const name of names.slice(0, 5)) expect(toAlice.filter((t) => t.includes(copy.noticeIm(name)))).toHaveLength(1);
      expect(toAlice.filter((t) => t.includes(copy.noticeIm('mallory')))).toEqual([]);
    }
  }, 400_000);
});
