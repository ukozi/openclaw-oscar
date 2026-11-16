import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('openclaw/plugin-sdk/channel-core', async () => (await import('../fake/openclaw.js')).channelCore);
vi.mock('openclaw/plugin-sdk/channel-outbound', async () => (await import('../fake/openclaw.js')).channelOutbound);
vi.mock('openclaw/plugin-sdk/channel-inbound', async () => (await import('../fake/openclaw.js')).channelInbound);
vi.mock('openclaw/plugin-sdk/routing', async () => (await import('../fake/openclaw.js')).routing);
vi.mock('openclaw/plugin-sdk/session-store-runtime', async () => (await import('../fake/openclaw.js')).sessionStoreRuntime);
vi.mock('openclaw/plugin-sdk/conversation-runtime', async () => (await import('../fake/openclaw.js')).conversationRuntime);
vi.mock('openclaw/plugin-sdk/reply-dispatch-runtime', async () => (await import('../fake/openclaw.js')).replyDispatchRuntime);
vi.mock('openclaw/plugin-sdk/channel-ingress-runtime', async () => (await import('../fake/openclaw.js')).channelIngressRuntime);
vi.mock('openclaw/plugin-sdk/reply-chunking', async () => (await import('../fake/openclaw.js')).replyChunking);
vi.mock('openclaw/plugin-sdk/media-store', async () => (await import('../fake/openclaw.js')).mediaStore);
vi.mock('openclaw/plugin-sdk/status-helpers', async () => (await import('../fake/openclaw.js')).statusHelpers);

import { copy } from '../../src/copy.js';
import { imTexts } from '../fake/kit.js';
import { sdk } from '../fake/openclaw.js';
import { icbmsSentTo, startFlow, waitFor } from './helpers.js';
import type { Flow } from './helpers.js';

const PNG = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4);
const NOTES = new TextEncoder().encode('# Notes\n\nBring the cake.\n');
const deny = ['group:runtime', 'group:fs', 'group:automation', 'group:nodes', 'sessions_spawn'];

type Entry = { type?: string; payload: Record<string, unknown> };
const filesEntry = (ctx: Record<string, unknown>): Entry | undefined =>
  ((ctx.UntrustedStructuredContext ?? []) as Entry[]).find((e) => e.type === 'oscar_files');

let flow: Flow | undefined;
afterEach(async () => { await flow?.stop(); flow = undefined; });

