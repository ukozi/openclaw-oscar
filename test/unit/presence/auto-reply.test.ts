import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AwayConfig } from '../../../src/config.js';
import { createAutoReplier } from '../../../src/presence/auto-reply.js';
import { createRunTracker } from '../../../src/presence/runs.js';
import { quietLog } from '../../fake/stub-session.js';

const IM = 'agent:main:oscar:group:botone/bob';
const BOT = 'agent:main:oscar:group:botone/bottwo';
const ROOM = 'agent:main:oscar:group:botone#4.testroom';
const DEFAULT = 'Working on something. Back in a bit.';
const MINUTE = 60_000;

function harness(patch: Partial<AwayConfig> = {}) {
  const cfg: AwayConfig = {
    enabled: true, message: DEFAULT, blurb: 'agent', graceMs: 2000, maxLength: 100, replyCooldownMinutes: 10, ...patch,
  };
  const tracker = createRunTracker();
  tracker.bind(IM, 'botone', 'approved');
  tracker.bind(BOT, 'botone', 'bot');
  tracker.bind(ROOM, 'botone', 'approved');
  const sent: { to: string; text: string }[] = [];
  const replied = new Map<string, number>();
  const peers: Record<string, string | null> = { [IM]: 'bob', [BOT]: 'bottwo', [ROOM]: null };
  let line: string | null = null;
  let fail = false;
  const replier = createAutoReplier({
    accountId: 'botone',
    tracker,
    away: { current: () => line },
    config: () => cfg,
    peerFor: (key) => peers[key] ?? null,
    repliedAt: (peer) => replied.get(peer),
    send: async (to, text) => {
      if (fail) throw new Error('not-online');
      sent.push({ to, text });
    },
    log: quietLog,
  });
  return {
    cfg, tracker, sent, replied, replier,
    show: (text: string | null) => { line = text; },
    breakSend: () => { fail = true; },
  };
}

describe('away auto-reply', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends the away line once the run outlasts the grace period', async () => {
    const h = harness();
    h.show('Working in some files');
    h.tracker.seen('r1', IM);
    await vi.advanceTimersByTimeAsync(1999);
    expect(h.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await h.replier.idle();
    expect(h.sent).toEqual([{ to: 'bob', text: 'Working in some files' }]);
  });

  it('falls back to the configured message when no line is up yet', async () => {
    const h = harness();
    h.tracker.seen('r1', IM);
    await vi.advanceTimersByTimeAsync(2000);
    await h.replier.idle();
    expect(h.sent).toEqual([{ to: 'bob', text: DEFAULT }]);
  });

  it('sends nothing when the run ends inside the grace period', async () => {
    const h = harness();
    h.tracker.seen('r1', IM);
    await vi.advanceTimersByTimeAsync(1000);
    h.tracker.ended('r1');
    await vi.advanceTimersByTimeAsync(5000);
    await h.replier.idle();
    expect(h.sent).toEqual([]);
  });

  it('sends nothing to a roster bot', async () => {
    const h = harness();
    h.tracker.seen('r1', BOT);
    await vi.advanceTimersByTimeAsync(5000);
    await h.replier.idle();
    expect(h.sent).toEqual([]);
  });

  it('sends nothing for a room turn', async () => {
    const h = harness();
    h.tracker.seen('r1', ROOM);
    await vi.advanceTimersByTimeAsync(5000);
    await h.replier.idle();
    expect(h.sent).toEqual([]);
  });

  it('sends nothing when the away feature is off', async () => {
    const h = harness({ enabled: false });
    h.tracker.seen('r1', IM);
    await vi.advanceTimersByTimeAsync(5000);
    await h.replier.idle();
    expect(h.sent).toEqual([]);
  });

  it('sends nothing when the run already answered that person', async () => {
    const h = harness();
    h.tracker.seen('r1', IM);
    await vi.advanceTimersByTimeAsync(500);
    h.replied.set('bob', Date.now());
    await vi.advanceTimersByTimeAsync(1500);
    await h.replier.idle();
    expect(h.sent).toEqual([]);
  });

  it('still answers when the only reply to that person was before this run', async () => {
    const h = harness();
    h.replied.set('bob', Date.now());
    await vi.advanceTimersByTimeAsync(1);
    h.tracker.seen('r1', IM);
    await vi.advanceTimersByTimeAsync(2000);
    await h.replier.idle();
    expect(h.sent).toHaveLength(1);
  });

  it('sends one line per person per cooldown', async () => {
    const h = harness();
    h.tracker.seen('r1', IM);
    await vi.advanceTimersByTimeAsync(2000);
    await h.replier.idle();
    h.tracker.ended('r1');
    await vi.advanceTimersByTimeAsync(MINUTE);
    h.tracker.seen('r2', IM);
    await vi.advanceTimersByTimeAsync(2000);
    await h.replier.idle();
    expect(h.sent).toHaveLength(1);
  });

  it('sends again once the cooldown is up', async () => {
    const h = harness();
    h.tracker.seen('r1', IM);
    await vi.advanceTimersByTimeAsync(2000);
    await h.replier.idle();
    h.tracker.ended('r1');
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    h.tracker.seen('r2', IM);
    await vi.advanceTimersByTimeAsync(2000);
    await h.replier.idle();
    expect(h.sent).toHaveLength(2);
  });

  it('keeps the cooldown when the send fails', async () => {
    const h = harness();
    h.breakSend();
    h.tracker.seen('r1', IM);
    await vi.advanceTimersByTimeAsync(2000);
    await h.replier.idle();
    h.tracker.ended('r1');
    await vi.advanceTimersByTimeAsync(MINUTE);
    h.tracker.seen('r2', IM);
    await vi.advanceTimersByTimeAsync(2000);
    await h.replier.idle();
    expect(h.sent).toEqual([]);
  });

  it('stops without dropping a send in flight and answers nothing after that', async () => {
    const h = harness();
    h.tracker.seen('r1', IM);
    await vi.advanceTimersByTimeAsync(2000);
    h.replier.stop();
    await h.replier.idle();
    expect(h.sent).toHaveLength(1);
    h.tracker.seen('r2', IM);
    await vi.advanceTimersByTimeAsync(5000);
    await h.replier.idle();
    expect(h.sent).toHaveLength(1);
  });
});
