import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sent = vi.hoisted(() => [] as { accountId?: string | null; to: string; markdown: string }[]);

vi.mock('openclaw/plugin-sdk/routing', async () => (await import('../fake/openclaw.js')).routing);
vi.mock('../../src/outbound.js', () => ({
  sendMarkdown: vi.fn(async (p: { accountId?: string | null; to: string; markdown: string }) => {
    if (p.to === 'mallory') throw new Error('offline');
    sent.push({ accountId: p.accountId, to: p.to, markdown: p.markdown });
    return { messageIds: ['1'] };
  }),
}));

import { RELAY_DEDUPE_MS, registerAnnounceRelay, relayDecision } from '../../src/relay.js';
import { setHost } from '../../src/runtime.js';

type Obj = Record<string, unknown>;
type Handler = (event: Obj, ctx: Obj) => unknown;

const cfg: Obj = {
  bindings: [{ agentId: 'helper', match: { channel: 'oscar', accountId: 'two' } }],
  channels: { oscar: { owners: ['alice', 'bob'], accounts: { one: { screenName: 'botone' }, two: { screenName: 'bottwo' } } } },
};
const announce = { role: 'user', content: [{ type: 'text', text: 'Agent-to-agent announce step.' }] };
const reply = (text: string): Obj => ({ role: 'assistant', content: [{ type: 'text', text }] });
const run = (messages: unknown[], over: Obj = {}) => ({ cfg, agentId: 'helper', sessionKey: 'agent:helper:main', messages, ...over });
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

describe('relayDecision', () => {
  it('relays the announce reply of an agent bound to an account', () => {
    expect(relayDecision(run([announce, reply('  Found three papers.  ')]))).toEqual({ accountId: 'two', text: 'Found three papers.' });
  });

  it('reads string content too', () => {
    const messages = [{ role: 'user', content: 'Agent-to-agent announce step.' }, { role: 'assistant', content: 'Done.' }];
    expect(relayDecision(run(messages))).toEqual({ accountId: 'two', text: 'Done.' });
  });

  it('leaves oscar sessions alone', () => {
    expect(relayDecision(run([announce, reply('Done.')], { sessionKey: 'agent:helper:oscar:group:x' }))).toBeNull();
  });

  it('ignores a run that is not the announce step', () => {
    expect(relayDecision(run([{ role: 'user', content: 'hello' }, reply('Done.')]))).toBeNull();
  });

  it('drops skip tokens and empty replies', () => {
    expect(relayDecision(run([announce, reply('ANNOUNCE_SKIP')]))).toBeNull();
    expect(relayDecision(run([announce, reply('NO_REPLY because nothing changed')]))).toBeNull();
    expect(relayDecision(run([announce, reply('   ')]))).toBeNull();
  });

  it('ignores an agent no account is bound to', () => {
    expect(relayDecision(run([announce, reply('Done.')], { agentId: 'other' }))).toBeNull();
  });
});

describe('registerAnnounceRelay', () => {
  let handler: Handler;
  const warn = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    sent.length = 0;
    warn.mockClear();
    setHost({ config: { current: () => cfg } });
    const on = vi.fn((name: string, fn: Handler) => { if (name === 'agent_end') handler = fn; });
    registerAnnounceRelay({ on, logger: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() } } as never);
  });

  afterEach(() => {
    vi.useRealTimers();
    setHost(undefined);
  });

  const fire = async (runId: string, text: string) => {
    handler({ runId, messages: [announce, reply(text)], success: true }, { agentId: 'helper', sessionKey: 'agent:helper:main' });
    await flush();
  };

  it('sends once to each owner and drops a repeat run or text', async () => {
    await fire('r1', 'Found three papers.');
    expect(sent).toEqual([
      { accountId: 'two', to: 'alice', markdown: 'Found three papers.' },
      { accountId: 'two', to: 'bob', markdown: 'Found three papers.' },
    ]);
    await fire('r1', 'Something else.');
    await fire('r2', 'Found three papers.');
    expect(sent).toHaveLength(2);
    vi.advanceTimersByTime(RELAY_DEDUPE_MS + 1);
    await fire('r3', 'Found three papers.');
    expect(sent).toHaveLength(4);
  });

  it('skips the bot itself and only warns when a send fails', async () => {
    const oscar = (cfg.channels as { oscar: Obj }).oscar;
    setHost({ config: { current: () => ({ ...cfg, channels: { oscar: { ...oscar, owners: ['bottwo', 'mallory', 'alice'] } } }) } });
    await fire('r1', 'Done.');
    expect(sent.map((s) => s.to)).toEqual(['alice']);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('takes the run id from the context when the event has none', async () => {
    handler({ messages: [announce, reply('Done.')], success: true }, { runId: 'c1', agentId: 'helper', sessionKey: 'agent:helper:main' });
    await flush();
    handler({ messages: [announce, reply('Other.')], success: true }, { runId: 'c1', agentId: 'helper', sessionKey: 'agent:helper:main' });
    await flush();
    expect(sent.map((s) => s.markdown)).toEqual(['Done.', 'Done.']);
  });
});
