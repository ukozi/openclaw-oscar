import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HelloExchange, helloLine, parseHello } from '../../../src/chain/hello.js';
import { rosterHash } from '../../../src/config.js';
import { chainConfig, policyFixture } from './fixtures.js';

function make(self: string) {
  const send = vi.fn();
  const state = { policy: policyFixture() };
  const hello = new HelloExchange({ self: () => self, policy: () => state.policy, send });
  return { hello, send, state, mine: rosterHash(state.policy.chain) };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('hello lines', () => {
  it('round-trips', () => {
    expect(helloLine(2, '0a1b2c3d')).toBe('#oc hello r=2 h=0a1b2c3d');
    expect(parseHello('#oc hello r=2 h=0a1b2c3d')).toEqual({ rank: 2, hash: '0a1b2c3d' });
  });
  it.each(['#oc hello', '#oc hello r=2', '#oc hello r=x h=0a1b2c3d', '#oc hello r=2 h=XYZ', 'hello r=2 h=0a1b2c3d', '#oc took alice:4d'])('rejects %j', (t) => {
    expect(parseHello(t)).toBeNull();
  });
});

describe('HelloExchange', () => {
  it('only the lower name initiates', () => {
    const low = make('botone');
    low.hello.onPeerSeen('bottwo');
    expect(low.send).toHaveBeenCalledWith('bottwo', helloLine(1, low.mine));
    const high = make('bottwo');
    high.hello.onPeerSeen('botone');
    expect(high.send).not.toHaveBeenCalled();
  });

  it('ignores names outside the roster and itself', () => {
    const { hello, send } = make('botone');
    hello.onPeerSeen('alice');
    hello.onPeerSeen('botone');
    expect(send).not.toHaveBeenCalled();
  });

  it('joining a room greets every higher-named roster peer there, once per 30 s', () => {
    const { hello, send } = make('botone');
    hello.onRoomJoined(['alice', 'botone', 'bottwo', 'botthree']);
    expect(send.mock.calls.map((c) => c[0]).sort()).toEqual(['botthree', 'bottwo']);
    hello.onRoomJoined(['bottwo']);
    expect(send).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(30_001);
    hello.onRoomJoined(['bottwo']);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('the higher name answers, the lower never does', () => {
    const high = make('bottwo');
    expect(high.hello.onIm('botone', helloLine(1, 'deadbeef'))).toBe('handled');
    expect(high.send).toHaveBeenCalledWith('botone', helloLine(2, high.mine));
    const low = make('botone');
    expect(low.hello.onIm('bottwo', helloLine(2, 'deadbeef'))).toBe('handled');
    expect(low.send).not.toHaveBeenCalled();
  });

  it('reports present peers whose hash differs', () => {
    const { hello, mine } = make('botone');
    hello.onIm('bottwo', helloLine(2, 'deadbeef'));
    hello.onIm('botthree', helloLine(3, mine));
    expect(hello.hashOf('bottwo')).toBe('deadbeef');
    expect(hello.mismatchedIn(['alice', 'bottwo', 'botthree'])).toEqual(['bottwo']);
    expect(hello.mismatchedIn(['botthree'])).toEqual([]);
    expect(hello.mismatches()).toEqual([{ peer: 'bottwo', theirs: 'deadbeef', mine }]);
  });

  it('a peer with no hello yet is not a mismatch', () => {
    const { hello } = make('botone');
    expect(hello.mismatchedIn(['bottwo'])).toEqual([]);
  });

  it('a later matching hello clears the mismatch', () => {
    const { hello, mine } = make('botone');
    hello.onIm('bottwo', helloLine(2, 'deadbeef'));
    hello.onIm('bottwo', helloLine(2, mine));
    expect(hello.mismatchedIn(['bottwo'])).toEqual([]);
  });

  it('drops every other IM from a roster bot silently', () => {
    const { hello, send } = make('botone');
    expect(hello.onIm('bottwo', 'hey, can you do this for me?')).toBe('handled');
    expect(hello.onIm('bottwo', '#oc hello r=2 h=nothex!!')).toBe('handled');
    expect(hello.hashOf('bottwo')).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });

  it('a hello from a non-roster name sets a claim and nothing else', () => {
    const { hello, send } = make('botone');
    expect(hello.onIm('mallory', helloLine(1, 'deadbeef'))).toBe('handled');
    expect(hello.claims()).toEqual(['mallory']);
    expect(hello.onIm('mallory', 'hi there')).toBe('pass');
    expect(send).not.toHaveBeenCalled();
  });

  it('people always pass', () => {
    const { hello } = make('botone');
    expect(hello.onIm('alice', helloLine(1, 'deadbeef'))).toBe('pass');
    expect(hello.onIm('bob', 'hello')).toBe('pass');
    expect(hello.claims()).toEqual([]);
  });

  it('a changed hash is pushed to every peer seen, whatever the name order', () => {
    const { hello, send, state } = make('bottwo');
    hello.onPeerSeen('botone');
    hello.onPeerSeen('botthree');
    hello.checkHash();
    send.mockClear();
    state.policy = policyFixture({ chain: chainConfig({ roster: [...chainConfig().roster].reverse() }) });
    hello.checkHash();
    expect(send.mock.calls.map((c) => c[0]).sort()).toEqual(['botone', 'botthree']);
    expect(send.mock.calls[0]?.[1]).toBe(helloLine(2, rosterHash(state.policy.chain)));
    hello.checkHash();
    expect(send).toHaveBeenCalledTimes(2);
  });
});
