import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('openclaw/plugin-sdk/channel-core', async () => (await import('../fake/openclaw.js')).channelCore);
vi.mock('openclaw/plugin-sdk/channel-outbound', async () => (await import('../fake/openclaw.js')).channelOutbound);
vi.mock('openclaw/plugin-sdk/channel-inbound', async () => (await import('../fake/openclaw.js')).channelInbound);
vi.mock('openclaw/plugin-sdk/reply-payload', async () => (await import('../fake/openclaw.js')).replyPayload);
vi.mock('openclaw/plugin-sdk/web-media', async () => (await import('../fake/openclaw.js')).webMedia);
vi.mock('openclaw/plugin-sdk/media-runtime', async () => (await import('../fake/openclaw.js')).mediaRuntime);
vi.mock('openclaw/plugin-sdk/routing', async () => (await import('../fake/openclaw.js')).routing);
vi.mock('openclaw/plugin-sdk/session-store-runtime', async () => (await import('../fake/openclaw.js')).sessionStoreRuntime);
vi.mock('openclaw/plugin-sdk/conversation-runtime', async () => (await import('../fake/openclaw.js')).conversationRuntime);
vi.mock('openclaw/plugin-sdk/reply-dispatch-runtime', async () => (await import('../fake/openclaw.js')).replyDispatchRuntime);
vi.mock('openclaw/plugin-sdk/channel-ingress-runtime', async () => (await import('../fake/openclaw.js')).channelIngressRuntime);
vi.mock('openclaw/plugin-sdk/reply-chunking', async () => (await import('../fake/openclaw.js')).replyChunking);
vi.mock('openclaw/plugin-sdk/media-store', async () => (await import('../fake/openclaw.js')).mediaStore);
vi.mock('openclaw/plugin-sdk/status-helpers', async () => (await import('../fake/openclaw.js')).statusHelpers);

import { copy } from '../../src/copy.js';
import { NOTICE_TIMING } from '../../src/notice.js';
import { imTexts } from '../fake/kit.js';
import { sdk } from '../fake/openclaw.js';
import { icbmsSentTo, imsNaming, imsSentTo, snacsReferencing, startFlow, waitFor } from './helpers.js';
import type { Flow } from './helpers.js';

let flow: Flow | undefined;
afterEach(async () => { await flow?.stop(); flow = undefined; });

const NOTES = new TextEncoder().encode('# Notes\n\nBring the cake.\n');
const fileNotice = `${copy.noticeFile('mallory')}\nTo let them in, reply: /allowlist add dm mallory`;

