import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

import { toWireHtml } from 'open-oscar-client-kit/wire';
import { gatewayDeps, oscarPlugin, startAccount, stopAccount } from '../../src/channel.js';
import { RELOAD_NOOP_PREFIXES, resolveAccount } from '../../src/config.js';
import { IM_TIMING } from '../../src/inbound/im.js';
import { getRuntime, resetRuntimeForTests, setRuntime } from '../../src/runtime.js';
import { sdk } from '../fake/openclaw.js';
import { FakeSession } from '../fake/session.js';

type Obj = Record<string, unknown>;
const plugin = oscarPlugin as unknown as Record<string, any>;
const cfg = (patch: Obj = {}, host: Obj = {}) => ({
  ...host,
  channels: { oscar: { host: 'oscar.example.net', tls: true, screenName: 'Bot One', password: 'hunter22', owners: ['Alice B', 'alice'], allowFrom: ['bob'], ...patch } },
});
const deny = ['group:runtime', 'group:fs', 'group:automation', 'group:nodes', 'sessions_spawn'];

function makeCtx(config: Obj, accountId = 'default') {
  const ac = new AbortController();
  let status: Obj = { accountId };
  const ctx = {
    cfg: config, accountId, account: resolveAccount(config, accountId), runtime: {}, abortSignal: ac.signal,
    log: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
    getStatus: () => status, setStatus: (next: Obj) => { status = next; },
  };
  return { ac, ctx: ctx as never, status: () => status };
}

let sessions: FakeSession[];
beforeEach(() => {
  sdk.reset();
  resetRuntimeForTests();
  sessions = [];
  gatewayDeps.createSession = (() => { const s = new FakeSession(); sessions.push(s); return s.asSession(); }) as typeof gatewayDeps.createSession;
  Object.assign(IM_TIMING, { debounceMs: 0, replyCooldownMs: 0 });
  sdk.usePlugin(oscarPlugin);
});
afterEach(() => Object.assign(IM_TIMING, { debounceMs: 2000, replyCooldownMs: 2000 }));

describe('plugin object', () => {
  it('declares what the spec says', () => {
    expect(plugin.id).toBe('oscar');
    expect(plugin.capabilities).toEqual({ chatTypes: ['direct', 'group'], media: true, reactions: false, reply: false, threads: false, polls: false, edit: false, unsend: false });
    expect(plugin.reload).toEqual({ configPrefixes: ['channels.oscar'], noopPrefixes: RELOAD_NOOP_PREFIXES });
    expect(plugin.threading.resolveReplyToMode()).toBe('off');
    expect(plugin.outbound.deliveryMode).toBe('gateway');
    expect(typeof plugin.outbound.chunker).toBe('function');
    expect(typeof plugin.outbound.sanitizeText).toBe('function');
    expect(plugin.commands).toEqual({ enforceOwnerForCommands: true });
    expect(plugin.message).toBeDefined();
    expect(plugin.meta).toMatchObject({ id: 'oscar' });
    for (const key of ['label', 'selectionLabel', 'docsPath', 'blurb']) expect(typeof plugin.meta[key]).toBe('string');
    expect(plugin.pairing).toBeUndefined();
    expect(plugin.agentTools).toBeUndefined();
    expect(plugin.secrets.secretTargetRegistryEntries).toHaveLength(2);
    expect(typeof plugin.secrets.collectRuntimeConfigAssignments).toBe('function');
    expect((plugin.configSchema.schema as Obj).type).toBe('object');
  });

  it('formatAllowFrom normalises, so "oscar:Alice B" in commands.ownerAllowFrom matches sender aliceb', () => {
    expect(plugin.config.formatAllowFrom({ cfg: cfg(), allowFrom: ['Alice B', 'oscar:Alice', 42, '  '] })).toEqual(['aliceb', 'alice', '42']);
    expect(plugin.config.resolveAllowFrom({ cfg: cfg() })).toEqual(['aliceb', 'alice', 'bob']);
    expect(plugin.config.listAccountIds(cfg())).toEqual(['default']);
    expect(plugin.config.isConfigured(resolveAccount(cfg()), cfg())).toBe(true);
    expect(plugin.config.isEnabled(resolveAccount(cfg({ enabled: false })), cfg())).toBe(false);
  });
});

