import { afterAll, describe, expect, it } from 'vitest';
import { liveEnv } from './support/env.js';
import { imRecipient } from './support/oos.js';
import { RawPeer } from './support/raw-peer.js';
import { startStack, type Stack } from './support/stack.js';
import { sleep, until } from './support/wait.js';

const env = liveEnv();

describe.skipIf(env.mode !== 'local')('live harness', () => {
  let stack: Stack;
  afterAll(async () => {
    await stack?.stop();
  });

  it('starts the server, creates users and reads its log', async () => {
    if (env.mode !== 'local') return;
    stack = await startStack(env);
    await stack.oos.createUser('alice', 'alicepass1');
    await stack.oos.createUser('botone', 'botonepass', { bot: true });

    const alice = await RawPeer.signOn({ host: '127.0.0.1', port: stack.oos.ports.oscar, screenName: 'alice', password: 'alicepass1' });
    const bot = await RawPeer.signOn({ host: '127.0.0.1', port: stack.oos.ports.oscar, screenName: 'botone', password: 'botonepass' });

    expect((await stack.oos.session('alice'))?.away).toBe(false);
    expect((await alice.userInfo('botone')).flags & 0x0400).toBe(0x0400);
    expect((await bot.userInfo('alice')).flags & 0x0400).toBe(0);

    // alice also asked about herself while signing on, so look for the query that names the bot
    const logged = await until(() => {
      const hits = stack.oos.requestsFrom('alice').filter((r) => r.family === 0x02 && r.subtype === 0x05 && r.line.includes('ScreenName:botone'));
      return hits.length > 0 ? hits : null;
    }, { timeoutMs: 5000, what: "alice's Locate query about the bot in the server log" });
    expect(logged).toHaveLength(1);

    // the server logs the copy it forwards to the bot as well; the reader must not count it as sent by the bot
    alice.sendIm('Bot One', 'hello bot');
    await until(() => bot.ims().length === 1, { timeoutMs: 5000, what: 'the IM at the bot' });
    const sends = await until(() => {
      const hits = stack.oos.requestsFrom('alice').filter((r) => r.family === 0x04 && r.subtype === 0x06);
      return hits.length > 0 ? hits : null;
    }, { timeoutMs: 5000, what: "alice's IM in the server log" });
    expect(sends.map((r) => imRecipient(r.line))).toEqual(['botone']);
    await sleep(300);
    expect(stack.oos.requestsFrom('botone').filter((r) => r.family === 0x04)).toEqual([]);

    alice.signOff();
    bot.signOff();
  }, 60_000);

  it('refuses a wrong password', async () => {
    if (env.mode !== 'local') return;
    await expect(
      RawPeer.signOn({ host: '127.0.0.1', port: stack.oos.ports.oscar, screenName: 'alice', password: 'not-the-one' }),
    ).rejects.toThrow(/code 0x5/);
  });

  it('keeps users across a restart', async () => {
    if (env.mode !== 'local') return;
    await stack.oos.restart();
    const alice = await RawPeer.signOn({ host: '127.0.0.1', port: stack.oos.ports.oscar, screenName: 'alice', password: 'alicepass1' });
    expect((await stack.oos.session('alice'))?.instances).toBe(1);
    alice.signOff();
  }, 60_000);
});
