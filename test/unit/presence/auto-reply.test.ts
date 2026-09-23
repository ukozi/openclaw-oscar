import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AwayConfig } from '../../../src/config.js';
import { createAutoReplier } from '../../../src/presence/auto-reply.js';
import { createAwayController } from '../../../src/presence/away.js';
import { createRunTracker } from '../../../src/presence/runs.js';
import { quietLog, stubSession } from '../../fake/stub-session.js';

const IM = 'agent:main:oscar:group:botone/bob';
const DEFAULT = 'Working on something. Back in a bit.';
const MINUTE = 60_000;

function harness(patch: Partial<AwayConfig> = {}) {
  const cfg: AwayConfig = {
    enabled: true, message: DEFAULT, blurb: 'agent', graceMs: 2000, maxLength: 100, replyCooldownMinutes: 10, ...patch,
  };
  const tracker = createRunTracker();
  tracker.bind(IM, 'botone', 'approved');
  const stub = stubSession();
  const away = createAwayController({
    accountId: 'botone', tracker, session: stub.session, config: () => cfg, forbidden: () => ['bob'], log: quietLog,
  });
  const sent: { to: string; text: string }[] = [];
  const replied = new Map<string, number>();
  let fail = false;
  const replier = createAutoReplier({
    accountId: 'botone',
    tracker,
    away,
    config: () => cfg,
    repliedAt: (peer) => replied.get(peer),
    send: async (to, text) => {
      if (fail) throw new Error('not-online');
      sent.push({ to, text });
    },
    log: quietLog,
  });
  const settle = async (ms = 0) => {
    await vi.advanceTimersByTimeAsync(ms);
    await replier.idle();
  };
  return {
    cfg, tracker, away, stub, sent, replied, replier, settle,
    breakSend: () => { fail = true; },
  };
}

describe('away auto-reply', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends nothing to the person whose question is still being worked on', async () => {
    const h = harness();
    h.tracker.seen('r1', IM);
    await h.settle(10_000);
    expect(h.stub.calls).toEqual([DEFAULT]);
    expect(h.sent).toEqual([]);
  });

  it('answers someone who writes while the away line is up', async () => {
    const h = harness();
    h.tracker.seen('r1', IM);
    h.away.offerLine('r1', 'Working through a stack of notes');
    await h.settle(2000);
    h.replier.contacted('carol');
    await h.settle();
    expect(h.sent).toEqual([{ to: 'carol', text: 'Working through a stack of notes' }]);
  });

  it('answers a follow-up from the person who asked once the away line goes up', async () => {
    const h = harness();
    h.tracker.seen('r1', IM);
    await h.settle(500);
    h.replier.contacted('bob');
    await h.settle(1499);
    expect(h.sent).toEqual([]);
    await h.settle(1);
    expect(h.sent).toEqual([{ to: 'bob', text: DEFAULT }]);
  });

  it('sends nothing when the work ends before the away line goes up', async () => {
    const h = harness();
    h.tracker.seen('r1', IM);
    h.replier.contacted('carol');
    await h.settle(1000);
    h.tracker.ended('r1');
    await h.settle(5000);
    expect(h.sent).toEqual([]);
  });

  it('sends nothing to someone who writes while nothing is running', async () => {
    const h = harness();
    h.replier.contacted('carol');
    await h.settle(5000);
    h.tracker.seen('r1', IM);
    await h.settle(5000);
    expect(h.sent).toEqual([]);
  });

  it('sends nothing when the away feature is off', async () => {
    const h = harness({ enabled: false });
    h.tracker.seen('r1', IM);
    h.replier.contacted('carol');
    await h.settle(5000);
    expect(h.sent).toEqual([]);
  });

  it('sends nothing when that person got a real reply before the line went up', async () => {
    const h = harness();
    h.tracker.seen('r1', IM);
    h.replier.contacted('carol');
    await h.settle(500);
    h.replied.set('carol', Date.now());
    await h.settle(1500);
    expect(h.sent).toEqual([]);
  });

  it('sends one line per person per cooldown', async () => {
    const h = harness();
    h.tracker.seen('r1', IM);
    await h.settle(2000);
    h.replier.contacted('carol');
    h.replier.contacted('carol');
    await h.settle();
    h.tracker.ended('r1');
    await h.settle(MINUTE);
    h.tracker.seen('r2', IM);
    await h.settle(2000);
    h.replier.contacted('carol');
    await h.settle();
    expect(h.sent).toHaveLength(1);
  });

  it('sends again once the cooldown is up', async () => {
    const h = harness();
    h.tracker.seen('r1', IM);
    await h.settle(2000);
    h.replier.contacted('carol');
    await h.settle();
    h.tracker.ended('r1');
    await h.settle(10 * MINUTE);
    h.tracker.seen('r2', IM);
    await h.settle(2000);
    h.replier.contacted('carol');
    await h.settle();
    expect(h.sent).toHaveLength(2);
  });

  it('keeps the cooldown when the send fails', async () => {
    const h = harness();
    h.breakSend();
    h.tracker.seen('r1', IM);
    await h.settle(2000);
    h.replier.contacted('carol');
    await h.settle();
    h.replier.contacted('carol');
    await h.settle();
    expect(h.sent).toEqual([]);
  });

  it('stops without dropping a send in flight and answers nothing after that', async () => {
    const h = harness();
    h.tracker.seen('r1', IM);
    await h.settle(2000);
    h.replier.contacted('carol');
    h.replier.stop();
    await h.settle();
    expect(h.sent).toHaveLength(1);
    h.replier.contacted('dave');
    await h.settle(5000);
    expect(h.sent).toHaveLength(1);
  });
});
