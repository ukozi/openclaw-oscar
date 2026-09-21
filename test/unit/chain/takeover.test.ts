import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Takeover, parseTook, tookLine } from '../../../src/chain/takeover.js';
import { ROOM } from './fixtures.js';

const ORDER = ['botone', 'bottwo', 'botthree'];
const KEY = 'alice:4d';

function make() {
  const whisper = vi.fn();
  const takeover = new Takeover({ takeoverMs: () => 10_000, whisper });
  return { takeover, whisper };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('took lines', () => {
  it('round-trips', () => {
    expect(tookLine(KEY)).toBe('#oc took alice:4d');
    expect(parseTook('#oc took alice:4d')).toBe(KEY);
  });
  it.each(['#oc took', '#oc took a b', 'oc took alice:4d', '#oc hello r=1 h=00000000', ' #oc took alice:4d'])('rejects %j', (text) => {
    expect(parseTook(text)).toBeNull();
  });
});

describe('Takeover', () => {
  it('the acting bot whispers took to the next candidate', () => {
    const { takeover, whisper } = make();
    takeover.claimed(ROOM, KEY, ORDER);
    expect(whisper).toHaveBeenCalledWith(ROOM, 'bottwo', '#oc took alice:4d');
    takeover.claimed(ROOM, KEY, ['botone']);
    expect(whisper).toHaveBeenCalledTimes(1);
  });

  it('position 1 takes the command after takeoverMs', () => {
    const { takeover } = make();
    const onTake = vi.fn();
    takeover.standby(ROOM, KEY, ORDER, 1, onTake);
    vi.advanceTimersByTime(9_999);
    expect(onTake).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onTake).toHaveBeenCalledTimes(1);
    expect(takeover.pending()).toBe(0);
  });

  it('position 2 waits twice as long', () => {
    const { takeover } = make();
    const onTake = vi.fn();
    takeover.standby(ROOM, KEY, ORDER, 2, onTake);
    vi.advanceTimersByTime(19_999);
    expect(onTake).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onTake).toHaveBeenCalledTimes(1);
  });

  it('a took cancels the standby and is relayed one hop', () => {
    const { takeover, whisper } = make();
    const onTake = vi.fn();
    takeover.standby(ROOM, KEY, ORDER, 1, onTake);
    takeover.onTook(ROOM, KEY);
    vi.advanceTimersByTime(60_000);
    expect(onTake).not.toHaveBeenCalled();
    expect(whisper).toHaveBeenCalledTimes(1);
    expect(whisper).toHaveBeenCalledWith(ROOM, 'botthree', '#oc took alice:4d');
  });

  it('the last candidate has nobody to relay to', () => {
    const { takeover, whisper } = make();
    takeover.standby(ROOM, KEY, ORDER, 2, vi.fn());
    takeover.onTook(ROOM, KEY);
    expect(whisper).not.toHaveBeenCalled();
  });

  it('took that arrives before the command cancels the later standby', () => {
    const { takeover, whisper } = make();
    const onTake = vi.fn();
    takeover.onTook(ROOM, KEY);
    takeover.standby(ROOM, KEY, ORDER, 1, onTake);
    vi.advanceTimersByTime(60_000);
    expect(onTake).not.toHaveBeenCalled();
    expect(takeover.pending()).toBe(0);
    expect(whisper).toHaveBeenCalledWith(ROOM, 'botthree', '#oc took alice:4d');
  });

  it('an early took is forgotten after a minute', () => {
    const { takeover } = make();
    const onTake = vi.fn();
    takeover.onTook(ROOM, KEY);
    vi.advanceTimersByTime(61_000);
    takeover.standby(ROOM, KEY, ORDER, 1, onTake);
    vi.advanceTimersByTime(10_000);
    expect(onTake).toHaveBeenCalledTimes(1);
  });

  it('a public line from a candidate above cancels; others do not', () => {
    const { takeover } = make();
    const onTake = vi.fn();
    takeover.standby(ROOM, KEY, ORDER, 1, onTake);
    takeover.onPublicLine(ROOM, 'botthree');
    takeover.onPublicLine(ROOM, 'alice');
    takeover.onPublicLine({ exchange: 4, name: 'otherroom' }, 'botone');
    expect(takeover.pending()).toBe(1);
    takeover.onPublicLine(ROOM, 'botone');
    expect(takeover.pending()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(onTake).not.toHaveBeenCalled();
  });

  it('a took that arrives after a public line stood the bot down is still relayed, once', () => {
    const { takeover, whisper } = make();
    const onTake = vi.fn();
    takeover.standby(ROOM, KEY, ORDER, 1, onTake);
    takeover.onPublicLine(ROOM, 'botone');
    expect(takeover.pending()).toBe(0);
    takeover.onTook(ROOM, KEY);
    takeover.onTook(ROOM, KEY);
    expect(whisper).toHaveBeenCalledTimes(1);
    expect(whisper).toHaveBeenCalledWith(ROOM, 'botthree', '#oc took alice:4d');
    vi.advanceTimersByTime(60_000);
    expect(onTake).not.toHaveBeenCalled();
  });

  it('a late took after this bot took the line over is not relayed again', () => {
    const { takeover, whisper } = make();
    takeover.standby(ROOM, KEY, ORDER, 1, vi.fn());
    vi.advanceTimersByTime(10_000);
    takeover.onTook(ROOM, KEY);
    expect(whisper).not.toHaveBeenCalled();
  });

  it('a second standby for the same key is ignored', () => {
    const { takeover } = make();
    const first = vi.fn();
    const second = vi.fn();
    takeover.standby(ROOM, KEY, ORDER, 1, first);
    takeover.standby(ROOM, KEY, ORDER, 1, second);
    vi.advanceTimersByTime(10_000);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it('clear cancels every timer', () => {
    const { takeover } = make();
    const onTake = vi.fn();
    takeover.standby(ROOM, KEY, ORDER, 1, onTake);
    takeover.clear();
    vi.advanceTimersByTime(60_000);
    expect(onTake).not.toHaveBeenCalled();
  });
});
