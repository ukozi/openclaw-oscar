import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AwayConfig } from '../../../src/config.js';
import { awayToolHints, createAwayController, rosterPresence } from '../../../src/presence/away.js';
import { createRunTracker } from '../../../src/presence/runs.js';
import { quietLog, stubSession } from '../../fake/stub-session.js';

const IM = 'agent:main:oscar:group:botone/alice';
const ROOM = 'agent:main:oscar:group:botone#4.testroom';
const DEFAULT = 'Working on something. Back in a bit.';

function setup(overrides: Partial<AwayConfig> = {}, summarize?: (text: string, signal: AbortSignal) => Promise<string>) {
  const cfg: AwayConfig = { enabled: true, message: DEFAULT, blurb: 'agent', graceMs: 2000, maxLength: 100, replyCooldownMinutes: 10, ...overrides };
  const tracker = createRunTracker();
  tracker.bind(IM, 'botone', 'owner');
  tracker.bind(ROOM, 'botone', 'owner');
  const stub = stubSession();
  const away = createAwayController({
    accountId: 'botone', tracker, session: stub.session, config: () => cfg,
    forbidden: () => ['alice', 'bob', 'bottwo'], summarize, log: quietLog,
  });
  return { cfg, tracker, stub, away };
}

async function tick(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('away controller', () => {
  it('waits for the grace period, then sets the default line', async () => {
    const { tracker, stub } = setup();
    tracker.seen('r1', IM);
    await tick(1999);
    expect(stub.calls).toEqual([]);
    await tick(1);
    expect(stub.calls).toEqual([DEFAULT]);
  });

  it('never goes away for a run shorter than the grace period', async () => {
    const { tracker, stub } = setup();
    tracker.seen('r1', IM);
    await tick(1500);
    tracker.ended('r1');
    await tick(10_000);
    expect(stub.calls).toEqual([]);
  });

  it('does not restart the grace period on a repeated start', async () => {
    const { tracker, stub } = setup();
    tracker.seen('r1', IM);
    await tick(1500);
    tracker.seen('r1', IM);
    await tick(500);
    expect(stub.calls).toEqual([DEFAULT]);
  });

  it('clears as soon as the last run ends', async () => {
    const { tracker, stub, away } = setup();
    tracker.seen('r1', IM);
    tracker.seen('r2', ROOM);
    await tick(2000);
    tracker.ended('r1');
    await tick(0);
    expect(stub.calls).toEqual([DEFAULT]);
    tracker.ended('r2');
    await tick(0);
    expect(stub.calls).toEqual([DEFAULT, null]);
    expect(away.current()).toBeNull();
  });

  it('prefers the agent line, then the tool phrase, then the default', async () => {
    const { tracker, stub, away } = setup({}, undefined);
    tracker.seen('r1', IM);
    await tick(2000);
    away.noteTool('r1', 'exec');
    await tick(5000);
    expect(away.offerLine('r1', 'Tidying up a report')).toEqual({ accepted: true, shown: 'Tidying up a report' });
    await tick(5000);
    away.noteTool('r1', 'read');
    await tick(5000);
    expect(stub.calls).toEqual([DEFAULT, 'Running some commands', 'Tidying up a report']);
  });

  it('uses what is known by the end of the grace period', async () => {
    const { tracker, stub, away } = setup();
    tracker.seen('r1', IM);
    away.noteTool('r1', 'web_search');
    away.offerLine('r1', 'Reading up on something');
    await tick(1999);
    expect(stub.calls).toEqual([]);
    await tick(1);
    expect(stub.calls).toEqual(['Reading up on something']);
  });

  it('spaces wire updates and sends only the latest text', async () => {
    const { tracker, stub, away } = setup();
    tracker.seen('r1', IM);
    await tick(2000);
    away.noteTool('r1', 'exec');
    away.noteTool('r1', 'read');
    away.noteTool('r1', 'web_fetch');
    await tick(4999);
    expect(stub.calls).toEqual([DEFAULT]);
    await tick(1);
    expect(stub.calls).toEqual([DEFAULT, 'Looking something up']);
  });

  it('keeps the phrase when the agent line looks like a path', async () => {
    const { tracker, stub, away } = setup();
    tracker.seen('r1', IM);
    away.noteTool('r1', 'exec');
    expect(away.offerLine('r1', 'Editing /home/alice/notes.txt')).toEqual({ accepted: false, reason: 'unsafe' });
    await tick(2000);
    expect(stub.calls).toEqual(['Running some commands']);
  });

  it('rejects a line naming an owner', () => {
    const { tracker, away } = setup();
    tracker.seen('r1', IM);
    expect(away.offerLine('r1', 'Helping Alice')).toEqual({ accepted: false, reason: 'unsafe' });
  });

  it('allows two line changes per run', () => {
    const { tracker, away } = setup();
    tracker.seen('r1', IM);
    expect(away.offerLine('r1', 'First thing').accepted).toBe(true);
    expect(away.offerLine('r1', 'Editing /tmp/x').accepted).toBe(false);
    expect(away.offerLine('r1', 'Second thing').accepted).toBe(true);
    expect(away.offerLine('r1', 'Third thing', 'call-3')).toEqual({ accepted: false, reason: 'limit' });
    expect(away.verdictFor('call-3')).toEqual({ accepted: false, reason: 'limit' });
    tracker.seen('r2', IM);
    expect(away.offerLine('r2', 'Fresh run').accepted).toBe(true);
  });

  it('does not count the same line twice', () => {
    const { tracker, away } = setup();
    tracker.seen('r1', IM);
    expect(away.offerLine('r1', 'First thing').accepted).toBe(true);
    expect(away.offerLine('r1', 'First thing')).toEqual({ accepted: true, shown: 'First thing' });
    expect(away.offerLine('r1', 'Second thing').accepted).toBe(true);
    expect(away.offerLine('r1', 'Second thing')).toEqual({ accepted: true, shown: 'Second thing' });
    expect(away.offerLine('r1', 'Third thing')).toEqual({ accepted: false, reason: 'limit' });
  });

  it('refuses a line when no run is known', () => {
    const { away } = setup();
    expect(away.offerLine('nope', 'Anything')).toEqual({ accepted: false, reason: 'no-run' });
  });

  it('ignores agent lines in phrases mode', async () => {
    const { tracker, stub, away } = setup({ blurb: 'phrases' });
    tracker.seen('r1', IM);
    expect(away.offerLine('r1', 'Tidying up a report')).toEqual({ accepted: false, reason: 'off' });
    away.noteTool('r1', 'read');
    await tick(2000);
    expect(stub.calls).toEqual(['Working in some files']);
  });

  it('drops the agent line of a run that ended', async () => {
    const { tracker, stub, away } = setup();
    tracker.seen('r1', IM);
    tracker.seen('r2', ROOM);
    away.offerLine('r1', 'Tidying up a report');
    await tick(2000);
    tracker.ended('r1');
    await tick(5000);
    expect(stub.calls).toEqual(['Tidying up a report', DEFAULT]);
  });

  it('folds and caps the operator message and never sends an empty line', async () => {
    const a = setup({ message: 'Café time — back soon', maxLength: 12 });
    a.tracker.seen('r1', IM);
    await tick(2000);
    expect(a.stub.calls).toEqual(['Cafe time']);
    const b = setup({ message: '作業中' });
    b.tracker.seen('r1', IM);
    await tick(2000);
    expect(b.stub.calls).toEqual([DEFAULT]);
  });

  it('stays online when away is disabled and clears when it is switched off mid-run', async () => {
    const { cfg, tracker, stub, away } = setup();
    tracker.seen('r1', IM);
    await tick(2000);
    cfg.enabled = false;
    away.noteTool('r1', 'exec');
    await tick(0);
    expect(stub.calls).toEqual([DEFAULT, null]);
    tracker.ended('r1');
    tracker.seen('r2', IM);
    await tick(5000);
    expect(stub.calls).toEqual([DEFAULT, null]);
  });

  it('forgets everything at sign-on and sets the line again when the run shows life', async () => {
    const { tracker, stub, away } = setup();
    tracker.seen('r1', IM);
    await tick(2000);
    stub.drop();
    stub.signOn();
    await tick(0);
    expect(tracker.isBusy('botone')).toBe(false);
    expect(away.current()).toBeNull();
    expect(stub.calls).toEqual([DEFAULT]);
    tracker.toolStart('r1', 't1', 'exec', IM);
    away.noteTool('r1', 'exec');
    await tick(2000);
    expect(stub.calls).toEqual([DEFAULT, 'Running some commands']);
  });

  it('does not treat a repeated online state as a sign-on', async () => {
    const { tracker, stub, away } = setup();
    tracker.seen('r1', IM);
    await tick(2000);
    stub.signOn();
    await tick(0);
    expect(tracker.isBusy('botone')).toBe(true);
    expect(away.current()).toBe(DEFAULT);
    expect(stub.calls).toEqual([DEFAULT]);
  });

  it('keeps no message text unless summarize mode is on', async () => {
    const summarize = vi.fn(async () => 'Drafting a reply');
    const { cfg, tracker, stub, away } = setup({ blurb: 'agent' }, summarize);
    away.noteInbound(IM, 'please draft a reply');
    cfg.blurb = 'summarize';
    tracker.seen('r1', IM);
    await tick(2000);
    expect(summarize).not.toHaveBeenCalled();
    expect(stub.calls).toEqual([DEFAULT]);
  });

  it('tries again after a failed set', async () => {
    const { tracker, stub, away } = setup();
    stub.failNext(1);
    tracker.seen('r1', IM);
    await tick(2000);
    expect(stub.calls).toEqual([]);
    expect(away.current()).toBeNull();
    away.noteTool('r1', 'exec');
    await tick(0);
    expect(stub.calls).toEqual(['Running some commands']);
  });

  it('retries a failed clear while the connection is up', async () => {
    const { tracker, stub } = setup();
    tracker.seen('r1', IM);
    await tick(2000);
    stub.failNext(2);
    tracker.ended('r1');
    await tick(4999);
    expect(stub.calls).toEqual([DEFAULT]);
    await tick(5001);
    expect(stub.calls).toEqual([DEFAULT, null]);
  });

  it('does not retry a clear when a new run started', async () => {
    const { tracker, stub } = setup();
    tracker.seen('r1', IM);
    await tick(2000);
    stub.failNext(1);
    tracker.ended('r1');
    await tick(100);
    tracker.seen('r2', IM);
    await tick(10_000);
    expect(stub.calls).toEqual([DEFAULT, DEFAULT]);
  });

  it('summarizes once per run in summarize mode and filters the result', async () => {
    const summarize = vi.fn(async (text: string) => (text.includes('secret') ? 'See /etc/shadow' : 'Drafting a reply'));
    const { tracker, stub, away } = setup({ blurb: 'summarize' }, summarize);
    away.noteInbound(IM, 'please draft a reply');
    tracker.seen('r1', IM);
    tracker.seen('r1', IM);
    await tick(2000);
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(stub.calls).toEqual(['Drafting a reply']);
    tracker.ended('r1');
    away.noteInbound(IM, 'the secret one');
    tracker.seen('r2', IM);
    await tick(2000);
    expect(stub.calls).toEqual(['Drafting a reply', null, DEFAULT]);
  });

  it('does not call the summarizer in other modes', async () => {
    const summarize = vi.fn(async () => 'Drafting a reply');
    const { tracker, away } = setup({ blurb: 'agent' }, summarize);
    away.noteInbound(IM, 'please draft a reply');
    tracker.seen('r1', IM);
    await tick(2000);
    expect(summarize).not.toHaveBeenCalled();
  });

  it('aborts a slow summary when the run ends', async () => {
    let signal: AbortSignal | undefined;
    const summarize = (_text: string, s: AbortSignal) => {
      signal = s;
      return new Promise<string>(() => {});
    };
    const { tracker, away } = setup({ blurb: 'summarize' }, summarize);
    away.noteInbound(IM, 'hello');
    tracker.seen('r1', IM);
    tracker.ended('r1');
    expect(signal?.aborted).toBe(true);
  });

  it('stop clears the line and detaches', async () => {
    const { tracker, stub, away } = setup();
    tracker.seen('r1', IM);
    await tick(2000);
    await away.stop();
    expect(stub.calls).toEqual([DEFAULT, null]);
    tracker.ended('r1');
    tracker.seen('r2', IM);
    await tick(5000);
    expect(stub.calls).toEqual([DEFAULT, null]);
  });

  it('ignores other accounts', async () => {
    const { tracker, stub } = setup();
    tracker.bind('agent:two:oscar:group:bottwo/alice', 'bottwo', 'owner');
    tracker.seen('x1', 'agent:two:oscar:group:bottwo/alice');
    await tick(5000);
    expect(stub.calls).toEqual([]);
  });
});

describe('rosterPresence', () => {
  it('lists peers with their away flag and leaves self out', () => {
    const session = {
      presenceOf: (name: string) =>
        name === 'bottwo' ? { online: true, away: true, bot: true, at: 1 } : undefined,
    };
    const roster = [{ screenName: 'botone' }, { screenName: 'bottwo' }, { screenName: 'botthree' }];
    expect(rosterPresence(session, roster, 'botone')).toEqual([
      { name: 'bottwo', online: true, away: true },
      { name: 'botthree', online: false, away: false },
    ]);
  });
});

describe('awayToolHints', () => {
  const base: AwayConfig = { enabled: true, message: DEFAULT, blurb: 'agent', graceMs: 2000, maxLength: 100, replyCooldownMinutes: 10 };
  it('explains both ways to set the line', () => {
    const text = awayToolHints(base).join(' ');
    expect(text).toContain('set-presence');
    expect(text).toContain('awayMessage');
    expect(text).toContain('oscar_status');
    expect(text).toContain('No names');
  });
  it('says nothing when the agent line is off', () => {
    expect(awayToolHints({ ...base, blurb: 'phrases' })).toEqual([]);
    expect(awayToolHints({ ...base, enabled: false })).toEqual([]);
  });
});