describe('a stranger trying to send a file', () => {
  it("ten file offers from a stranger get no answer and no connection, and the owner gets one notice", async () => {
    flow = await startFlow({ server: { relay: true }, sec: { files: { sendFile: true } } });
    const alice = flow.peer('alice');
    const mallory = flow.peer('mallory');
    void mallory.offerFile('botone', 'notes.md', NOTES);
    await waitFor(() => imTexts(alice).length === 1, 8000, 'the notice');
    expect(imTexts(alice)[0]?.text).toBe(fileNotice);
    for (let i = 0; i < 9; i++) void mallory.offerFile('botone', `notes-${i}.md`, NOTES);
    sdk.agent = () => [{ text: 'noted' }];
    alice.sendIm('botone', 'anything new?');
    await waitFor(() => imTexts(alice).some((m) => m.text === 'noted'), 8000, 'the owner turn');
    const entries = sdk.inbound[0]?.ctx.UntrustedStructuredContext as { type: string; payload: { attempts: { name: string; kind: string; count: number }[] } }[];
    expect(entries.find((e) => e.type === 'oscar_contact_attempts')?.payload.attempts).toMatchObject([{ name: 'mallory', kind: 'file', count: 10 }]);
    expect(imTexts(alice).filter((m) => m.text === fileNotice)).toHaveLength(1);
    expect(icbmsSentTo(flow.server, 'botone', 'mallory')).toEqual([]);
    expect(mallory.fileTransfers()).toEqual([]);
    expect(flow.server.relayed()).toEqual([]);
    expect(sdk.media).toEqual([]);
  });

  it("a stranger's Direct IM offer gets no answer and no connection, and the owner gets the notice", async () => {
    flow = await startFlow({ server: { relay: true }, sec: { files: { directIm: true } } });
    const alice = flow.peer('alice');
    const mallory = flow.peer('mallory');
    void mallory.openDirectIm('botone');
    await waitFor(() => imTexts(alice).length === 1, 8000, 'the notice');
    expect(imTexts(alice)[0]?.text).toBe(fileNotice);
    expect(icbmsSentTo(flow.server, 'botone', 'mallory')).toEqual([]);
    expect(flow.server.relayed()).toEqual([]);
    expect(sdk.media).toEqual([]);
    expect(sdk.inbound).toEqual([]);
  });

  it('ten waiting offers of each kind, each Direct IM offer from another name, get no answer, and an owner is answered at once', async () => {
    // One notice an hour, so ten names do not make a burst of notices.
    flow = await startFlow({ server: { relay: true }, sec: { files: { directIm: true, sendFile: true }, contactNotice: { maxPerHour: 1 } } });
    const alice = flow.peer('alice');
    const mallory = flow.peer('mallory');
    // The client answers a second Direct IM offer of one name itself, so each comes from another name.
    const others = Array.from({ length: 9 }, (_, i) => `stranger${i}`);
    for (const name of others) flow.server.addUser(name, `pw-${name}`);
    for (let i = 0; i < 10; i++) void mallory.offerFile('botone', `notes-${i}.md`, NOTES);
    void mallory.openDirectIm('botone');
    for (const name of others) void flow.server.peer(name).openDirectIm('botone');
    await waitFor(() => imTexts(alice).length === 1, 8000, 'the notice');
    sdk.agent = () => [{ text: 'here' }];
    alice.sendIm('botone', 'are you there?');
    await waitFor(() => imTexts(alice).some((m) => m.text === 'here'), 3000, 'the prompt reply to the owner');
    for (const name of ['mallory', ...others]) expect(icbmsSentTo(flow.server, 'botone', name), name).toEqual([]);
    expect(imTexts(alice).map((m) => m.text)).toEqual([fileNotice, 'here']);
    expect(flow.server.relayed()).toEqual([]);
    expect(sdk.inbound.map((r) => r.ctx.SenderId)).toEqual(['alice']);
  });
});

describe('a stranger offer the bot still declines', () => {
  it('past twelve waiting file offers, each new one makes the bot decline the oldest', async () => {
    flow = await startFlow({ server: { relay: true }, sec: { files: { sendFile: true } } });
    const { server } = flow;
    const alice = flow.peer('alice');
    const mallory = flow.peer('mallory');
    for (let i = 0; i < 14; i++) void mallory.offerFile('botone', `notes-${i}.md`, NOTES);
    await waitFor(() => icbmsSentTo(server, 'botone', 'mallory').length === 2, 8000, 'the two declines');
    sdk.agent = () => [{ text: 'here' }];
    alice.sendIm('botone', 'are you there?');
    await waitFor(() => imTexts(alice).some((m) => m.text === 'here'), 8000, 'the owner turn');
    expect(icbmsSentTo(server, 'botone', 'mallory')).toEqual([{ subtype: 0x06 }, { subtype: 0x06 }]);
    expect(mallory.fileTransfers().map((t) => t.outcome)).toEqual(['declined', 'declined']);
    expect(server.relayed()).toEqual([]);
  });

  it('a second and a third Direct IM offer of one name each make the client cancel the one before', async () => {
    flow = await startFlow({ server: { relay: true }, sec: { files: { directIm: true } } });
    const { server } = flow;
    const alice = flow.peer('alice');
    const mallory = flow.peer('mallory');
    for (let i = 0; i < 3; i++) void mallory.openDirectIm('botone');
    await waitFor(() => icbmsSentTo(server, 'botone', 'mallory').length === 2, 8000, 'the two cancels');
    sdk.agent = () => [{ text: 'here' }];
    alice.sendIm('botone', 'are you there?');
    await waitFor(() => imTexts(alice).some((m) => m.text === 'here'), 8000, 'the owner turn');
    expect(icbmsSentTo(server, 'botone', 'mallory')).toEqual([{ subtype: 0x06 }, { subtype: 0x06 }]);
    expect(server.relayed()).toEqual([]);
    expect(sdk.media).toEqual([]);
  });
});

