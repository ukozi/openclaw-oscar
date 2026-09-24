import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('openclaw/plugin-sdk/channel-outbound', async () => (await import('../fake/openclaw.js')).channelOutbound);

import { fallbackFor, sendByFallback } from '../../src/fallback.js';
import { resetRuntimeForTests, setRuntime } from '../../src/runtime.js';
import { sdk } from '../fake/openclaw.js';
import { FakeSession } from '../fake/session.js';

const route = { screenName: 'Al Ice', channel: 'signal', to: 'c1072e4a' };
const cfg = (fallback: unknown[] = [route]) => ({
  channels: { oscar: { host: 'h', password: 'p', owners: ['alice'], allowFrom: ['bob'], accounts: { cal: { screenName: 'botone', fallback }, jane: { screenName: 'bottwo' } } } },
});
const im = (name: string) => ({ kind: 'im' as const, name });
let session: FakeSession;

beforeEach(() => {
  sdk.reset();
  resetRuntimeForTests();
  session = new FakeSession();
  session.setState({ phase: 'online' });
  setRuntime({ accountId: 'cal', session: session.asSession(), rooms: new Map(), sessionKeys: new Map(), lastReplyAt: new Map(), counters: { droppedSends: 0, eventGaps: 0 } });
});

describe('fallbackFor', () => {
  it('keeps a present owner on AIM', () => {
    session.setPresence('alice', { online: true, away: false });
    expect(fallbackFor(cfg(), 'cal', im('alice'))).toBeNull();
  });

  it.each([
    ['away', { online: true, away: true }],
    ['offline', { online: false, away: false }],
  ] as const)('reroutes when the owner is %s', (reason, presence) => {
    session.setPresence('alice', presence);
    expect(fallbackFor(cfg(), 'cal', im('alice'))).toEqual({ route: { screenName: 'alice', channel: 'signal', to: 'c1072e4a' }, reason });
  });

  it('reroutes when presence is unknown', () => {
    expect(fallbackFor(cfg(), 'cal', im('alice'))?.reason).toBe('unknown');
  });

  it('reroutes when the account is not online', () => {
    session.setPresence('alice', { online: true });
    session.setState({ phase: 'backoff' });
    expect(fallbackFor(cfg(), 'cal', im('alice'))?.reason).toBe('not-signed-on');
  });

  it('reroutes when the account runtime is halted or missing', () => {
    session.setPresence('alice', { online: true });
    setRuntime({
      accountId: 'cal', session: session.asSession(), rooms: new Map(), sessionKeys: new Map(), lastReplyAt: new Map(),
      counters: { droppedSends: 0, eventGaps: 0 }, halted: { reason: 'unauthenticated-server', detail: 'x' },
    });
    expect(fallbackFor(cfg(), 'cal', im('alice'))?.reason).toBe('not-signed-on');
    resetRuntimeForTests();
    expect(fallbackFor(cfg(), 'cal', im('alice'))?.reason).toBe('not-signed-on');
  });

  it('ignores people not on the list, rooms and other accounts', () => {
    session.setPresence('bob', { online: false });
    expect(fallbackFor(cfg(), 'cal', im('bob'))).toBeNull();
    expect(fallbackFor(cfg(), 'cal', { kind: 'room', room: { exchange: 4, name: 'testroom' } } as never)).toBeNull();
    expect(fallbackFor(cfg(), 'jane', im('alice'))).toBeNull();
    expect(fallbackFor(cfg([]), 'cal', im('alice'))).toBeNull();
  });

  it('matches the target name however it is written', () => {
    expect(fallbackFor(cfg(), 'cal', im('Al Ice'))?.route.screenName).toBe('alice');
  });
});

describe('sendByFallback', () => {
  const decision = { route: { screenName: 'alice', channel: 'signal', to: 'c1072e4a' }, reason: 'away' as const };

  it('sends the text to the other channel', async () => {
    expect(await sendByFallback(cfg(), 'cal', decision, 'hello')).toBe(true);
    expect(sdk.foreign).toEqual([{ channel: 'signal', to: 'c1072e4a', text: 'hello' }]);
  });

  it('keeps the send out of the host retry queue', async () => {
    await sendByFallback(cfg(), 'cal', decision, 'x');
    expect(sdk.foreignParams[0]?.skipQueue).toBe(true);
  });

  it('passes the other channel account through', async () => {
    await sendByFallback(cfg(), 'cal', { ...decision, route: { ...decision.route, accountId: 'main' } }, 'x');
    expect(sdk.foreign[0]?.accountId).toBe('main');
  });

  it.each(['failed', 'throw'] as const)('reports false when the send %s', async (mode) => {
    sdk.foreignFail = mode;
    expect(await sendByFallback(cfg(), 'cal', decision, 'x')).toBe(false);
  });
});
