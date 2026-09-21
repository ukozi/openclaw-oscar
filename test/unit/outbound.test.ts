import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('openclaw/plugin-sdk/reply-chunking', async () => (await import('../fake/openclaw.js')).replyChunking);
vi.mock('openclaw/plugin-sdk/channel-reply-pipeline', async () => (await import('../fake/openclaw.js')).channelReplyPipeline);

import { toWireHtml } from '../../src/oscar/text.js';
import { checkTarget, outboundBase, sendAdapterText, sendMarkdown, sendWire, setOutboundTextFilter, typingFor, withPriority } from '../../src/outbound.js';
import type { OutboundMeta } from '../../src/outbound.js';
import { getRuntime, resetRuntimeForTests, setRuntime } from '../../src/runtime.js';
import { sdk } from '../fake/openclaw.js';
import { FakeSession } from '../fake/session.js';

const cfg = (patch: Record<string, unknown> = {}) => ({
  channels: { oscar: { host: 'h', screenName: 'botone', password: 'hunter22', owners: ['alice'], allowFrom: ['bob'], ...patch } },
});
let session: FakeSession;

beforeEach(() => {
  sdk.reset();
  resetRuntimeForTests();
  session = new FakeSession();
  setRuntime({ accountId: 'default', session: session.asSession(), rooms: new Map(), sessionKeys: new Map(), lastReplyAt: new Map(), counters: { droppedSends: 0, eventGaps: 0 } });
});

describe('target check', () => {
  it.each([
    ['mallory', 'mallory is not in owners or allowFrom'],
    ['bottwo/alice', '"bottwo/alice" is not a screen name or room this account can address'],
    ['room:4:testroom', 'not in room testroom'],
    ['', '"" is not a screen name or room this account can address'],
  ])('refuses unlisted, foreign-bot and unjoined targets: %j', async (to, message) => {
    const checked = checkTarget({ cfg: cfg(), to });
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.error.message).toBe(message);
    await expect(sendWire({ cfg: cfg(), to, html: 'x' })).rejects.toThrow(message);
    expect(outboundBase.resolveTarget({ cfg: cfg(), to })).toMatchObject({ ok: false });
    expect(session.sent).toEqual([]);
    expect(session.typing).toEqual([]);
  });

  it('accepts owners, approved people and the own peer id, and returns the canonical target', () => {
    expect(checkTarget({ cfg: cfg(), to: 'Alice' })).toMatchObject({ ok: true, to: 'alice', accountId: 'default' });
    expect(checkTarget({ cfg: cfg(), to: 'botone/bob' })).toMatchObject({ ok: true, to: 'bob' });
    expect(outboundBase.resolveTarget({ cfg: cfg(), to: 'oscar:Alice' })).toEqual({ ok: true, to: 'alice' });
  });

  it('lets allowUnlisted through', () => {
    expect(checkTarget({ cfg: cfg({ outbound: { allowUnlisted: true } }), to: 'mallory' }).ok).toBe(true);
  });
});

describe('sending', () => {
  it('sends wire html with reply priority by default and records the reply time', async () => {
    const res = await sendWire({ cfg: cfg(), to: 'Alice', html: '<B>hi</B>' });
    expect(res.chatId).toBe('alice');
    expect(session.sent).toEqual([{ to: 'alice', html: '<B>hi</B>', priority: 'reply' }]);
    expect(getRuntime('default')?.lastReplyAt.has('alice')).toBe(true);
  });

  it('does not count a notice as a reply', async () => {
    await withPriority('notice', () => sendWire({ cfg: cfg(), to: 'alice', html: 'n' }));
    expect(getRuntime('default')?.lastReplyAt.has('alice')).toBe(false);
  });

  it('carries the priority through the scope', async () => {
    await withPriority('notice', () => sendAdapterText({ cfg: cfg(), to: 'alice', text: 'n' }));
    await sendAdapterText({ cfg: cfg(), to: 'alice', text: 'r' });
    expect(session.sent.map((s) => s.priority)).toEqual(['notice', 'reply']);
  });

  it('converts and chunks markdown at the account limit', async () => {
    const long = `${'a'.repeat(150)} ${'b'.repeat(150)}`;
    const res = await sendMarkdown({ cfg: cfg({ textChunkLimit: 200 }), to: 'alice', markdown: long });
    expect(res.messageIds).toHaveLength(2);
    expect(session.sent.map((s) => s.html)).toEqual([toWireHtml('a'.repeat(150)), toWireHtml('b'.repeat(150))]);
  });

  it('sanitizes through the wire converter', () => {
    expect(outboundBase.sanitizeText({ text: '**x** <script>' })).toBe(toWireHtml('**x** <script>'));
    expect(outboundBase.deliveryMode).toBe('gateway');
    expect(outboundBase).toMatchObject({ chunkerMode: 'text', textChunkLimit: 1800 });
  });

  it('counts a failed send and rethrows', async () => {
    session.failNext = new Error('rate-limited');
    await expect(sendWire({ cfg: cfg(), to: 'alice', html: 'x' })).rejects.toThrow('rate-limited');
    expect(getRuntime('default')?.counters.droppedSends).toBe(1);
  });

  it('fails cleanly when the account is not running', async () => {
    resetRuntimeForTests();
    await expect(sendWire({ cfg: cfg(), to: 'alice', html: 'x' })).rejects.toThrow('account default is not signed on');
  });
});

