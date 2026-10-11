import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('openclaw/plugin-sdk/channel-core', async () => (await import('../fake/openclaw.js')).channelCore);
vi.mock('openclaw/plugin-sdk/channel-outbound', async () => (await import('../fake/openclaw.js')).channelOutbound);
vi.mock('openclaw/plugin-sdk/channel-inbound', async () => (await import('../fake/openclaw.js')).channelInbound);
vi.mock('openclaw/plugin-sdk/routing', async () => (await import('../fake/openclaw.js')).routing);
vi.mock('openclaw/plugin-sdk/session-store-runtime', async () => (await import('../fake/openclaw.js')).sessionStoreRuntime);
vi.mock('openclaw/plugin-sdk/conversation-runtime', async () => (await import('../fake/openclaw.js')).conversationRuntime);
vi.mock('openclaw/plugin-sdk/reply-dispatch-runtime', async () => (await import('../fake/openclaw.js')).replyDispatchRuntime);
vi.mock('openclaw/plugin-sdk/channel-ingress-runtime', async () => (await import('../fake/openclaw.js')).channelIngressRuntime);
vi.mock('openclaw/plugin-sdk/reply-chunking', async () => (await import('../fake/openclaw.js')).replyChunking);
vi.mock('openclaw/plugin-sdk/status-helpers', async () => (await import('../fake/openclaw.js')).statusHelpers);

import { gatewayDeps, oscarPlugin, startAccount } from '../../src/channel.js';
import { SELF_ELIGIBLE_MS } from '../../src/chain/route.js';
import { readPolicy, resolveAccount } from '../../src/config.js';
import { copy } from '../../src/copy.js';
import { IM_TIMING } from '../../src/inbound/im.js';
import type { RoomRef } from '../../src/names.js';
import { storeFileFor } from '../../src/rooms/profiles.js';
import { getRuntime, resetRuntimeForTests, roomKey, roomsExt, setHost } from '../../src/runtime.js';
import { sdk } from '../fake/openclaw.js';
import { FakeOscarServer } from '../fake/oscar-server.js';
import { waitFor } from './helpers.js';

const ROOM: RoomRef = { exchange: 4, name: 'testroom' };
const BOTS = { one: 'botone', two: 'bottwo', three: 'botthree' } as const;
const realNow = gatewayDeps.now;

let stop: (() => Promise<void>) | undefined;
afterEach(async () => {
  await stop?.();
  stop = undefined;
  gatewayDeps.now = realNow;
});

async function startGateway(): Promise<{ server: FakeOscarServer; cfg: Record<string, unknown> }> {
  sdk.reset();
  resetRuntimeForTests();
  Object.assign(IM_TIMING, { debounceMs: 30, replyCooldownMs: 0, replaySettleMs: 200 });
  // Join times are stamped on the gateway clock and checked on the chain's; running the gateway behind lets the bots count as settled in the room.
  gatewayDeps.now = () => Date.now() - 2 * SELF_ELIGIBLE_MS;
  const server = await FakeOscarServer.start();
  server.addUser('alice', 'pw-alice');
  const accounts: Record<string, unknown> = {};
  for (const [id, name] of Object.entries(BOTS)) {
    server.addUser(name, `pw-${name}`);
    accounts[id] = { screenName: name, password: `pw-${name}` };
    rmSync(storeFileFor(id), { force: true });
  }
  const cfg: Record<string, unknown> = {
    commands: { config: true },
    channels: { oscar: { host: '127.0.0.1', port: server.port, tls: false, redirect: 'pin', owners: ['alice'], typing: false, accounts } },
  };
  setHost({ config: { current: () => cfg } });
  sdk.usePlugin(oscarPlugin);
  const abort = new AbortController();
  const parked = Object.keys(BOTS).map((accountId) => {
    let status: Record<string, unknown> = { accountId };
    return startAccount({
      cfg, accountId, account: resolveAccount(cfg, accountId), runtime: {}, abortSignal: abort.signal,
      log: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
      getStatus: () => status, setStatus: (next: Record<string, unknown>) => { status = next; },
    } as never);
  });
  await waitFor(() => Object.keys(BOTS).every((id) => getRuntime(id)?.session.getState().phase === 'online'), 10_000, 'every bot to sign on');
  stop = async () => {
    abort.abort();
    await Promise.all(parked);
    await server.stop();
    setHost(undefined);
    Object.assign(IM_TIMING, { debounceMs: 2000, replyCooldownMs: 2000, replaySettleMs: 3000 });
  };
  return { server, cfg };
}

