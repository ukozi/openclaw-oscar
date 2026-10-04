import { describe, expect, it } from 'vitest';
import { LOUNGE_BOT_CAP, LoungeCounter, roomPolicy, roomRank, routeLounge, routeWatch } from '../../../src/chain/modes.js';
import type { RouteInput } from '../../../src/chain/route.js';
import { chainConfig, policyFixture, roomFixture } from './fixtures.js';

const NOW = 1_000_000;
const RK = 'testroom';

function input(over: Partial<RouteInput> & { from?: string; text?: string; whisper?: boolean; cookie?: bigint } = {}): RouteInput {
  const { from = 'alice', text = 'what is the status?', whisper = false, cookie = 77n, ...rest } = over;
  return {
    self: 'botone',
    now: NOW,
    policy: policyFixture(),
    room: roomFixture(),
    rosterMismatch: false,
    message: { from, text, whisper, cookie },
    asked: new Map(),
    openHandoffIds: new Set(),
    seenHandoffs: new Set(),
    ...rest,
  };
}

const noRoster = policyFixture({ chain: chainConfig({ roster: [] }), teammates: ['botthree', 'botone', 'bottwo'] });

describe('roomRank', () => {
  it('takes the profile rank first', () => {
    expect(roomRank(policyFixture(), { mode: 'team', rank: ['bottwo', 'botone'] })).toEqual(['bottwo', 'botone']);
  });

  it('falls back to the global roster', () => {
    expect(roomRank(policyFixture(), { mode: 'team' })).toEqual(['botone', 'bottwo', 'botthree']);
  });

  it('falls back to the teammates in alphabetical order', () => {
    expect(roomRank(noRoster, { mode: 'team' })).toEqual(['botone', 'botthree', 'bottwo']);
  });

  it('a lone bot with no roster has no rank', () => {
    expect(roomRank(policyFixture({ chain: chainConfig({ roster: [] }), teammates: ['botone'] }), { mode: 'team' })).toEqual([]);
  });
});

describe('roomPolicy', () => {
  it('orders the roster by rank and keeps role and aliases from the global roster', () => {
    const scoped = roomPolicy(policyFixture(), { mode: 'team', rank: ['bottwo', 'botone'] });
    expect(scoped.chain.roster).toEqual([
      { screenName: 'bottwo', role: 'writing and editing', aliases: ['writer'] },
      { screenName: 'botone', role: 'lead, planning, anything unassigned', aliases: [] },
    ]);
  });

  it('a name missing from the global roster gets a bare entry', () => {
    expect(roomPolicy(noRoster, { mode: 'team', rank: ['botthree'] }).chain.roster).toEqual([
      { screenName: 'botthree', role: '', aliases: [] },
    ]);
  });
});

describe('routeLounge', () => {
  it('an owner line wakes every teammate present', () => {
    for (const self of ['botone', 'bottwo', 'botthree']) {
      expect(routeLounge(input({ self }), new LoungeCounter(), RK)).toMatchObject({ kind: 'wake', why: 'lounge', origin: 'owner' });
    }
  });

  it('an approved line wakes only from the inviter', () => {
    expect(routeLounge(input({ from: 'bob' }), new LoungeCounter(), RK)).toEqual({ kind: 'record' });
    const room = roomFixture({ invitedBy: 'bob' });
    expect(routeLounge(input({ from: 'bob', room }), new LoungeCounter(), RK)).toMatchObject({ kind: 'wake', why: 'lounge', origin: 'approved' });
  });

  it(`teammate lines wake up to ${LOUNGE_BOT_CAP} times after a person speaks, then record until one speaks again`, () => {
    const cap = new LoungeCounter();
    routeLounge(input(), cap, RK);
    for (let i = 1; i <= LOUNGE_BOT_CAP; i++) {
      expect(routeLounge(input({ from: 'bottwo', text: `point ${i}`, cookie: BigInt(i) }), cap, RK)).toMatchObject({ kind: 'wake', why: 'lounge', origin: 'bot' });
    }
    expect(routeLounge(input({ from: 'botthree', text: 'one more' }), cap, RK)).toEqual({ kind: 'record' });
    routeLounge(input({ text: 'go on' }), cap, RK);
    expect(routeLounge(input({ from: 'botthree', text: 'one more' }), cap, RK)).toMatchObject({ kind: 'wake', origin: 'bot' });
  });

  it('the cap is kept per room', () => {
    const cap = new LoungeCounter();
    for (let i = 0; i <= LOUNGE_BOT_CAP; i++) routeLounge(input({ from: 'bottwo', text: `point ${i}` }), cap, RK);
    expect(cap.allowBot(RK)).toBe(false);
    expect(cap.allowBot('other')).toBe(true);
    cap.clear(RK);
    expect(cap.allowBot(RK)).toBe(true);
  });

  it('a named line wakes only the named bot', () => {
    const text = 'bottwo: draft the note';
    expect(routeLounge(input({ self: 'bottwo', text }), new LoungeCounter(), RK)).toMatchObject({ kind: 'wake', why: 'lounge' });
    expect(routeLounge(input({ self: 'botone', text }), new LoungeCounter(), RK)).toEqual({ kind: 'record' });
    expect(routeLounge(input({ self: 'botthree', from: 'botone', text }), new LoungeCounter(), RK)).toEqual({ kind: 'record' });
  });

  it('teammate whispers record, #oc whispers are ignored', () => {
    expect(routeLounge(input({ from: 'bottwo', text: 'psst', whisper: true }), new LoungeCounter(), RK)).toEqual({ kind: 'record' });
    expect(routeLounge(input({ from: 'bottwo', text: '#oc took alice:4d', whisper: true }), new LoungeCounter(), RK)).toEqual({ kind: 'ignore' });
  });

  it('unlisted senders are counted, own lines ignored', () => {
    expect(routeLounge(input({ from: 'mallory' }), new LoungeCounter(), RK)).toEqual({ kind: 'count' });
    expect(routeLounge(input({ from: 'botone' }), new LoungeCounter(), RK)).toEqual({ kind: 'ignore' });
  });

  it('a bot not yet settled in the room stays quiet', () => {
    expect(routeLounge(input({ room: roomFixture({ selfJoinedAt: NOW }) }), new LoungeCounter(), RK)).toEqual({ kind: 'record' });
  });
});

describe('routeWatch', () => {
  it('an unnamed owner line records', () => {
    expect(routeWatch(input())).toEqual({ kind: 'record' });
  });

  it('a named line wakes the named bot', () => {
    expect(routeWatch(input({ text: 'botone: what is up?' }))).toMatchObject({ kind: 'wake', why: 'named', origin: 'owner' });
    expect(routeWatch(input({ self: 'bottwo', text: 'botone: what is up?' }))).toEqual({ kind: 'record' });
  });

  it('a teammate naming this bot wakes it, an unnamed teammate line records', () => {
    expect(routeWatch(input({ self: 'bottwo', from: 'botone', text: 'bottwo: your turn' }))).toMatchObject({ kind: 'wake', why: 'named', origin: 'bot' });
    expect(routeWatch(input({ self: 'bottwo', from: 'botone', text: 'done here' }))).toEqual({ kind: 'record' });
  });

  it('unlisted senders are counted', () => {
    expect(routeWatch(input({ from: 'mallory', text: 'botone: hi' }))).toEqual({ kind: 'count' });
  });
});