describe('messaging hooks', () => {
  it('infers the chat type from one parser', () => {
    expect(plugin.messaging.inferTargetChatType({ to: 'alice' })).toBe('direct');
    expect(plugin.messaging.inferTargetChatType({ to: 'botone/alice' })).toBe('direct');
    expect(plugin.messaging.inferTargetChatType({ to: 'room:testroom' })).toBe('group');
    expect(plugin.messaging.inferTargetChatType({ to: 'botone#4.testroom' })).toBe('group');
    expect(plugin.messaging.inferTargetChatType({ to: 'user:alice' })).toBeUndefined();
  });

  it('normalises targets and recognises ids', async () => {
    expect(plugin.messaging.normalizeTarget('oscar:Alice B')).toBe('aliceb');
    expect(plugin.messaging.normalizeTarget('room:TestRoom')).toBe('room:4:testroom');
    expect(plugin.messaging.normalizeTarget('a:b')).toBeUndefined();
    expect(plugin.messaging.targetResolver.looksLikeId('Alice B')).toBe(true);
    expect(plugin.messaging.targetResolver.looksLikeId('a:b')).toBe(false);
    expect(await plugin.messaging.targetResolver.resolveTarget({ cfg: cfg(), accountId: 'default', input: 'Alice', normalized: 'alice' })).toEqual({ to: 'alice', kind: 'user', display: 'alice', source: 'normalized' });
    expect(await plugin.messaging.targetResolver.resolveTarget({ cfg: cfg(), accountId: 'default', input: 'bottwo/alice', normalized: 'bottwo/alice' })).toBeNull();
  });

  it('routes an outbound IM to the same group-shaped session inbound uses', () => {
    const route = plugin.messaging.resolveOutboundSessionRoute({ cfg: cfg(), agentId: 'main', accountId: 'default', target: 'Alice' });
    expect(route).toMatchObject({ sessionKey: 'agent:main:oscar:group:botone/alice', peer: { kind: 'group', id: 'botone/alice' }, chatType: 'direct', to: 'alice', from: 'oscar:botone' });
    expect(plugin.messaging.resolveOutboundSessionRoute({ cfg: cfg(), agentId: 'main', accountId: 'default', target: 'bottwo/alice' })).toBeNull();
  });
});

describe('groups hooks', () => {
  it.each([
    ['botone/alice', 'alice', undefined],
    ['botone/aliceb', 'Alice B', undefined],
    ['botone/bob', 'bob', { deny }],
    ['botone/bob', undefined, { deny }],
    ['botone/bob', null, { deny }],
    ['botone/alice', undefined, undefined],
    ['botone/alice', 'bob', { deny }],
    ['botone/mallory', 'mallory', { deny }],
    ['botone#4.testroom', 'alice', undefined],
    ['botone#4.testroom', 'bob', { deny }],
    ['botone#4.testroom', undefined, { deny }],
    ['something else', 'alice', undefined],
  ])('tool policy denies without a sender id: %j from %j', (groupId, senderId, want) => {
    expect(plugin.groups.resolveToolPolicy({ cfg: cfg(), groupId, senderId })).toEqual(want);
  });

  it('merges an operator entry for a room sender', () => {
    const c = cfg({ rooms: { testroom: { toolsBySender: { 'id:bob': { deny: ['web_fetch'], alsoAllow: ['read'] }, '*': { deny: ['browser'] } } } } });
    expect(plugin.groups.resolveToolPolicy({ cfg: c, groupId: 'botone#4.testroom', senderId: 'bob' })).toEqual({ deny: [...deny, 'web_fetch'], alsoAllow: ['read'] });
    expect(plugin.groups.resolveToolPolicy({ cfg: c, groupId: 'botone#4.testroom', senderId: 'alice' })).toEqual({ deny: ['browser'] });
  });

  it('never requires a mention: the plugin decides every room wake itself', () => {
    const team = cfg({ chain: { roster: [{ screenName: 'botone' }, { screenName: 'bottwo' }, { screenName: 'botthree' }] } });
    expect(plugin.groups.resolveRequireMention({ cfg: cfg(), groupId: 'botone/alice' })).toBe(false);
    expect(plugin.groups.resolveRequireMention({ cfg: team, groupId: 'bottwo/alice' })).toBe(false);
    for (const bot of ['botone', 'bottwo', 'botthree', 'botnine']) {
      expect(plugin.groups.resolveRequireMention({ cfg: team, groupId: `${bot}#4.testroom` })).toBe(false);
    }
    expect(plugin.groups.resolveRequireMention({ cfg: cfg(), groupId: 'x' })).toBeUndefined();
  });
});

