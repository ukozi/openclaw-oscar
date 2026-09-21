import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('openclaw/plugin-sdk/channel-outbound', async () => (await import('../fake/openclaw.js')).channelOutbound);
vi.mock('openclaw/plugin-sdk/routing', async () => (await import('../fake/openclaw.js')).routing);
vi.mock('openclaw/plugin-sdk/reply-chunking', async () => (await import('../fake/openclaw.js')).replyChunking);
vi.mock('openclaw/plugin-sdk/channel-reply-pipeline', async () => (await import('../fake/openclaw.js')).channelReplyPipeline);

import { NOTICE_TIMING, createNotices, sendNotice } from '../../src/notice.js';
import type { ContactAttempt } from '../../src/notice.js';
import { sendAdapterText } from '../../src/outbound.js';
import { resetRuntimeForTests, setRuntime } from '../../src/runtime.js';
import { sdk } from '../fake/openclaw.js';
import { FakeSession } from '../fake/session.js';

type Sent = { owner: string; text: string };
const log = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
const HOUR = 3600_000;

function setup(sec: Record<string, unknown> = {}, host: Record<string, unknown> = {}) {
  const sent: Sent[] = [];
  const online = new Set<string>(['alice']);
  let cfg: unknown = { ...host, channels: { oscar: { owners: ['alice'], allowFrom: ['bob'], ...sec } } };
  const notices = createNotices({
    self: () => 'botone', getCfg: () => cfg, now: () => Date.now(), timers: { setTimeout, clearTimeout }, log,
    presenceOf: (name) => (online.has(name) ? { online: true, away: false, bot: false, at: 0 } : undefined),
    send: async (p) => { sent.push(p); },
  });
  const attempt = (name: string, kind: ContactAttempt['kind'] = 'im'): ContactAttempt => ({ name, display: name, kind, at: Date.now() });
  return { sent, online, notices, attempt, setCfg: (next: unknown) => { cfg = next; } };
}

beforeEach(() => {
  sdk.reset();
  vi.useFakeTimers();
  vi.setSystemTime(10 * HOUR);
  NOTICE_TIMING.windowMs = HOUR;
});
afterEach(() => vi.useRealTimers());

describe('notice text', () => {
  it('is the fixed line plus the config hint', async () => {
    const t = setup();
    t.notices.contact(t.attempt('mallory'));
    await t.notices.idle();
    expect(t.sent).toEqual([{ owner: 'alice', text: 'mallory tried to message me. I did not reply.\nTo let them in, add mallory to channels.oscar.allowFrom.' }]);
  });

  it('offers the chat command when the host allows config commands', async () => {
    const t = setup({}, { commands: { config: true } });
    t.notices.contact(t.attempt('mallory'));
    await t.notices.idle();
    expect(t.sent[0]?.text).toBe('mallory tried to message me. I did not reply.\nTo let them in, reply: /allowlist add dm mallory');
  });

  it('uses invite wording', async () => {
    const t = setup();
    t.notices.contact(t.attempt('mallory', 'invite'));
    await t.notices.idle();
    expect(t.sent[0]?.text.split('\n')[0]).toBe('mallory invited me to a chat. I did not join.');
  });

  it('flags an odd name and offers no way to approve it', async () => {
    const t = setup();
    t.notices.contact(t.attempt('аlice'));
    await t.notices.idle();
    expect(t.sent[0]?.text).toBe('аlice tried to message me. I did not reply.\nThat name contains unusual letters.');
  });
});

