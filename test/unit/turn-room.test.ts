import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('openclaw/plugin-sdk/channel-inbound', async () => (await import('../fake/openclaw.js')).channelInbound);
vi.mock('openclaw/plugin-sdk/routing', async () => (await import('../fake/openclaw.js')).routing);
vi.mock('openclaw/plugin-sdk/session-store-runtime', async () => (await import('../fake/openclaw.js')).sessionStoreRuntime);
vi.mock('openclaw/plugin-sdk/conversation-runtime', async () => (await import('../fake/openclaw.js')).conversationRuntime);
vi.mock('openclaw/plugin-sdk/reply-dispatch-runtime', async () => (await import('../fake/openclaw.js')).replyDispatchRuntime);
vi.mock('openclaw/plugin-sdk/reply-chunking', async () => (await import('../fake/openclaw.js')).replyChunking);
vi.mock('openclaw/plugin-sdk/channel-reply-pipeline', async () => (await import('../fake/openclaw.js')).channelReplyPipeline);

import type { TurnRequest } from '../../src/inbound/room.js';
import { dispatchImTurn, dispatchRoomTurn } from '../../src/inbound/turn.js';
import type { RoomTurnDeps } from '../../src/inbound/turn.js';
import { setOutboundTextFilter } from '../../src/outbound.js';
import { applyRoomReady, getRuntime, resetRuntimeForTests, roomsExt, setRuntime, touchActivity } from '../../src/runtime.js';
import { sdk } from '../fake/openclaw.js';
import { fakeSession, makeRt, silentLog } from './rooms-fixtures.js';

const KEY = 'agent:main:oscar:group:botone#4.testroom';
const runs: [string, string][] = [];
let cfg: Record<string, unknown>;

const deps = (): RoomTurnDeps => ({
  accountId: 'botone',
  getCfg: () => cfg,
  log: silentLog,
  onRunStart: (runId, sessionKey) => runs.push([runId, sessionKey]),
});

function request(over: Partial<TurnRequest> = {}): TurnRequest {
  return {
    accountId: 'botone',
    peer: { kind: 'room', bot: 'botone', room: { exchange: 4, name: 'testroom' } },
    origin: 'owner',
    sender: { name: 'alice', display: 'alice', role: 'owner' },
    messageId: 'room:4:testroom:alice:1',
    timestamp: 1_000_000,
    text: 'what now?',
    commandAuthorized: true,
    untrustedContext: [{ label: 'Room', source: 'oscar', type: 'room', payload: { room: 'room:4:testroom', occupants: [] } }],
    group: { label: 'testroom', systemPrompt: 'PROMPT', history: [{ sender: 'bob (approved)', body: 'earlier', timestamp: 999_000 }] },
    ...over,
  };
}

beforeEach(() => {
  sdk.reset();
  resetRuntimeForTests();
  runs.length = 0;
  cfg = { channels: { oscar: { host: 'h', screenName: 'botone', password: 'hunter22', owners: ['alice'], allowFrom: ['bob'] } } };
  setRuntime(makeRt(fakeSession().session));
});