describe('allowlist adapter', () => {
  const edit = (parsedConfig: Obj, action: 'add' | 'remove', entry: string, scope: 'dm' | 'group' = 'dm') =>
    plugin.allowlist.applyConfigEdit({ cfg: parsedConfig, parsedConfig, accountId: 'bottwo', scope, action, entry });

  it('allowlist add stores the normalised name at the root, whatever the account', () => {
    const parsed = cfg({ accounts: { bottwo: { screenName: 'bottwo' } } });
    expect(edit(parsed, 'add', 'Sam Smith')).toEqual({ kind: 'ok', changed: true, pathLabel: 'channels.oscar.allowFrom', writeTarget: { kind: 'channel', scope: { channelId: 'oscar' } } });
    expect((parsed.channels.oscar as Obj).allowFrom).toEqual(['bob', 'samsmith']);
    expect((parsed.channels.oscar as Obj).accounts).toEqual({ bottwo: { screenName: 'bottwo' } });
    expect(edit(parsed, 'add', 'samsmith')).toMatchObject({ kind: 'ok', changed: false });
  });

  it('removes by normalised match and creates the block when it is missing', () => {
    const parsed = cfg({ allowFrom: ['Bob', 'Sam Smith'] });
    expect(edit(parsed, 'remove', 'sam smith')).toMatchObject({ kind: 'ok', changed: true });
    expect((parsed.channels.oscar as Obj).allowFrom).toEqual(['Bob']);
    const empty: Obj = {};
    expect(edit(empty, 'add', 'bob')).toMatchObject({ kind: 'ok', changed: true });
    expect(empty).toEqual({ channels: { oscar: { allowFrom: ['bob'] } } });
  });

  it('refuses odd names, roster bots and group scope', () => {
    expect(edit(cfg(), 'add', 'bøb')).toEqual({ kind: 'invalid-entry' });
    expect(edit(cfg(), 'add', '   ')).toEqual({ kind: 'invalid-entry' });
    expect(edit(cfg(), 'add', '*')).toEqual({ kind: 'invalid-entry' });
    expect(edit(cfg({ chain: { roster: [{ screenName: 'botone' }, { screenName: 'bottwo' }] } }), 'add', 'Bot Two')).toEqual({ kind: 'invalid-entry' });
    expect(edit(cfg(), 'add', 'bob', 'group')).toBeNull();
    expect(plugin.allowlist.supportsScope({ scope: 'dm' })).toBe(true);
    expect(plugin.allowlist.supportsScope({ scope: 'group' })).toBe(false);
    expect(plugin.allowlist.readConfig({ cfg: cfg() })).toEqual({ dmAllowFrom: ['aliceb', 'alice', 'bob'], dmPolicy: 'allowlist' });
  });
});

