import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

import { gatewayDeps, oscarPlugin, startAccount } from '../../src/channel.js';
import { resolveAccount } from '../../src/config.js';
import { copy } from '../../src/copy.js';
import { IM_TIMING } from '../../src/inbound/im.js';
import type { RoomRef } from '../../src/names.js';
import type { RoomMessageEvent } from '../../src/oscar/index.js';
import { toAsciiEntities, toWireHtml } from '../../src/oscar/text.js';
import { getRuntime, resetRuntimeForTests, roomsExt } from '../../src/runtime.js';
import { collectOscarIssues } from '../../src/status.js';
import { sdk } from '../fake/openclaw.js';
import { FakeSession } from '../fake/session.js';
import { flush } from './rooms-fixtures.js';

type Obj = Record<string, unknown>;
const ROOM: RoomRef = { exchange: 4, name: 'testroom' };
const KEY = 'room:4:testroom';
const DEN: RoomRef = { exchange: 4, name: 'bobsden' };
const plugin = oscarPlugin as unknown as Record<string, any>;
const deny = ['group:runtime', 'group:fs', 'group:automation', 'group:nodes', 'sessions_spawn'];

const cfg = (patch: Obj = {}): Obj => ({
  channels: { oscar: { host: 'oscar.example.net', tls: true, screenName: 'Bot One', password: 'hunter22', owners: ['alice'], allowFrom: ['bob'], room: { name: 'testroom' }, ...patch } },
});

function makeCtx(config: Obj, accountId = 'default') {
  const ac = new AbortController();
  let status: Obj = { accountId };
  const ctx = {
    cfg: config, accountId, account: resolveAccount(config, accountId), runtime: {}, abortSignal: ac.signal,
    log: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
    getStatus: () => status, setStatus: (next: Obj) => { status = next; },
  };
  return { ac, ctx: ctx as never };
}

const line = (from: string, text: string, over: Partial<RoomMessageEvent> = {}): RoomMessageEvent =>
  ({ room: ROOM, from, fromDisplay: from, text, cookie: 0n, whisper: false, serverGenerated: false, ...over });

let sessions: FakeSession[];
let running: { ac: AbortController; parked: Promise<void> }[];

async function start(config: Obj): Promise<FakeSession> {
  const t = makeCtx(config);
  running.push({ ac: t.ac, parked: startAccount(t.ctx) });
  await vi.waitFor(() => expect(sessions).toHaveLength(running.length));
  const s = sessions[sessions.length - 1] as FakeSession;
  s.setState({ phase: 'online' });
  return s;
}

beforeEach(() => {
  sdk.reset();
  resetRuntimeForTests();
  sessions = [];
  running = [];
  gatewayDeps.createSession = (() => { const s = new FakeSession(); sessions.push(s); return s.asSession(); }) as typeof gatewayDeps.createSession;
  Object.assign(IM_TIMING, { debounceMs: 0, replyCooldownMs: 0 });
  sdk.usePlugin(oscarPlugin);
});

afterEach(async () => {
  for (const r of running) {
    r.ac.abort();
    await r.parked;
  }
  Object.assign(IM_TIMING, { debounceMs: 2000, replyCooldownMs: 2000 });
});