describe('room turn', () => {
  it('is a group chat on the room session, mentioned, with the prompt and the history', async () => {
    await dispatchRoomTurn(request(), deps());
    expect(sdk.routes[0]).toMatchObject({ channel: 'oscar', accountId: 'botone', peer: { kind: 'group', id: 'botone#4.testroom' } });
    expect(sdk.inbound[0]?.ctx).toMatchObject({
      ChatType: 'group',
      ChatId: 'botone#4.testroom',
      SessionKey: KEY,
      ConversationLabel: 'testroom',
      GroupSubject: 'testroom',
      WasMentioned: true,
      GroupSystemPrompt: 'PROMPT',
      InboundHistory: [{ sender: 'bob (approved)', body: 'earlier', timestamp: 999_000 }],
      From: 'oscar:alice',
      To: 'room:4:testroom',
      OriginatingTo: 'room:4:testroom',
      OriginatingChannel: 'oscar',
      AccountId: 'botone',
      SenderId: 'alice',
      Body: 'what now?',
      CommandBody: 'what now?',
      CommandAuthorized: true,
      OwnerAllowFrom: ['alice'],
      MessageSid: 'room:4:testroom:alice:1',
      ChannelContext: { sender: { id: 'alice' }, chat: { id: 'botone#4.testroom', accountId: 'botone', kind: 'room' } },
      UntrustedStructuredContext: [{ label: 'Room', type: 'room' }],
    });
    expect(sdk.inbound[0]?.input).toMatchObject({ id: 'room:4:testroom:alice:1', rawText: 'what now?', timestamp: 1_000_000 });
  });

  it('passes the reply options, reports the run and binds the session key to the room', async () => {
    await dispatchRoomTurn(request(), deps());
    const turn = sdk.inbound[0]?.turn as { replyOptions: Record<string, unknown>; dispatcherOptions?: unknown; routeSessionKey: string };
    expect(turn.replyOptions).toMatchObject({ disableBlockStreaming: true, sourceReplyDeliveryMode: 'automatic' });
    expect(turn.dispatcherOptions).toBeUndefined();
    expect(turn.routeSessionKey).toBe(KEY);
    expect(runs).toEqual([['run-1', KEY]]);
    expect(getRuntime('botone')?.sessionKeys.get(KEY)).toEqual({
      accountId: 'botone',
      peer: { kind: 'room', bot: 'botone', room: { exchange: 4, name: 'testroom' } },
    });
  });

  it('carries the command flag as given and marks a roster sender as a bot', async () => {
    await dispatchRoomTurn(
      request({ commandAuthorized: false, origin: 'bot', sender: { name: 'bottwo', display: 'bottwo', role: 'bot' } }),
      deps(),
    );
    expect(sdk.inbound[0]?.ctx).toMatchObject({ CommandAuthorized: false, SenderIsBot: true, SenderId: 'bottwo' });
  });

  it('hands loop protection facts to core', async () => {
    const facts = { scopeId: 'botone', conversationId: 'room:4:testroom', senderId: 'bottwo', receiverId: 'botone', defaultEnabled: true };
    await dispatchRoomTurn(request({ botLoopProtection: facts }), deps());
    expect((sdk.inbound[0]?.turn as { botLoopProtection?: unknown }).botLoopProtection).toEqual(facts);
    await dispatchRoomTurn(request(), deps());
    expect('botLoopProtection' in (sdk.inbound[1]?.turn as object)).toBe(false);
  });

  it('shows the outbound filter each room reply with the kind the host gave it', async () => {
    const rt = getRuntime('botone');
    if (!rt) throw new Error('no runtime');
    applyRoomReady(rt, { exchange: 4, name: 'testroom' }, ['botone', 'alice'], 'botone', 1_000_000);
    const seen: string[] = [];
    setOutboundTextFilter('botone', (meta) => {
      seen.push(`${meta.kind}:${meta.format}:${meta.target.kind}`);
      return null;
    });
    sdk.agent = () => [{ text: 'a block', kind: 'block' }, { text: 'an answer' }];
    try {
      await dispatchRoomTurn(request(), deps());
    } finally {
      setOutboundTextFilter('botone', null);
    }
    expect(seen).toEqual(['block:markdown:room', 'final:markdown:room']);
  });

  it('refuses a request that is not a room turn', async () => {
    await expect(dispatchRoomTurn(request({ group: undefined }), deps())).rejects.toThrow('room turn');
    await expect(dispatchRoomTurn(request({ peer: { kind: 'im', bot: 'botone', peer: 'alice' } }), deps())).rejects.toThrow('room turn');
    expect(sdk.inbound).toEqual([]);
  });
});

describe('IM turns and the digest', () => {
  const imDeps = () => ({ accountId: 'botone', self: () => 'botone', getCfg: () => cfg, now: () => 1_000_000, log: silentLog, ring: () => [] });
  const im = (from: string) => ({ from, fromDisplay: from, text: 'hello', cookie: 7n, at: 999_000 });
  const types = () => ((sdk.inbound[0]?.ctx.UntrustedStructuredContext ?? []) as { type?: string; payload: unknown }[]);

  it('gives an owner the digest of the other conversations and notes the activity', async () => {
    const rt = getRuntime('botone');
    if (rt) touchActivity(rt, 'bob', 5);
    await dispatchImTurn(im('alice'), imDeps());
    expect(types().find((e) => e.type === 'awareness')?.payload).toMatchObject({ directMessages: [{ target: 'bob', lastActivityAt: 5 }] });
    expect(rt && roomsExt(rt).activity.get('alice')).toBe(1_000_000);
  });

  it('gives an approved person no digest', async () => {
    const rt = getRuntime('botone');
    if (rt) touchActivity(rt, 'alice', 5);
    await dispatchImTurn(im('bob'), imDeps());
    expect(types().some((e) => e.type === 'awareness')).toBe(false);
  });
});