describe('heartbeat', () => {
  it('is ready only while signed on', async () => {
    expect(await plugin.heartbeat.checkReady({ cfg: cfg() })).toEqual({ ok: false, reason: 'not running' });
    const s = new FakeSession();
    const rt = { accountId: 'default', session: s.asSession(), rooms: new Map(), sessionKeys: new Map(), lastReplyAt: new Map(), counters: { droppedSends: 0, eventGaps: 0 } };
    setRuntime(rt);
    expect((await plugin.heartbeat.checkReady({ cfg: cfg() })).ok).toBe(false);
    s.setState({ phase: 'online' });
    expect(await plugin.heartbeat.checkReady({ cfg: cfg(), accountId: 'default' })).toEqual({ ok: true, reason: 'signed on' });
    Object.assign(rt, { halted: { reason: 'unauthenticated-server', detail: 'x' } });
    expect(await plugin.heartbeat.checkReady({ cfg: cfg() })).toEqual({ ok: false, reason: 'unauthenticated-server' });
  });
});

describe('gateway', () => {
  it('starts a session with the right options, serves a turn and a notice, and stops on abort', async () => {
    const t = makeCtx(cfg());
    const parked = startAccount(t.ctx);
    await vi.waitFor(() => expect(sessions[0]?.started).toBe(true));
    const s = sessions[0] as FakeSession;
    s.setPresence('alice', { online: true });
    s.setState({ phase: 'online' });
    expect(t.status()).toMatchObject({ accountId: 'default', running: true, connected: true });

    sdk.agent = () => [{ text: 'hello back' }];
    s.emit('im', { from: 'bob', fromDisplay: 'Bob', text: 'hi', cookie: 1n, autoResponse: false, offline: false, system: false });
    await vi.waitFor(() => expect(s.sent.some((m) => m.to === 'bob')).toBe(true));
    expect(getRuntime('default')?.lastReplyAt.has('bob')).toBe(true);

    s.emit('im', { from: 'mallory', fromDisplay: 'mallory', text: 'psst', cookie: 2n, autoResponse: false, offline: false, system: false });
    await vi.waitFor(() => expect(s.sent.filter((m) => m.priority === 'notice')).toHaveLength(2));
    expect(s.sent.filter((m) => m.to === 'mallory')).toEqual([]);
    expect(s.typing.filter((x) => x.to === 'mallory')).toEqual([]);
    expect(s.sent.filter((m) => m.priority === 'notice').map((m) => m.to).sort()).toEqual(['alice', 'aliceb']);
    expect(sdk.ingress.every((r) => (r.params.event as { mayPair: boolean }).mayPair === false)).toBe(true);

    t.ac.abort();
    await parked;
    expect(s.stopped).toBe(true);
    expect(getRuntime('default')).toBeUndefined();
  });

  it('hands the session fresh buddies and a fresh password', async () => {
    let options: Obj | undefined;
    gatewayDeps.createSession = ((o: Obj) => { options = o; const s = new FakeSession(); sessions.push(s); return s.asSession(); }) as never;
    const t = makeCtx(cfg({ passwordFile: '/run/secrets/oscar', tls: false, port: 5191 }));
    sdk.secretFiles.set('/run/secrets/oscar', 'from-file1');
    const parked = startAccount(t.ctx);
    await vi.waitFor(() => expect(options).toBeDefined());
    expect(options).toMatchObject({ host: 'oscar.example.net', port: 5191, tls: false, redirect: 'auto', screenName: 'Bot One' });
    expect(options).not.toHaveProperty('allowUnauthenticatedServer');
    expect((options?.buddies as () => string[])()).toEqual(['aliceb', 'alice', 'bob']);
    expect(await (options?.getPassword as () => Promise<string>)()).toBe('from-file1');
    sdk.secretFiles.set('/run/secrets/oscar', 'rotated22');
    expect(await (options?.getPassword as () => Promise<string>)()).toBe('rotated22');
    sdk.secretFiles.delete('/run/secrets/oscar');
    await expect((options?.getPassword as () => Promise<string>)()).rejects.toThrow('password file');
    t.ac.abort();
    await parked;
  });

  it('refuses an unresolved secret reference instead of sending an empty password', async () => {
    let options: Obj | undefined;
    gatewayDeps.createSession = ((o: Obj) => { options = o; const s = new FakeSession(); sessions.push(s); return s.asSession(); }) as never;
    const t = makeCtx(cfg({ password: { source: 'env', provider: 'default', id: 'OSCAR_PASSWORD' } }));
    const parked = startAccount(t.ctx);
    await vi.waitFor(() => expect(options).toBeDefined());
    await expect((options?.getPassword as () => Promise<string>)()).rejects.toThrow('not resolved');
    t.ac.abort();
    await parked;
  });

  it('does not start an unconfigured or disabled account', async () => {
    const t = makeCtx(cfg({ password: undefined }));
    await startAccount(t.ctx);
    expect(sessions).toEqual([]);
    expect(t.status()).toMatchObject({ running: false, lastError: 'not configured' });
    const off = makeCtx(cfg({ enabled: false }));
    off.ac.abort();
    await startAccount(off.ctx);
    expect(sessions).toEqual([]);
    expect(off.status()).toMatchObject({ running: false, connected: false, lastError: 'disabled' });
  });

  it('does not start an account while nobody is an owner', async () => {
    for (const owners of [[], ['*'], undefined]) {
      const t = makeCtx(cfg({ owners }));
      await startAccount(t.ctx);
      expect(t.status()).toMatchObject({ running: false, connected: false, lastError: 'no owners' });
      expect(getRuntime('default')).toBeUndefined();
    }
    expect(sessions).toEqual([]);
  });

  it('a superseded start never stops the newer one', async () => {
    const a = makeCtx(cfg());
    const first = startAccount(a.ctx);
    await vi.waitFor(() => expect(sessions).toHaveLength(1));
    const b = makeCtx(cfg());
    const second = startAccount(b.ctx);
    await vi.waitFor(() => expect(sessions).toHaveLength(2));
    expect(sessions[0]?.stopped).toBe(true);
    a.ac.abort();
    await first;
    expect(sessions[1]?.stopped).toBe(false);
    expect(getRuntime('default')?.session).toBeDefined();
    await stopAccount(b.ctx);
    expect(sessions[1]?.stopped).toBe(true);
    b.ac.abort();
    await second;
  });

  it('halts when the server does not check passwords', async () => {
    const t = makeCtx(cfg());
    const parked = startAccount(t.ctx);
    await vi.waitFor(() => expect(sessions).toHaveLength(1));
    const s = sessions[0] as FakeSession;
    s.probeResult = 'does-not-check';
    s.setState({ phase: 'online' });
    await vi.waitFor(() => expect(s.stopped).toBe(true));
    expect(getRuntime('default')?.halted).toMatchObject({ reason: 'unauthenticated-server' });
    expect(t.status()).toMatchObject({ connected: false });
    expect(String(t.status().lastError)).toContain('unauthenticated-server');
    expect((await plugin.heartbeat.checkReady({ cfg: cfg() })).ok).toBe(false);
    t.ac.abort();
    await parked;
  });

  it('adopts the refusal if a session ever reports it as a state', async () => {
    const t = makeCtx(cfg());
    const parked = startAccount(t.ctx);
    await vi.waitFor(() => expect(sessions).toHaveLength(1));
    const s = sessions[0] as FakeSession;
    s.setState({ phase: 'fatal', reason: 'unauthenticated-server', detail: 'the server accepted a wrong password' });
    expect(getRuntime('default')?.halted).toMatchObject({ reason: 'unauthenticated-server' });
    expect(t.status()).toMatchObject({ running: false, connected: false, terminalDisconnect: true });
    t.ac.abort();
    await parked;
  });

  it('counts a fall out of online as an event gap, and a stop as none', async () => {
    const t = makeCtx(cfg());
    const parked = startAccount(t.ctx);
    await vi.waitFor(() => expect(sessions).toHaveLength(1));
    const s = sessions[0] as FakeSession;
    s.setState({ phase: 'online' });
    s.setState({ phase: 'backoff', reason: 'network' });
    s.setState({ phase: 'connecting' });
    s.setState({ phase: 'online' });
    expect(getRuntime('default')?.counters.eventGaps).toBe(1);
    const rt = getRuntime('default');
    t.ac.abort();
    await parked;
    expect(rt?.counters.eventGaps).toBe(1);
  });

  it('keeps running on such a server when the operator said so', async () => {
    const t = makeCtx(cfg({ dangerouslyAllowUnauthenticatedServer: true }));
    const parked = startAccount(t.ctx);
    await vi.waitFor(() => expect(sessions).toHaveLength(1));
    const s = sessions[0] as FakeSession;
    s.probeResult = 'does-not-check';
    s.setState({ phase: 'online' });
    await vi.waitFor(() => expect(getRuntime('default')?.probe?.result).toBe('does-not-check'));
    expect(s.stopped).toBe(false);
    t.ac.abort();
    await parked;
  });
});