describe('throttle', () => {
  it('sends one notice per stranger per cooldown', async () => {
    const t = setup();
    t.notices.contact(t.attempt('mallory'));
    t.notices.contact(t.attempt('mallory'));
    vi.setSystemTime(10 * HOUR + 6 * HOUR - 1);
    t.notices.contact(t.attempt('Mallory'));
    await t.notices.idle();
    expect(t.sent).toHaveLength(1);
    vi.setSystemTime(10 * HOUR + 6 * HOUR);
    t.notices.contact(t.attempt('mallory'));
    await t.notices.idle();
    expect(t.sent).toHaveLength(2);
  });

  it('rolls the sixth stranger of an hour into one line at the end of the hour', async () => {
    const t = setup();
    for (const name of ['s1', 's2', 's3', 's4', 's5', 's6', 's7']) t.notices.contact(t.attempt(name));
    await t.notices.idle();
    expect(t.sent).toHaveLength(5);
    await vi.advanceTimersByTimeAsync(HOUR);
    await t.notices.idle();
    expect(t.sent).toHaveLength(6);
    expect(t.sent[5]).toEqual({ owner: 'alice', text: '2 more people tried to reach me this hour. I did not reply to any of them.' });
    t.notices.contact(t.attempt('s8'));
    await t.notices.idle();
    expect(t.sent).toHaveLength(7);
  });

  it('counts the cap in IMs, so two owners halve it', async () => {
    const t = setup({ owners: ['alice', 'carol'] });
    t.online.add('carol');
    for (const name of ['s1', 's2', 's3']) t.notices.contact(t.attempt(name));
    await t.notices.idle();
    expect(t.sent.map((s) => s.owner)).toEqual(['alice', 'carol', 'alice', 'carol']);
    await vi.advanceTimersByTimeAsync(HOUR);
    await t.notices.idle();
    expect(t.sent.slice(4).map((s) => s.text)).toEqual([
      '1 more person tried to reach me this hour. I did not reply to them.',
      '1 more person tried to reach me this hour. I did not reply to them.',
    ]);
  });

  it('offline owner gets one stored notice then a count on return', async () => {
    const t = setup();
    t.online.delete('alice');
    for (const name of ['s1', 's2', 's3', 's4', 's5', 's6']) t.notices.contact(t.attempt(name));
    await t.notices.idle();
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]?.text.startsWith('s1 tried to message me.')).toBe(true);
    await vi.advanceTimersByTimeAsync(HOUR);
    await t.notices.idle();
    expect(t.sent).toHaveLength(1);
    t.online.add('alice');
    t.notices.ownerPresence('alice', true);
    await t.notices.idle();
    expect(t.sent[1]).toEqual({ owner: 'alice', text: '5 more people tried to reach me this hour. I did not reply to any of them.' });
    t.online.delete('alice');
    t.notices.ownerPresence('alice', false);
    vi.setSystemTime(12 * HOUR);
    t.notices.contact(t.attempt('s9'));
    await t.notices.idle();
    expect(t.sent).toHaveLength(3);
  });

  it('ignores presence of people who are not owners and sends nothing without owners', async () => {
    const t = setup({ owners: [] });
    t.notices.ownerPresence('bob', true);
    t.notices.contact(t.attempt('mallory'));
    await t.notices.idle();
    expect(t.sent).toEqual([]);
    expect(t.notices.ring()).toHaveLength(1);
  });

  it('never notifies the bot itself', async () => {
    const t = setup({ owners: ['botone'] });
    t.notices.contact(t.attempt('mallory'));
    await t.notices.idle();
    expect(t.sent).toEqual([]);
  });

  it('reads owners from live config', async () => {
    const t = setup();
    t.setCfg({ channels: { oscar: { owners: ['carol'] } } });
    t.online.add('carol');
    t.notices.contact(t.attempt('mallory'));
    await t.notices.idle();
    expect(t.sent.map((s) => s.owner)).toEqual(['carol']);
  });

  it('keeps going when a send fails', async () => {
    const sent: string[] = [];
    let first = true;
    const notices = createNotices({
      self: () => 'botone', getCfg: () => ({ channels: { oscar: { owners: ['alice'] } } }), now: () => Date.now(),
      timers: { setTimeout, clearTimeout }, log, presenceOf: () => ({ online: true, away: false, bot: false, at: 0 }),
      send: async (p) => { if (first) { first = false; throw new Error('closed'); } sent.push(p.text); },
    });
    notices.contact({ name: 's1', display: 's1', kind: 'im', at: 0 });
    notices.contact({ name: 's2', display: 's2', kind: 'im', at: 0 });
    await notices.idle();
    expect(sent).toHaveLength(1);
  });
});

describe('replay', () => {
  it('turns every stranger in the offline queue into one notice', async () => {
    const t = setup();
    t.notices.replayed([t.attempt('s1'), t.attempt('s2'), t.attempt('s1'), t.attempt('s3')]);
    await t.notices.idle();
    expect(t.sent).toEqual([{
      owner: 'alice',
      text: 's1 tried to message me. I did not reply.\nTo let them in, add s1 to channels.oscar.allowFrom.\n2 more people tried to reach me this hour. I did not reply to any of them.',
    }]);
    t.notices.contact(t.attempt('s2'));
    await t.notices.idle();
    expect(t.sent).toHaveLength(1);
  });
});

describe('ring', () => {
  it('keeps the last 20 and folds repeats', () => {
    const t = setup();
    for (let i = 0; i < 25; i += 1) t.notices.contact(t.attempt(`s${i}`));
    t.notices.contact(t.attempt('s24'));
    const ring = t.notices.ring();
    expect(ring).toHaveLength(20);
    expect(ring[0]?.name).toBe('s5');
    expect(ring[19]).toMatchObject({ name: 's24', count: 2, oddName: false, kind: 'im' });
  });
});

describe('sendNotice', () => {
  it('uses the durable batch with a mirror into the owner session at notice priority', async () => {
    resetRuntimeForTests();
    const session = new FakeSession();
    setRuntime({ accountId: 'botone', session: session.asSession(), rooms: new Map(), sessionKeys: new Map(), lastReplyAt: new Map(), counters: { droppedSends: 0, eventGaps: 0 } });
    sdk.usePlugin({ outbound: { sendText: (ctx: { cfg: unknown; to: string; text: string; accountId?: string | null }) => sendAdapterText(ctx) } });
    const cfg = { channels: { oscar: { owners: ['alice'], accounts: { botone: { screenName: 'botone' } } } } };
    await sendNotice({ cfg, accountId: 'botone', bot: 'botone', owner: 'alice', text: 'x' });
    expect(sdk.durable[0]?.params).toMatchObject({
      channel: 'oscar', to: 'alice', accountId: 'botone', payloads: [{ text: 'x' }], bestEffort: true, durability: 'best_effort',
      mirror: { sessionKey: 'agent:main:oscar:group:botone/alice', agentId: 'main', text: 'x' },
    });
    expect(sdk.routes[0]).toMatchObject({ peer: { kind: 'group', id: 'botone/alice' } });
    expect(session.sent).toEqual([{ to: 'alice', html: 'x', priority: 'notice' }]);
  });

  it('throws when the batch fails', async () => {
    sdk.usePlugin({ outbound: { sendText: async () => { throw new Error('closed'); } } });
    await expect(sendNotice({ cfg: {}, accountId: 'botone', bot: 'botone', owner: 'alice', text: 'x' })).rejects.toThrow('closed');
  });
});
