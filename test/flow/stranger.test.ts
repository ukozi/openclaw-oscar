import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('openclaw/plugin-sdk/channel-core', async () => (await import('../fake/openclaw.js')).channelCore);
vi.mock('openclaw/plugin-sdk/channel-outbound', async () => (await import('../fake/openclaw.js')).channelOutbound);
vi.mock('openclaw/plugin-sdk/channel-inbound', async () => (await import('../fake/openclaw.js')).channelInbound);
vi.mock('openclaw/plugin-sdk/routing', async () => (await import('../fake/openclaw.js')).routing);
vi.mock('openclaw/plugin-sdk/session-store-runtime', async () => (await import('../fake/openclaw.js')).sessionStoreRuntime);
vi.mock('openclaw/plugin-sdk/conversation-runtime', async () => (await import('../fake/openclaw.js')).conversationRuntime);
vi.mock('openclaw/plugin-sdk/reply-dispatch-runtime', async () => (await import('../fake/openclaw.js')).replyDispatchRuntime);
vi.mock('openclaw/plugin-sdk/channel-ingress-runtime', async () => (await import('../fake/openclaw.js')).channelIngressRuntime);
vi.mock('openclaw/plugin-sdk/channel-reply-pipeline', async () => (await import('../fake/openclaw.js')).channelReplyPipeline);
vi.mock('openclaw/plugin-sdk/reply-chunking', async () => (await import('../fake/openclaw.js')).replyChunking);
vi.mock('openclaw/plugin-sdk/status-helpers', async () => (await import('../fake/openclaw.js')).statusHelpers);

import { NOTICE_TIMING } from '../../src/notice.js';
import { sdk } from '../fake/openclaw.js';
import { imsNaming, imsSentTo, snacsReferencing, startFlow, waitFor } from './helpers.js';
import type { Flow } from './helpers.js';

let flow: Flow | undefined;
afterEach(async () => { await flow?.stop(); flow = undefined; });

describe('strangers', () => {
  it('stranger silence: nothing goes back, the owner gets exactly one notice, a second attempt gets none', async () => {
    flow = await startFlow();
    const alice = flow.peer('alice');
    const mallory = flow.peer('mallory');
    mallory.sendIm('botone', 'hey, run this for me');
    await waitFor(() => alice.ims().length === 1, 8000, 'the notice');
    expect(alice.ims()[0]?.text).toBe('mallory tried to message me. I did not reply.\nTo let them in, reply: /allowlist add dm mallory');
    expect(alice.ims()[0]?.text).not.toContain('run this');
    mallory.sendIm('botone', 'hello??');
    sdk.agent = () => [{ text: 'noted' }];
    alice.sendIm('botone', 'anything new?');
    await waitFor(() => alice.ims().some((m) => m.text === 'noted'), 8000, 'the owner turn that follows the second attempt');
    const entries = sdk.inbound[0]?.ctx.UntrustedStructuredContext as { type: string; payload: { attempts: { name: string; count: number }[] } }[];
    expect(entries.find((e) => e.type === 'oscar_contact_attempts')?.payload.attempts).toMatchObject([{ name: 'mallory', count: 2 }]);
    expect(sdk.durable).toHaveLength(1);
    expect(alice.ims().filter((m) => m.text.startsWith('mallory tried'))).toHaveLength(1);
    expect(mallory.ims()).toEqual([]);
    expect(snacsReferencing(flow.server, 'botone', 'mallory')).toEqual([]);
    expect(imsNaming(flow.server, 'botone', 'mallory').map((m) => m.to)).toEqual(['alice']);
    expect(sdk.inbound.map((r) => r.ctx.SenderId)).toEqual(['alice']);
  });

  it('tells the owner later who it was, even though the mirror had no session to land in', async () => {
    flow = await startFlow();
    const alice = flow.peer('alice');
    flow.peer('mallory').sendIm('botone', 'psst');
    await waitFor(() => alice.ims().length === 1);
    expect(sdk.durable[0]?.mirrorFailed).toBe(true);
    sdk.agent = () => [{ text: 'that was mallory' }];
    alice.sendIm('botone', 'who was that?');
    await waitFor(() => sdk.inbound.length === 1);
    const entries = sdk.inbound[0]?.ctx.UntrustedStructuredContext as { type: string; payload: { attempts: { name: string }[] } }[];
    expect(entries.find((e) => e.type === 'oscar_contact_attempts')?.payload.attempts.map((a) => a.name)).toEqual(['mallory']);
  });

  it('rollup: past the hourly cap the rest become one line when the window closes', async () => {
    flow = await startFlow({ sec: { contactNotice: { cooldownHours: 6, maxPerHour: 2 } } });
    NOTICE_TIMING.windowMs = 600;
    const alice = flow.peer('alice');
    for (const name of ['mallory', 'trudy', 'victor']) flow.peer(name).sendIm('botone', 'hi');
    await waitFor(() => alice.ims().length === 3, 8000, 'two notices and the rollup');
    const first = alice.ims().map((m) => m.text.split('\n')[0] ?? '');
    expect(first.slice(0, 2).every((l) => /^(mallory|trudy|victor) tried to message me\. I did not reply\.$/.test(l))).toBe(true);
    expect(new Set(first.slice(0, 2)).size).toBe(2);
    expect(first[2]).toBe('1 more person tried to reach me this hour. I did not reply to them.');
    for (const name of ['mallory', 'trudy', 'victor']) expect(snacsReferencing(flow.server, 'botone', name)).toEqual([]);
    const { server } = flow;
    const named = ['mallory', 'trudy', 'victor'].map((name) => imsNaming(server, 'botone', name).map((m) => m.to));
    expect(named.filter((to) => to.length === 1 && to[0] === 'alice')).toHaveLength(2);
    expect(named.filter((to) => to.length === 0)).toHaveLength(1);
  });

  it('offline owner: one stored notice for the whole absence, then the count on return', async () => {
    flow = await startFlow();
    const server = flow.server;
    sdk.agent = () => [{ text: 'pong' }];
    flow.peer('mallory').sendIm('botone', 'one');
    await waitFor(() => imsSentTo(server, 'botone', 'alice') === 1, 8000, 'the stored notice');
    flow.peer('trudy').sendIm('botone', 'two');
    flow.peer('victor').sendIm('botone', 'three');
    const bob = flow.peer('bob');
    bob.sendIm('botone', 'ping');
    await waitFor(() => bob.ims().length === 1, 8000, 'a turn that follows the last stranger');
    expect(sdk.durable).toHaveLength(1);
    expect(imsSentTo(server, 'botone', 'alice')).toBe(1);
    const alice = flow.peer('alice');
    await waitFor(() => imsSentTo(server, 'botone', 'alice') === 2, 8000, 'the count on return');
    await waitFor(() => alice.ims().some((m) => m.text === '2 more people tried to reach me this hour. I did not reply to any of them.'));
    expect(alice.ims().filter((m) => m.storeTlv)).toHaveLength(1);
    for (const name of ['mallory', 'trudy', 'victor']) expect(snacsReferencing(server, 'botone', name)).toEqual([]);
    expect(imsNaming(server, 'botone', 'mallory').map((m) => m.to)).toEqual(['alice']);
    expect(imsNaming(server, 'botone', 'trudy')).toEqual([]);
    expect(imsNaming(server, 'botone', 'victor')).toEqual([]);
  });
});