describe('pictures and files', () => {
  const PNG = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4);
  const NOTES = new TextEncoder().encode('# Notes\n\nBring the cake.\n');

  async function boot(files?: Obj) {
    let options: Obj | undefined;
    gatewayDeps.createSession = ((o: Obj) => { options = o; const s = new FakeSession(); sessions.push(s); return s.asSession(); }) as never;
    const t = makeCtx(cfg(files ? { files } : {}));
    const nth = sessions.length;
    const parked = startAccount(t.ctx);
    await vi.waitFor(() => expect(sessions[nth]?.started).toBe(true));
    const s = sessions[nth] as FakeSession;
    s.setState({ phase: 'online' });
    return { s, options: options as Obj, stop: async () => { t.ac.abort(); await parked; } };
  }

  async function sendPicture(s: FakeSession, from: string, text: string): Promise<void> {
    s.emit('directImOffer', { id: 'd1', from, fromDisplay: from });
    await vi.waitFor(() => expect(s.directIm).toEqual([{ call: 'accept', id: 'd1' }]));
    s.emit('directIm', { id: 'd1', peer: from, state: 'open' });
    s.emit('directMessage', { id: 'd1', from, fromDisplay: from, text, autoResponse: false, damaged: false, pictures: [{ name: 'cat.png', bytes: PNG }] });
  }

  async function sendFile(s: FakeSession, from: string, name: string, bytes: Uint8Array): Promise<void> {
    s.emit('fileOffer', { id: 'f1', from, fromDisplay: from, count: 1, totalBytes: bytes.byteLength, name, folder: false });
    await vi.waitFor(() => expect(s.files.map((f) => f.call)).toEqual(['accept']));
    const writer = await s.files[0]?.sink?.begin({ name, bytes: bytes.byteLength, index: 0, count: 1 } as never);
    await writer?.write(bytes);
    await writer?.finish();
    s.emit('transfer', { id: 'f1', peer: from, state: 'done', index: 0, bytesDone: bytes.byteLength });
  }

  it('declares media in the channel capabilities', () => {
    expect(plugin.capabilities.media).toBe(true);
  });

  it('gives the session the files settings', async () => {
    const off = await boot();
    expect(off.options.transfers).toEqual({ directIm: false, sendFile: false, maxBytes: 10 * 1024 * 1024 });
    await off.stop();
    const on = await boot({ directIm: true, sendFile: true, maxMb: 2, relayHost: 'relay.example.net' });
    expect(on.options.transfers).toEqual({ directIm: true, sendFile: true, maxBytes: 2 * 1024 * 1024, relayHost: 'relay.example.net' });
    await on.stop();
  });

  it('sends a reply as text when the channel declares media', async () => {
    const t = await boot({ directIm: true });
    sdk.agent = () => [{ text: 'a fine **cat**', mediaUrl: '/tmp/reply.png' } as never, { text: '', mediaUrl: '/tmp/only.png' } as never];
    await sendPicture(t.s, 'alice', 'look at this');
    await vi.waitFor(() => expect(t.s.sent.filter((m) => m.to === 'alice')).toHaveLength(1));
    expect(t.s.sent).toEqual([{ to: 'alice', html: toWireHtml('a fine **cat**'), priority: 'reply' }]);
    expect(sdk.media).toHaveLength(1);
    expect(sdk.media[0]).toMatchObject({ contentType: 'image/png', subdir: 'inbound', originalFilename: 'cat.png' });
    expect(sdk.inbound[0]?.ctx).toMatchObject({ Body: 'look at this', SenderId: 'alice', MediaPaths: [sdk.media[0]?.path], MediaTypes: ['image/png'] });
    await t.stop();
  });

  it("keeps the tool deny list for an approved sender's files", async () => {
    const t = await boot({ sendFile: true });
    sdk.agent = () => [{ text: 'read it' }];
    await sendFile(t.s, 'bob', 'notes.md', NOTES);
    await vi.waitFor(() => expect(t.s.sent.filter((m) => m.to === 'bob')).toHaveLength(1));
    const ctx = sdk.inbound[0]?.ctx as Obj;
    expect(ctx).toMatchObject({ SenderId: 'bob', CommandAuthorized: false, Body: '<media:document>', MediaTypes: ['text/markdown'] });
    expect(plugin.groups.resolveToolPolicy({ cfg: cfg(), groupId: ctx.ChatId, accountId: 'default', senderId: 'bob' })).toEqual({ deny });
    expect(plugin.groups.resolveToolPolicy({ cfg: cfg(), groupId: ctx.ChatId, accountId: 'default' })).toEqual({ deny });
    await t.stop();
  });

  it('starts no intake while both settings are off', async () => {
    const t = await boot();
    t.s.emit('directImOffer', { id: 'd1', from: 'alice', fromDisplay: 'alice' });
    t.s.emit('fileOffer', { id: 'f1', from: 'alice', fromDisplay: 'alice', count: 1, totalBytes: 4, name: 'a.txt', folder: false });
    t.s.emit('im', { from: 'alice', fromDisplay: 'alice', text: 'hi', cookie: 1n, autoResponse: false, offline: false, system: false });
    await vi.waitFor(() => expect(sdk.inbound).toHaveLength(1));
    expect(t.s.directIm).toEqual([]);
    expect(t.s.files).toEqual([]);
    await t.stop();
  });

  it('starts only the intake whose setting is on', async () => {
    const t = await boot({ directIm: true });
    t.s.emit('fileOffer', { id: 'f1', from: 'alice', fromDisplay: 'alice', count: 1, totalBytes: 4, name: 'a.txt', folder: false });
    t.s.emit('directImOffer', { id: 'd1', from: 'alice', fromDisplay: 'alice' });
    await vi.waitFor(() => expect(t.s.directIm).toEqual([{ call: 'accept', id: 'd1' }]));
    expect(t.s.files).toEqual([]);
    await t.stop();
  });

  it('stops the intakes with the account', async () => {
    const t = await boot({ directIm: true, sendFile: true });
    await t.stop();
    t.s.emit('directImOffer', { id: 'd1', from: 'alice', fromDisplay: 'alice' });
    t.s.emit('fileOffer', { id: 'f1', from: 'alice', fromDisplay: 'alice', count: 1, totalBytes: 4, name: 'a.txt', folder: false });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(t.s.directIm).toEqual([]);
    expect(t.s.files).toEqual([]);
  });
});
