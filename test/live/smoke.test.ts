import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RoomRef } from '../../src/oscar/types.js';
import { accountIdFor, gatewayConfig } from './support/config.js';
import { liveEnv, type Credential } from './support/env.js';
import { bootGateway, type LiveGateway } from './support/gateway.js';
import { startSession, type Captured } from './support/session.js';
import { startStack, type ClientTarget, type Stack } from './support/stack.js';
import { until } from './support/wait.js';

const env = liveEnv();

describe.skipIf(env.mode === 'off')('smoke', () => {
  let stack: Stack | null = null;
  let target: ClientTarget;
  let a: Credential;
  let b: Credential;
  let roomName: string;
  let gateway: LiveGateway;
  let owner: Captured;
  const toOwner: string[] = [];
  const inRoom: string[] = [];

  beforeAll(async () => {
    if (env.mode === 'local') {
      stack = await startStack(env);
      a = { screenName: 'botone', password: 'botonepass' };
      b = { screenName: 'alice', password: 'alicepass1' };
      await stack.oos.createUser(a.screenName, a.password);
      await stack.oos.createUser(b.screenName, b.password);
      target = stack.target;
      roomName = `smoke${Date.now().toString(36)}`;
    } else if (env.mode === 'remote') {
      a = env.a;
      b = env.b;
      target = { host: env.host, port: env.port, tls: env.tls, ...(env.caFile ? { caFile: env.caFile } : {}) };
      roomName = env.room;
    } else {
      return;
    }
    owner = await startSession(target, b.screenName, b.password, { buddies: () => [a.screenName] });
    owner.session.on('im', (m) => toOwner.push(m.text));
    owner.session.on('roomMessage', (m) => inRoom.push(`${m.from}: ${m.text}`));
    gateway = await bootGateway({
      cfg: gatewayConfig({ target, accounts: { [a.screenName]: a.password }, owners: [b.screenName], allowFrom: [b.screenName], room: roomName }),
    });
    gateway.setAgent(async (turn, agent) => {
      await agent.sleep(6000);
      agent.reply(`smoke reply to: ${turn.body}`);
    });
    await gateway.start();
  }, 180_000);

  afterAll(async () => {
    await gateway?.stop();
    await owner?.session.stop();
    await stack?.stop();
  });

  it('signs on, checks passwords are checked, and raises no blocking issue', async () => {
    const bot = accountIdFor(a.screenName);
    await until(() => owner.session.presenceOf(bot)?.online === true, { timeoutMs: 120_000, what: 'the bot to show as online to its owner' });
    const issues = await gateway.issues(accountIdFor(a.screenName));
    expect(issues.filter((i) => /does not check passwords|bad password|not configured|rate limited/i.test(i))).toEqual([]);
  }, 150_000);

  it('answers an owner IM and shows away while it works', async () => {
    const bot = accountIdFor(a.screenName);
    await owner.session.sendIm(bot, 'smoke ping');
    await until(() => owner.session.presenceOf(bot)?.away === true, { timeoutMs: 20_000, what: 'the away flag' });
    await until(() => toOwner.includes('smoke reply to: smoke ping'), { timeoutMs: 30_000, what: 'the reply' });
    await until(() => owner.session.presenceOf(bot)?.away === false, { timeoutMs: 10_000, what: 'the away flag to clear' });
    expect(gateway.runs(accountIdFor(a.screenName))).toHaveLength(1);
  }, 90_000);

  it('sits in its home room and answers an owner line there', async () => {
    const bot = accountIdFor(a.screenName);
    const room: RoomRef = { exchange: 4, name: roomName };
    await owner.session.joinRoom(room);
    await until(() => owner.session.rooms().some((r) => r.occupants.includes(bot)), { timeoutMs: 60_000, what: 'the bot in the room roster' });
    await owner.session.sendRoom(room, 'smoke line in the room');
    await until(() => inRoom.includes(`${bot}: smoke reply to: smoke line in the room`), { timeoutMs: 45_000, what: 'the room reply' });
    await owner.session.leaveRoom(room);
  }, 150_000);
});