describe('room profiles', () => {
  it('three teammates ask for settings, hold the owner line, answer it from the lead, and leave on /leave', async () => {
    const { server, cfg } = await startGateway();
    const names = Object.values(BOTS) as string[];
    expect(readPolicy(cfg).teammates).toEqual(names);
    sdk.agent = (ctx) => [{ text: `${BOTS[String(ctx.AccountId) as keyof typeof BOTS]} here` }];
    const alice = server.peer('alice');
    const fromBot = (bot: string) => alice.ims().filter((m) => m.from === bot).map((m) => m.text);

    alice.joinRoom(ROOM);
    for (const name of names) alice.invite(name, ROOM);
    await waitFor(() => names.every((name) => fromBot(name).length === 1), 10_000, 'every bot to ask for settings');
    for (const name of names) expect(fromBot(name)).toEqual([copy.setupAskNew('testroom', names, 'alice')]);
    expect(server.occupants(ROOM).sort()).toEqual(['alice', ...names].sort());

    alice.say(ROOM, 'what is the plan?', { cookie: 7001n });
    await waitFor(() => names.every((name) => fromBot(name).length === 2), 10_000, 'every bot to say it is waiting');
    for (const name of names) expect(fromBot(name)[1]).toBe(copy.setupReminder('testroom'));
    expect(sdk.inbound).toEqual([]);
    expect(alice.roomLines(ROOM).filter((l) => l.from !== 'alice')).toEqual([]);

    for (const name of names) alice.sendIm(name, 'team private botone bottwo botthree');
    const applied = copy.setupApplied('testroom', 'team, private, rank botone bottwo botthree');
    await waitFor(() => names.every((name) => fromBot(name).includes(applied)), 10_000, 'every bot to confirm');
    await waitFor(() => alice.roomLines(ROOM).some((l) => l.text === 'botone here'), 10_000, 'the lead to answer the held line');
    await waitFor(() => Object.keys(BOTS).every((id) => getRuntime(id)?.chain?.standbys() === 0), 10_000, 'the other bots to stand down');
    expect(sdk.inbound.filter((r) => r.ctx.RawBody === 'what is the plan?').map((r) => r.accountId)).toEqual(['one']);
    expect(alice.roomLines(ROOM).filter((l) => l.from !== 'alice' && !l.whisper).map((l) => l.text)).toEqual(['botone here']);

    alice.say(ROOM, 'bottwo: draft the intro', { cookie: 7002n });
    await waitFor(() => alice.roomLines(ROOM).some((l) => l.text === 'bottwo here'), 10_000, 'bottwo to answer');
    const key = roomKey(ROOM);
    await waitFor(
      () => (roomsExt(getRuntime('one')!).history.get(key) ?? []).some((h) => h.sender === 'bottwo (bot)'),
      10_000, 'botone to record bottwo as a teammate',
    );
    expect(roomsExt(getRuntime('one')!).history.get(key)?.map((h) => [h.sender, h.body])).toEqual([
      ['alice (owner)', 'bottwo: draft the intro'],
      ['bottwo (bot)', 'bottwo here'],
    ]);
    expect(getRuntime('one')?.rooms.get(key)?.omittedCount).toBe(0);

    alice.say(ROOM, '/leave', { cookie: 7003n });
    await waitFor(() => server.occupants(ROOM).length === 1, 10_000, 'every bot to leave');
    expect(server.occupants(ROOM)).toEqual(['alice']);
  }, 40_000);
});