describe('pictures and files reach the agent', () => {
  it("an owner's Direct IM picture reaches the agent and the reply comes back by IM", async () => {
    flow = await startFlow({ server: { relay: true }, sec: { files: { directIm: true } } });
    sdk.agent = (ctx) => [{ text: `I see ${String((ctx.MediaTypes as string[] | undefined)?.join(', '))}` }];
    const alice = flow.peer('alice');
    const direct = await alice.openDirectIm('botone');
    expect(direct.outcome).toBe('open');
    await direct.sendPicture('cat.png', PNG, 'look at this');
    await waitFor(() => imTexts(alice).length === 1, 8000, 'the reply to alice');
    expect(imTexts(alice)[0]).toMatchObject({ from: 'botone', text: 'I see image/png' });
    expect(flow.server.relayed()).toHaveLength(1);

    expect(sdk.media).toHaveLength(1);
    expect(sdk.media[0]).toMatchObject({ contentType: 'image/png', subdir: 'inbound', originalFilename: 'cat.png', maxBytes: 10 * 1024 * 1024 });
    expect(new Uint8Array(sdk.media[0]?.buffer ?? [])).toEqual(PNG);
    const path = sdk.media[0]?.path;
    expect(sdk.inbound).toHaveLength(1);
    const ctx = sdk.inbound[0]?.ctx as Record<string, unknown>;
    expect(ctx).toMatchObject({
      Body: 'look at this', SenderId: 'alice', ChatType: 'direct', CommandAuthorized: true, SessionKey: 'agent:main:oscar:group:botone/alice',
      MediaPath: path, MediaUrl: path, MediaType: 'image/png', MediaPaths: [path], MediaUrls: [path], MediaTypes: ['image/png'],
    });
    expect((sdk.built[0] as { media: unknown[] }).media).toEqual([{ path, url: path, contentType: 'image/png', kind: 'image', messageId: ctx.MessageSid }]);
    expect(filesEntry(ctx)?.payload).toEqual({ files: [{ name: 'cat.png', contentType: 'image/png', bytes: PNG.length, via: 'direct-im' }] });
  });

  it("an approved person's Markdown file reaches the agent as a document", async () => {
    flow = await startFlow({ server: { relay: true }, sec: { files: { sendFile: true } } });
    sdk.agent = () => [{ text: 'I read your notes' }];
    const bob = flow.peer('bob');
    const sent = await bob.offerFile('botone', 'notes.md', NOTES);
    expect(sent.outcome).toBe('done');
    await waitFor(() => imTexts(bob).length === 1, 8000, 'the reply to bob');
    expect(imTexts(bob)[0]).toMatchObject({ from: 'botone', text: 'I read your notes' });

    expect(sdk.media).toHaveLength(1);
    expect(sdk.media[0]).toMatchObject({ contentType: 'text/markdown', subdir: 'inbound', originalFilename: 'notes.md' });
    expect(new Uint8Array(sdk.media[0]?.buffer ?? [])).toEqual(NOTES);
    const path = sdk.media[0]?.path;
    const ctx = sdk.inbound[0]?.ctx as Record<string, unknown>;
    expect(ctx).toMatchObject({ Body: '<media:document>', SenderId: 'bob', CommandAuthorized: false, MediaPaths: [path], MediaTypes: ['text/markdown'] });
    expect((sdk.built[0] as { media: unknown[] }).media).toEqual([{ path, url: path, contentType: 'text/markdown', kind: 'document', messageId: ctx.MessageSid }]);
    expect(filesEntry(ctx)?.payload).toEqual({ files: [{ name: 'notes.md', contentType: 'text/markdown', bytes: NOTES.length, via: 'send-file' }] });
    const plugin = sdk.plugin as { groups: { resolveToolPolicy(p: Record<string, unknown>): unknown } };
    expect(plugin.groups.resolveToolPolicy({ cfg: flow.cfgRef.current, groupId: ctx.ChatId, accountId: 'default', senderId: 'bob' })).toEqual({ deny });
  });

  it('a text file with no extension reaches the agent as plain text', async () => {
    flow = await startFlow({ server: { relay: true }, sec: { files: { sendFile: true } } });
    sdk.agent = () => [{ text: 'ok' }];
    const bob = flow.peer('bob');
    expect((await bob.offerFile('botone', 'README', NOTES)).outcome).toBe('done');
    await waitFor(() => imTexts(bob).length === 1, 8000, 'the reply to bob');
    expect(sdk.inbound[0]?.ctx).toMatchObject({ MediaTypes: ['text/plain'] });
  });

  it("a stranger's picture and file reach nobody", async () => {
    flow = await startFlow({ server: { relay: true }, sec: { files: { directIm: true, sendFile: true } } });
    const alice = flow.peer('alice');
    sdk.agent = () => [{ text: 'hello' }];
    alice.sendIm('botone', 'hi');
    await waitFor(() => imTexts(alice).some((m) => m.text === 'hello'), 8000, 'the reply to alice');
    const mallory = flow.peer('mallory');
    void mallory.openDirectIm('botone');
    void mallory.offerFile('botone', 'notes.md', NOTES);
    const notice = copy.noticeFile('mallory');
    await waitFor(() => imTexts(alice).some((m) => m.text.startsWith(notice)), 8000, 'the owner notice');
    expect(imTexts(alice).map((m) => m.text.split('\n')[0])).toEqual(['hello', notice]);
    expect(flow.server.relayed()).toEqual([]);
    expect(sdk.media).toEqual([]);
    expect(sdk.inbound.map((r) => r.ctx.SenderId)).toEqual(['alice']);
    expect(icbmsSentTo(flow.server, 'botone', 'mallory')).toEqual([]);
  });
});

describe('refused files', () => {
  const BIG = new Uint8Array(1024 * 1024 + 1).fill(0x61);

  it('a file over the limit is declined and the sender gets the too-large message', async () => {
    flow = await startFlow({ server: { relay: true }, sec: { files: { sendFile: true, maxMb: 1 } } });
    const bob = flow.peer('bob');
    expect((await bob.offerFile('botone', 'big.txt', BIG)).outcome).toBe('declined');
    await waitFor(() => imTexts(bob).length === 1, 8000, 'the refusal to bob');
    expect(imTexts(bob)[0]).toMatchObject({ from: 'botone', text: copy.fileRefused('too-large', 1) });
    expect(copy.fileRefused('too-large', 1)).toContain('1 MB');
    expect(flow.server.relayed()).toEqual([]);
    expect(sdk.media).toEqual([]);
    expect(sdk.inbound).toEqual([]);
  });

  it('a stranger gets no message', async () => {
    flow = await startFlow({ server: { relay: true }, sec: { files: { directIm: true, sendFile: true, maxMb: 1 } } });
    const mallory = flow.peer('mallory');
    void mallory.offerFile('botone', 'big.txt', BIG);
    void mallory.offerFolder('botone', 'docs', [{ path: ['a.md'], bytes: NOTES }]);
    const bob = flow.peer('bob');
    expect((await bob.offerFile('botone', 'big.txt', BIG)).outcome).toBe('declined');
    await waitFor(() => imTexts(bob).length === 1, 8000, 'the refusal to bob');
    expect(icbmsSentTo(flow.server, 'botone', 'mallory')).toEqual([]);
  });
});

