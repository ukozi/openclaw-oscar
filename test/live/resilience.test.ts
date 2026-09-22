import { afterEach, describe, expect, it } from 'vitest';
import { toWireHtml } from '../../src/oscar/text.js';
import type { RateEvent, RoomRef } from '../../src/oscar/types.js';
import { liveEnv } from './support/env.js';
import { RawPeer } from './support/raw-peer.js';
import { startSession, type Captured } from './support/session.js';
import { startStack, type Stack } from './support/stack.js';
import { holds, sleep, until } from './support/wait.js';

const env = liveEnv();
const BOT_PASSWORD = 'botonepass';
const ALICE_PASSWORD = 'alicepass1';

describe.skipIf(env.mode !== 'local')('staying up', () => {
  let stack: Stack | null = null;
  let sessions: Captured[] = [];

  async function setUp(botFlag: boolean): Promise<{ bot: Captured; alice: Captured; got: string[] }> {
    if (env.mode !== 'local') throw new Error('local only');
    stack = await startStack(env);
    await stack.oos.createUser('botone', BOT_PASSWORD, { bot: botFlag });
    await stack.oos.createUser('alice', ALICE_PASSWORD);
    const alice = await startSession(stack.target, 'alice', ALICE_PASSWORD, { buddies: () => ['botone'] });
    const bot = await startSession(stack.target, 'botone', BOT_PASSWORD, { buddies: () => ['alice'] });
    sessions.push(alice, bot);
    await until(() => bot.session.presenceOf('alice')?.online === true, { timeoutMs: 10_000, what: 'alice to show as online' });
    const got: string[] = [];
    alice.session.on('im', (m) => got.push(m.text));
    return { bot, alice, got };
  }

  afterEach(async () => {
    for (const s of sessions) await s.session.stop();
    sessions = [];
    await stack?.stop();
    stack = null;
  });

  it('paces an unflagged account and loses nothing', async () => {
    const { bot, got } = await setUp(false);
    const started = Date.now();
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) => bot.session.sendIm('alice', toWireHtml(`line ${i + 1} of 12`))),
    );
    const elapsed = Date.now() - started;
    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
    await until(() => got.length === 12, { timeoutMs: 15_000, what: 'all twelve lines at alice' });
    expect(got).toEqual(Array.from({ length: 12 }, (_, i) => `line ${i + 1} of 12`));
    // rate class 3 allows about seven back-to-back sends, then one every 4 to 5 seconds
    expect(elapsed).toBeGreaterThan(12_000);
    expect(bot.session.getState().phase).toBe('online');
  }, 180_000);

  it('does not pace a bot-flagged account', async () => {
    const { bot, got } = await setUp(true);
    const started = Date.now();
    await Promise.all(Array.from({ length: 12 }, (_, i) => bot.session.sendIm('alice', toWireHtml(`line ${i + 1} of 12`))));
    expect(Date.now() - started).toBeLessThan(8000);
    await until(() => got.length === 12, { timeoutMs: 10_000, what: 'all twelve lines at alice' });
  }, 60_000);

  it('treats a missing receipt as a rate drop: goes quiet, retries once with the same cookie, delivers once', async () => {
    const { bot, got } = await setUp(false);
    const rates: RateEvent[] = [];
    bot.session.on('rate', (e) => rates.push(e));
    const before = stack?.tap?.framesToServer().length ?? 0;
    stack?.tap?.dropNext((f) => f.family === 0x04 && f.subtype === 0x06);

    const receipt = await bot.session.sendIm('alice', toWireHtml('only once please'));
    expect(receipt.storedOffline).toBe(false);
    await sleep(3000);
    expect(got).toEqual(['only once please']);

    const sends = (stack?.tap?.framesToServer() ?? []).slice(before).filter((f) => f.family === 0x04 && f.subtype === 0x06);
    expect(sends).toHaveLength(2);
    // SNAC header is 10 bytes; the ICBM cookie is the next 8
    expect(sends[1]?.payload.subarray(10, 18).equals(sends[0]?.payload.subarray(10, 18) ?? Buffer.alloc(0))).toBe(true);
    expect(rates.some((e) => e.scope === 'bos' && e.status === 'limited')).toBe(true);
  }, 180_000);

  it('does not fight a second sign-on for its screen name', async () => {
    const { bot } = await setUp(false);
    if (!stack) throw new Error('no stack');
    const connectionsBefore = stack.tap?.connections() ?? 0;
    const intruder = await RawPeer.signOn({ host: '127.0.0.1', port: stack.oos.ports.oscar, screenName: 'botone', password: BOT_PASSWORD, multiConn: 0x03 });

    await until(() => bot.session.getState().phase === 'backoff', { timeoutMs: 10_000, what: 'the bot to notice it was displaced' });
    expect(bot.session.getState().reason).toBe('disconnected-by-server');
    // the first retry is a minute away, so nothing new may be dialled and the newcomer must stay signed on
    await holds(() => (stack?.tap?.connections() ?? 0) === connectionsBefore && !intruder.kicked(), { forMs: 20_000, what: 'the bot staying away' });
    intruder.signOff();
  }, 90_000);

  it('comes back after the server restarts and rejoins its room', async () => {
    const { bot, alice, got } = await setUp(false);
    if (!stack) throw new Error('no stack');
    const room: RoomRef = { exchange: 4, name: `home${Date.now().toString(36)}` };
    await bot.session.joinRoom(room, { persistent: true });
    await until(async () => (await stack?.oos.roomOccupants(room.name))?.includes('botone'), { timeoutMs: 10_000, what: 'the bot in its room' });

    await stack.oos.restart();
    await until(() => bot.session.getState().phase !== 'online', { timeoutMs: 30_000, what: 'the bot to notice the restart' });
    await until(() => bot.session.getState().phase === 'online', { timeoutMs: 90_000, what: 'the bot to sign on again' });
    await until(async () => (await stack?.oos.roomOccupants(room.name))?.includes('botone'), { timeoutMs: 45_000, what: 'the bot back in its room' });

    await until(() => alice.session.getState().phase === 'online', { timeoutMs: 90_000, what: 'alice to sign on again' });
    await until(() => bot.session.presenceOf('alice')?.online === true, { timeoutMs: 20_000, what: 'alice to show as online again' });
    await bot.session.sendIm('alice', toWireHtml('back again'));
    await until(() => got.includes('back again'), { timeoutMs: 15_000, what: 'an IM after the restart' });
  }, 300_000);

  it('rejoins its room when only the connections drop', async () => {
    const { bot } = await setUp(false);
    if (!stack) throw new Error('no stack');
    const room: RoomRef = { exchange: 4, name: `home${Date.now().toString(36)}` };
    await bot.session.joinRoom(room, { persistent: true });
    await until(async () => (await stack?.oos.roomOccupants(room.name))?.includes('botone'), { timeoutMs: 10_000, what: 'the bot in its room' });

    stack.tap?.severAll();
    await until(() => bot.session.getState().phase !== 'online', { timeoutMs: 10_000, what: 'the bot to notice the drop' });
    await until(async () => bot.session.getState().phase === 'online' && (await stack?.oos.roomOccupants(room.name))?.includes('botone'), {
      timeoutMs: 60_000, what: 'the bot online and back in its room',
    });
  }, 120_000);
});
