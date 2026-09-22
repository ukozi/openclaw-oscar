import { afterEach, describe, expect, it } from 'vitest';
import { toWireHtml } from '../../src/oscar/text.js';
import type { RoomRef } from '../../src/oscar/types.js';
import { liveEnv } from './support/env.js';
import { startSession, type Captured } from './support/session.js';
import { startStack, type Stack } from './support/stack.js';
import { opensslAvailable } from './support/tls-proxy.js';
import { until } from './support/wait.js';

const env = liveEnv();
const BOT_PASSWORD = 'botonepass';
const ALICE_PASSWORD = 'alicepass1';
const PING = 'zebra ping 7731';
const PONG = 'zebra pong 7731';
const ROOM_LINE = 'zebra room 7731';

type Case = { bot: boolean; tls: boolean; redirect: 'auto' | 'follow' | 'pin' };
const cases: Case[] = [];
for (const bot of [false, true]) {
  for (const tls of [false, true]) {
    for (const redirect of ['auto', 'follow', 'pin'] as const) cases.push({ bot, tls, redirect });
  }
}

describe.skipIf(env.mode !== 'local')('transport matrix', () => {
  let stack: Stack | null = null;
  let sessions: Captured[] = [];

  afterEach(async () => {
    for (const s of sessions) await s.session.stop();
    sessions = [];
    await stack?.stop();
    stack = null;
  });

  for (const c of cases) {
    const name = `bot flag ${c.bot ? 'on' : 'off'}, ${c.tls ? 'TLS' : 'plaintext'}, redirect ${c.redirect}`;
    it.skipIf(c.tls && !opensslAvailable())(name, async () => {
      if (env.mode !== 'local') return;
      stack = await startStack(env, { tls: c.tls, advertise: 'separate' });
      await stack.oos.createUser('botone', BOT_PASSWORD, { bot: c.bot });
      await stack.oos.createUser('alice', ALICE_PASSWORD);

      // On v0.24.0 a TLS login is answered with the plaintext host. "follow" fails with reason tls
      // and never dials that address, so the tap there sees no connection.
      const cannotRun = c.tls && c.redirect === 'follow' && env.generation === 'v0.24';
      const bot = await startSession(stack.target, 'botone', BOT_PASSWORD, { redirect: c.redirect, waitOnline: !cannotRun, buddies: () => ['alice'] });
      sessions.push(bot);
      if (cannotRun) {
        const state = await until(() => {
          const s = bot.session.getState();
          return s.phase === 'backoff' || s.phase === 'fatal' ? s : null;
        }, { timeoutMs: 45_000, what: 'the session to give up on the plaintext address' });
        expect(state.reason).toBe('tls');
        expect(stack.advertisedTap.connections()).toBe(0);
        expect(stack.advertisedTap.framesToServer()).toEqual([]);
        return;
      }
      const plainByBot = stack.advertisedTap.connections();
      const tlsByBot = stack.advertisedTlsProxy?.connections() ?? 0;
      const alice = await startSession(stack.target, 'alice', ALICE_PASSWORD, { redirect: c.redirect, buddies: () => ['botone'] });
      sessions.push(alice);

      expect(bot.session.selfInfo()).toEqual({ screenName: 'botone', bot: c.bot });
      await until(() => bot.session.presenceOf('alice')?.online === true, { timeoutMs: 10_000, what: 'alice to show as online to the bot' });

      const toBot: string[] = [];
      const toAlice: string[] = [];
      bot.session.on('im', (m) => toBot.push(`${m.from}:${m.text}`));
      alice.session.on('im', (m) => toAlice.push(`${m.from}:${m.text}`));
      await alice.session.sendIm('botone', toWireHtml(PING));
      await until(() => toBot.includes(`alice:${PING}`), { timeoutMs: 10_000, what: 'the IM at the bot' });
      const receipt = await bot.session.sendIm('alice', toWireHtml(PONG));
      expect(receipt.storedOffline).toBe(false);
      await until(() => toAlice.includes(`botone:${PONG}`), { timeoutMs: 10_000, what: 'the reply at alice' });

      const room: RoomRef = { exchange: 4, name: `t${Date.now().toString(36)}` };
      const heard: string[] = [];
      alice.session.on('roomMessage', (m) => heard.push(`${m.from}:${m.text}`));
      await bot.session.joinRoom(room);
      await alice.session.joinRoom(room);
      await until(() => alice.session.rooms().some((r) => r.occupants.includes('botone')), { timeoutMs: 10_000, what: 'the bot in the room roster' });
      await bot.session.sendRoom(room, toWireHtml(ROOM_LINE));
      await until(() => heard.includes(`botone:${ROOM_LINE}`), { timeoutMs: 10_000, what: 'the room line at alice' });

      const plainFollowed = stack.advertisedTap.connections();
      const tlsFollowed = stack.advertisedTlsProxy?.connections() ?? 0;
      // the configured host is loopback too, so "auto" follows a loopback advertisement as "follow" does
      const follows = c.redirect !== 'pin';
      if (c.tls) {
        expect(plainFollowed).toBe(0);
        // v0.24.0 answers a TLS login with SSL state 0, which makes "auto" pin
        if (env.generation === 'main' && follows) expect(tlsByBot).toBeGreaterThan(0);
        else expect(tlsFollowed).toBe(0);
      } else if (follows) {
        expect(plainByBot).toBeGreaterThan(0);
      } else {
        expect(plainFollowed).toBe(0);
      }

      const lines = [...bot.logLines, ...alice.logLines];
      expect(lines.filter((l) => l.includes(BOT_PASSWORD) || l.includes(ALICE_PASSWORD))).toEqual([]);
      const aboveDebug = lines.filter((l) => !l.startsWith('debug '));
      expect(aboveDebug.filter((l) => l.includes('zebra'))).toEqual([]);
    }, 120_000);
  }
});