describe('rooms in the gateway', () => {
  it('joins the home room persistently once online', async () => {
    const s = await start(cfg());
    await vi.waitFor(() => expect(s.joins).toEqual([{ room: ROOM, persistent: true }]));
  });

  it('joins nothing without a configured room', async () => {
    const bare = await start({ channels: { oscar: { ...(cfg().channels as { oscar: Obj }).oscar, room: undefined } } });
    await flush();
    expect(bare.joins).toEqual([]);
  });

  it('records a line without a run, then wakes for the owner and answers into the room', async () => {
    const s = await start(cfg());
    sdk.agent = () => [{ text: 'café **ok**' }];
    s.emit('roomReady', { room: ROOM, occupants: ['botone', 'alice', 'bob'] });
    s.emit('roomMessage', line('bob', 'hello all', { cookie: 1n }));
    const rt = getRuntime('default');
    await vi.waitFor(() => expect(rt && roomsExt(rt).history.get(KEY)).toHaveLength(1));
    expect(sdk.inbound).toEqual([]);

    s.emit('roomMessage', line('alice', 'what now?', { cookie: 2n }));
    await vi.waitFor(() => expect(sdk.inbound).toHaveLength(1));
    expect(sdk.inbound[0]?.ctx).toMatchObject({
      ChatType: 'group',
      SessionKey: 'agent:main:oscar:group:botone#4.testroom',
      WasMentioned: true,
      CommandAuthorized: true,
      Body: 'what now?',
      To: KEY,
      InboundHistory: [{ sender: 'bob (approved)', body: 'hello all' }],
    });
    expect(String(sdk.inbound[0]?.ctx.GroupSystemPrompt)).toContain('routed to you on purpose');
    await vi.waitFor(() => expect(s.roomSent).toEqual([
      { room: ROOM, html: toAsciiEntities(toWireHtml('café **ok**')), whisperTo: undefined, priority: 'reply' },
    ]));
    expect(s.sent).toEqual([]);
  });

  it('keeps a link whole in a long room answer', async () => {
    const s = await start(cfg());
    const link = '<A HREF="http://example.net/a/b/c">docs</A>';
    sdk.agent = () => [{ text: `${'word '.repeat(355)}[docs](http://example.net/a/b/c) and the tail` }];
    s.emit('roomReady', { room: ROOM, occupants: ['botone', 'alice'] });
    s.emit('roomMessage', line('alice', 'where are the docs?', { cookie: 3n }));
    await vi.waitFor(() => expect(s.roomSent.length).toBeGreaterThanOrEqual(3));
    await flush();
    expect(s.roomSent.every((m) => m.html.length <= 900)).toBe(true);
    expect(s.roomSent.filter((m) => m.html.includes(link))).toHaveLength(1);
    expect(s.roomSent.map((m) => m.html).join(' ')).toContain('and the tail');
  });

  it('lets the message tool reach a joined room and refuses one it is not in', async () => {
    const s = await start(cfg());
    s.emit('roomReady', { room: ROOM, occupants: ['botone', 'alice'] });
    await sdk.messageTool({ cfg: cfg(), accountId: 'default', to: 'room:testroom', text: 'hi room' });
    expect(s.roomSent.map((m) => m.html)).toEqual([toAsciiEntities(toWireHtml('hi room'))]);
    await expect(sdk.messageTool({ cfg: cfg(), accountId: 'default', to: 'room:4:elsewhere', text: 'x' })).rejects.toThrow('not in room elsewhere');
    s.emit('roomClosed', { room: ROOM, willRejoin: true });
    await expect(sdk.messageTool({ cfg: cfg(), accountId: 'default', to: 'room:testroom', text: 'x' })).rejects.toThrow('not in room testroom');
  });

  it('joins for an approved inviter and turns a stranger\'s invite into an owner notice', async () => {
    const s = await start(cfg());
    s.setPresence('alice', { online: true });
    s.emit('invite', { from: 'bob', fromDisplay: 'Bob', room: DEN, roomCookie: '4-0-bobsden', text: '' });
    await vi.waitFor(() => expect(s.invitedJoins).toHaveLength(1));
    s.emit('invite', { from: 'mallory', fromDisplay: 'Mallory', room: DEN, roomCookie: '4-0-bobsden', text: 'psst' });
    await vi.waitFor(() => expect(sdk.durable).toHaveLength(1));
    const params = sdk.durable[0]?.params as { to: string; payloads: { text: string }[] };
    expect(params.to).toBe('alice');
    expect(params.payloads[0]?.text).toContain(copy.noticeInvite('mallory'));
    expect(params.payloads[0]?.text).not.toContain('psst');
    expect(s.invitedJoins).toHaveLength(1);
    expect(s.sent.filter((m) => m.to === 'mallory')).toEqual([]);
  });

  it('tells online owners about an unlisted join and stores nothing for offline ones', async () => {
    const s = await start(cfg({ owners: ['alice', 'carol'] }));
    s.setPresence('alice', { online: true });
    s.emit('roomReady', { room: ROOM, occupants: ['botone', 'alice'] });
    s.emit('roomJoin', { room: ROOM, name: 'mallory', display: 'Mallory' });
    await vi.waitFor(() => expect(sdk.durable).toHaveLength(1));
    const params = sdk.durable[0]?.params as { to: string; payloads: { text: string }[] };
    expect(params.to).toBe('alice');
    expect(params.payloads[0]?.text).toBe(copy.unlistedJoin('Mallory', 'testroom'));
    await flush();
    expect(sdk.durable.map((d) => (d.params as { to: string }).to)).toEqual(['alice']);
  });

  it('stops listening when the account stops', async () => {
    const s = await start(cfg());
    s.emit('roomReady', { room: ROOM, occupants: ['botone', 'alice'] });
    const r = running.pop();
    r?.ac.abort();
    await r?.parked;
    s.emit('roomMessage', line('alice', 'anyone?'));
    await flush();
    expect(sdk.inbound).toEqual([]);
  });
});

describe('room policy and status', () => {
  it('matches a channel-typed sender key and keeps the built-in deny first', () => {
    const c = cfg({ rooms: { testroom: { toolsBySender: { 'channel:oscar:Bob': { deny: ['browser'] }, '*': { deny: ['web_fetch'] } } } } });
    expect(plugin.groups.resolveToolPolicy({ cfg: c, groupId: 'botone#4.testroom', senderId: 'bob' })).toEqual({ deny: [...deny, 'browser'] });
    expect(plugin.groups.resolveToolPolicy({ cfg: c, groupId: 'botone#4.testroom', senderId: 'alice' })).toEqual({ deny: ['web_fetch'] });
    expect(plugin.groups.resolveToolPolicy({ cfg: c, groupId: 'botone#4.testroom', senderId: undefined })).toEqual({ deny: [...deny, 'web_fetch'] });
    expect(plugin.groups.resolveToolPolicy({ cfg: c, groupId: 'botone/bob', senderId: 'bob' })).toEqual({ deny });
  });

  it('lists room issues with the other status issues', async () => {
    const config = cfg({ room: { name: 'testroom', exchange: 5 } });
    const s = await start(config);
    await vi.waitFor(() => expect(s.joins).toHaveLength(1));
    const rt = getRuntime('default');
    if (rt) roomsExt(rt).home = { status: 'missing', detail: 'no such room' };
    const messages = collectOscarIssues({ cfg: config, account: resolveAccount(config, 'default') }).map((i) => i.message);
    expect(messages).toContain('home room testroom does not exist on exchange 5');
  });
});
