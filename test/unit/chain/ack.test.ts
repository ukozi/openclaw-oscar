import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AckTimers } from '../../../src/chain/ack.js';

const R = 'room:4:testroom';

function make(active = true) {
  const post = vi.fn();
  const state = { active };
  const ack = new AckTimers({ ackAfterMs: () => 8000, isActive: () => state.active, post });
  return { ack, post, state };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('AckTimers', () => {
  it('posts at ackAfterMs when a tool call has started', () => {
    const { ack, post } = make();
    ack.wakeStarted(R, 'k1', false);
    ack.toolStarted(R);
    vi.advanceTimersByTime(7999);
    expect(post).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(post).toHaveBeenCalledWith(R, 'ack');
  });

  it('a tool call after ackAfterMs posts at once', () => {
    const { ack, post } = make();
    ack.wakeStarted(R, 'k1', false);
    vi.advanceTimersByTime(9000);
    expect(post).not.toHaveBeenCalled();
    ack.toolStarted(R);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('no tool call waits for 3x', () => {
    const { ack, post } = make();
    ack.wakeStarted(R, 'k1', false);
    vi.advanceTimersByTime(23_999);
    expect(post).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('output before the timer means no ack', () => {
    const { ack, post } = make();
    ack.wakeStarted(R, 'k1', false);
    ack.toolStarted(R);
    vi.advanceTimersByTime(5000);
    ack.output(R);
    vi.advanceTimersByTime(60_000);
    expect(post).not.toHaveBeenCalled();
    expect(ack.runEnded(R)).toEqual({ acked: false, output: true });
  });

  it('ended run gets no ack', () => {
    const { ack, post, state } = make();
    ack.wakeStarted(R, 'k1', false);
    ack.toolStarted(R);
    state.active = false;
    vi.advanceTimersByTime(60_000);
    expect(post).not.toHaveBeenCalled();
  });

  it('one line covers several messages', () => {
    const { ack, post } = make();
    ack.wakeStarted(R, 'k1', false);
    ack.toolStarted(R);
    vi.advanceTimersByTime(4000);
    ack.wakeStarted(R, 'k2', false);
    vi.advanceTimersByTime(60_000);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('a message that arrives after the ack gets its own', () => {
    const { ack, post } = make();
    ack.wakeStarted(R, 'k1', false);
    ack.toolStarted(R);
    vi.advanceTimersByTime(8000);
    ack.wakeStarted(R, 'k2', true);
    vi.advanceTimersByTime(8000);
    expect(post.mock.calls).toEqual([[R, 'ack'], [R, 'busy']]);
  });

  it('reports a silent run that was acked', () => {
    const { ack } = make();
    ack.wakeStarted(R, 'k1', false);
    ack.toolStarted(R);
    vi.advanceTimersByTime(8000);
    expect(ack.runEnded(R)).toEqual({ acked: true, output: false });
    expect(ack.runEnded(R)).toEqual({ acked: false, output: false });
  });

  it('runEnded cancels what is pending', () => {
    const { ack, post } = make();
    ack.wakeStarted(R, 'k1', false);
    ack.toolStarted(R);
    ack.runEnded(R);
    vi.advanceTimersByTime(60_000);
    expect(post).not.toHaveBeenCalled();
  });

  it('rooms are independent and a tool start with no wake is ignored', () => {
    const { ack, post } = make();
    ack.toolStarted('room:4:other');
    ack.wakeStarted(R, 'k1', false);
    ack.output('room:4:other');
    vi.advanceTimersByTime(24_000);
    expect(post).toHaveBeenCalledWith(R, 'ack');
  });
});