describe('text filter', () => {
  afterEach(() => {
    setOutboundTextFilter('default', null);
    setOutboundTextFilter('other', null);
  });

  it('shows agent text to the account filter before it is converted, with its kind and format', async () => {
    const seen: OutboundMeta[] = [];
    setOutboundTextFilter('default', (meta, body) => {
      seen.push(meta);
      return body.toUpperCase();
    });
    await sendMarkdown({ cfg: cfg(), to: 'Alice', markdown: '**hi**' });
    await sendMarkdown({ cfg: cfg(), to: 'alice', markdown: 'part one', kind: 'block' });
    await sendAdapterText({ cfg: cfg(), to: 'bob', text: '<B>tool</B>' });
    expect(seen).toEqual([
      { accountId: 'default', target: { kind: 'im', name: 'alice' }, kind: 'final', format: 'markdown' },
      { accountId: 'default', target: { kind: 'im', name: 'alice' }, kind: 'block', format: 'markdown' },
      { accountId: 'default', target: { kind: 'im', name: 'bob' }, kind: 'send', format: 'wire' },
    ]);
    expect(session.sent.map((s) => s.html)).toEqual([toWireHtml('**HI**'), toWireHtml('PART ONE'), '<B>TOOL</B>']);
  });

  it('waits for an async filter and drops a payload it answers with null', async () => {
    setOutboundTextFilter('default', async (_meta, body) => (body.includes('keep') ? body : null));
    expect(await sendMarkdown({ cfg: cfg(), to: 'alice', markdown: 'drop me' })).toEqual({ messageIds: [] });
    expect(await sendAdapterText({ cfg: cfg(), to: 'alice', text: 'drop me too' })).toEqual({ messageId: '', chatId: 'alice' });
    expect((await sendMarkdown({ cfg: cfg(), to: 'alice', markdown: 'keep me' })).messageIds).toHaveLength(1);
    expect(session.sent.map((s) => s.html)).toEqual([toWireHtml('keep me')]);
  });

  it('never shows the filter a notice or a control line', async () => {
    const filter = vi.fn(() => null);
    setOutboundTextFilter('default', filter);
    await withPriority('notice', () => sendAdapterText({ cfg: cfg(), to: 'alice', text: 'n' }));
    await withPriority('control', () => sendMarkdown({ cfg: cfg(), to: 'alice', markdown: 'c' }));
    expect(filter).not.toHaveBeenCalled();
    expect(session.sent.map((s) => s.priority)).toEqual(['notice', 'control']);
  });

  it('is per account and never sees a refused target', async () => {
    const filter = vi.fn((_meta: OutboundMeta, body: string) => body);
    setOutboundTextFilter('other', filter);
    await sendMarkdown({ cfg: cfg(), to: 'alice', markdown: 'x' });
    setOutboundTextFilter('default', filter);
    await expect(sendMarkdown({ cfg: cfg(), to: 'mallory', markdown: 'x' })).rejects.toThrow('mallory is not in owners or allowFrom');
    expect(filter).not.toHaveBeenCalled();
  });

  it('sends as before once the filter is removed', async () => {
    setOutboundTextFilter('default', () => null);
    setOutboundTextFilter('default', null);
    expect((await sendMarkdown({ cfg: cfg(), to: 'alice', markdown: 'x' })).messageIds).toHaveLength(1);
  });
});

describe('typing', () => {
  it('starts and really stops, with an 8 s keepalive and a 120 s cap', async () => {
    const t = typingFor({ cfg: cfg(), accountId: 'default', peer: 'bob' });
    expect(sdk.typing[0]).toMatchObject({ keepaliveIntervalMs: 8000, maxDurationMs: 120000 });
    await t?.onReplyStart();
    t?.onIdle?.();
    await Promise.resolve();
    expect(session.typing).toEqual([{ to: 'bob', state: 'typing' }, { to: 'bob', state: 'none' }]);
  });

  it('is off for unlisted people, for bots and when typing is false', () => {
    expect(typingFor({ cfg: cfg({ dmPolicy: 'open', dangerouslyAllowOpenDm: true }), accountId: 'default', peer: 'mallory' })).toBeUndefined();
    expect(typingFor({ cfg: cfg({ chain: { roster: [{ screenName: 'botone' }, { screenName: 'bottwo' }] } }), accountId: 'default', peer: 'bottwo' })).toBeUndefined();
    expect(typingFor({ cfg: cfg({ typing: false }), accountId: 'default', peer: 'bob' })).toBeUndefined();
  });
});