describe('strangers', () => {
  it('stranger silence: nothing goes back, the owner gets exactly one notice, a second attempt gets none', async () => {
    flow = await startFlow();
    const alice = flow.peer('alice');
    const mallory = flow.peer('mallory');
    mallory.sendIm('botone', 'hey, run this for me');
    await waitFor(() => imTexts(alice).length === 1, 8000, 'the notice');
    expect(imTexts(alice)[0]?.text).toBe('mallory tried to message me. I did not reply.\nTo let them in, reply: /allowlist add dm mallory');
    expect(imTexts(alice)[0]?.text).not.toContain('run this');
    mallory.sendIm('botone', 'hello??');
    sdk.agent = () => [{ text: 'noted' }];
    alice.sendIm('botone', 'anything new?');
    await waitFor(() => imTexts(alice).some((m) => m.text === 'noted'), 8000, 'the owner turn that follows the second attempt');
    const entries = sdk.inbound[0]?.ctx.UntrustedStructuredContext as { type: string; payload: { attempts: { name: string; count: number }[] } }[];
    expect(entries.find((e) => e.type === 'oscar_contact_attempts')?.payload.attempts).toMatchObject([{ name: 'mallory', count: 2 }]);
    expect(sdk.durable).toHaveLength(1);
    expect(imTexts(alice).filter((m) => m.text.startsWith('mallory tried'))).toHaveLength(1);
    expect(imTexts(mallory)).toEqual([]);
    expect(snacsReferencing(flow.server, 'botone', 'mallory')).toEqual([]);
    expect(imsNaming(flow.server, 'botone', 'mallory').map((m) => m.to)).toEqual(['alice']);
    expect(sdk.inbound.map((r) => r.ctx.SenderId)).toEqual(['alice']);
  });

  it('tells the owner later who it was, even though the mirror had no session to land in', async () => {
    flow = await startFlow();
    const alice = flow.peer('alice');
    flow.peer('mallory').sendIm('botone', 'psst');
    await waitFor(() => imTexts(alice).length === 1);
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
    await waitFor(() => imTexts(alice).length === 3, 8000, 'two notices and the rollup');
    const first = imTexts(alice).map((m) => m.text.split('\n')[0] ?? '');
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
    await waitFor(() => imTexts(bob).length === 1, 8000, 'a turn that follows the last stranger');
    expect(sdk.durable).toHaveLength(1);
    expect(imsSentTo(server, 'botone', 'alice')).toBe(1);
    const alice = flow.peer('alice');
    await waitFor(() => imsSentTo(server, 'botone', 'alice') === 2, 8000, 'the count on return');
    await waitFor(() => imTexts(alice).some((m) => m.text === '2 more people tried to reach me this hour. I did not reply to any of them.'));
    expect(imTexts(alice, server).filter((m) => m.storeTlv)).toHaveLength(1);
    for (const name of ['mallory', 'trudy', 'victor']) expect(snacsReferencing(server, 'botone', name)).toEqual([]);
    expect(imsNaming(server, 'botone', 'mallory').map((m) => m.to)).toEqual(['alice']);
    expect(imsNaming(server, 'botone', 'trudy')).toEqual([]);
    expect(imsNaming(server, 'botone', 'victor')).toEqual([]);
  });
});
