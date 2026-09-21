import { beforeEach, describe, expect, it } from 'vitest';
import { channelCore, channelInbound, channelIngressRuntime, channelOutbound, routing, sdk } from '../fake/openclaw.js';
import { FakeSession } from '../fake/session.js';

type Fn = (...args: unknown[]) => unknown;
const call = (mod: Record<string, unknown>, name: string) => mod[name] as Fn;

beforeEach(() => sdk.reset());

describe('fake sdk', () => {
  it('collapses a direct peer into the main session key', () => {
    const route = call(routing, 'resolveAgentRoute')({ cfg: {}, channel: 'oscar', accountId: 'botone', peer: { kind: 'direct', id: 'alice' } }) as { sessionKey: string };
    expect(route.sessionKey).toBe('agent:main:main');
  });

  it('keys a group peer by channel and lowercased id and honours an account binding', () => {
    const cfg = { bindings: [{ agentId: 'helper', match: { channel: 'oscar', accountId: 'botone' } }] };
    const route = call(routing, 'resolveAgentRoute')({ cfg, channel: 'oscar', accountId: 'botone', peer: { kind: 'group', id: 'BotOne/Alice' } }) as { sessionKey: string; agentId: string };
    expect(route.agentId).toBe('helper');
    expect(route.sessionKey).toBe('agent:helper:oscar:group:botone/alice');
  });

  it('defaults a missing dmPolicy to pairing', async () => {
    const res = await call(channelIngressRuntime, 'resolveStableChannelMessageIngress')({
      channelId: 'oscar', accountId: 'botone', subject: { stableId: 'mallory' },
      conversation: { kind: 'direct', id: 'mallory' }, allowFrom: ['alice'],
    }) as { senderAccess: { decision: string } };
    expect(res.senderAccess.decision).toBe('pairing');
  });

  it('blocks a stranger under allowlist with mayPair false and admits a listed name through the normaliser', async () => {
    const base = {
      channelId: 'oscar', accountId: 'botone', dmPolicy: 'allowlist', groupPolicy: 'disabled',
      identity: { normalize: (v: string) => v.replace(/ /g, '').toLowerCase() },
      event: { kind: 'message', authMode: 'inbound', mayPair: false }, allowFrom: ['Alice B'],
    };
    const resolve = call(channelIngressRuntime, 'resolveStableChannelMessageIngress');
    const no = await resolve({ ...base, subject: { stableId: 'mallory' }, conversation: { kind: 'direct', id: 'mallory' } }) as { senderAccess: { decision: string }; ingress: { admission: string } };
    const yes = await resolve({ ...base, subject: { stableId: 'aliceb' }, conversation: { kind: 'direct', id: 'aliceb' } }) as { senderAccess: { decision: string } };
    expect(no.senderAccess.decision).toBe('block');
    expect(no.ingress.admission).toBe('drop');
    expect(yes.senderAccess.decision).toBe('allow');
    expect(sdk.ingress).toHaveLength(2);
  });

  it('admits a stranger under open only when the list holds a star', async () => {
    const base = {
      channelId: 'oscar', accountId: 'botone', dmPolicy: 'open', groupPolicy: 'disabled',
      event: { kind: 'message', authMode: 'inbound', mayPair: false },
      subject: { stableId: 'mallory' }, conversation: { kind: 'direct', id: 'mallory' },
    };
    const resolve = call(channelIngressRuntime, 'resolveStableChannelMessageIngress');
    const bare = await resolve({ ...base, allowFrom: ['alice'] }) as { senderAccess: { decision: string } };
    const starred = await resolve({ ...base, allowFrom: ['alice', '*'] }) as { senderAccess: { decision: string } };
    expect(bare.senderAccess.decision).toBe('block');
    expect(starred.senderAccess.decision).toBe('allow');
  });

  it('runs a turn: ingest, resolve, run start, deliver each reply', async () => {
    const delivered: string[] = [];
    const started: string[] = [];
    sdk.agent = () => [{ text: 'one' }, { text: 'two' }];
    await call(channelInbound, 'runChannelInboundEvent')({
      channel: 'oscar', accountId: 'botone', raw: { n: 1 },
      adapter: {
        ingest: () => ({ id: 'm1', rawText: 'hi' }),
        resolveTurn: () => ({
          routeSessionKey: 'agent:main:oscar:group:botone/alice', ctxPayload: { Body: 'hi' },
          replyOptions: { onAgentRunStart: (id: string) => started.push(id) },
          delivery: { deliver: async (p: { text: string }) => { delivered.push(p.text); } },
        }),
      },
    });
    expect(delivered).toEqual(['one', 'two']);
    expect(started).toEqual(['run-1']);
    expect(sdk.sessions.has('agent:main:oscar:group:botone/alice')).toBe(true);
  });

  it('maps context fields the way core does', () => {
    const ctx = call(channelInbound, 'buildChannelInboundEventContext')({
      channel: 'oscar', accountId: 'botone', from: 'oscar:alice',
      sender: { id: 'alice', name: 'Alice' }, conversation: { kind: 'direct', id: 'botone/alice', label: 'alice' },
      route: { agentId: 'main', accountId: 'botone', routeSessionKey: 'k' }, reply: { to: 'alice' },
      message: { rawBody: 'hi', bodyForAgent: 'hi there' }, access: { commands: { authorized: true } },
      supplemental: { untrustedContext: [{ label: 'x', payload: 1 }] }, extra: { OwnerAllowFrom: ['alice'] },
    }) as Record<string, unknown>;
    expect(ctx).toMatchObject({
      Body: 'hi', RawBody: 'hi', BodyForAgent: 'hi there', CommandBody: 'hi', From: 'oscar:alice', To: 'alice',
      SessionKey: 'k', AccountId: 'botone', ChatType: 'direct', ChatId: 'botone/alice', SenderId: 'alice',
      CommandAuthorized: true, OriginatingChannel: 'oscar', OriginatingTo: 'alice', OwnerAllowFrom: ['alice'],
    });
    expect(ctx.UntrustedStructuredContext).toEqual([{ label: 'x', payload: 1 }]);
    expect(ctx.ConversationLabel).toBe('alice');
    expect(ctx.GroupSubject).toBeUndefined();
  });

  it('sends a durable batch through the plugin adapter and flags a mirror without a session', async () => {
    const sent: string[] = [];
    sdk.usePlugin({ outbound: { sanitizeText: ({ text }: { text: string }) => text.toUpperCase(), sendText: async ({ text }: { text: string }) => { sent.push(text); return { messageId: '1' }; } } });
    const res = await call(channelOutbound, 'sendDurableMessageBatch')({
      cfg: {}, channel: 'oscar', to: 'alice', accountId: 'botone', payloads: [{ text: 'hello' }], mirror: { sessionKey: 'nope' },
    }) as { status: string };
    expect(res.status).toBe('sent');
    expect(sent).toEqual(['HELLO']);
    expect(sdk.durable[0]?.mirrorFailed).toBe(true);
  });

  it('registers by mode like core', () => {
    const seen: string[] = [];
    const entry = call(channelCore, 'defineChannelPluginEntry')({
      id: 'oscar', name: 'n', description: 'd', plugin: { id: 'oscar' },
      setRuntime: () => seen.push('runtime'), registerFull: () => seen.push('full'),
    }) as { register(api: unknown): void };
    const api = (registrationMode: string) => ({ registrationMode, runtime: {}, registerChannel: () => seen.push('channel') });
    entry.register(api('tool-discovery'));
    expect(seen).toEqual(['full']);
    seen.length = 0;
    entry.register(api('setup-only'));
    expect(seen).toEqual(['channel', 'runtime']);
    seen.length = 0;
    entry.register(api('full'));
    expect(seen).toEqual(['channel', 'runtime', 'full']);
  });
});

describe('fake session', () => {
  it('records sends, fails once on demand, and fans out events', async () => {
    const s = new FakeSession();
    const got: string[] = [];
    const off = s.asSession().on('im', (ev) => got.push(ev.text));
    s.emit('im', { from: 'alice', fromDisplay: 'Alice', text: 'hi', cookie: 1n, autoResponse: false, offline: false, system: false });
    off();
    s.emit('im', { from: 'alice', fromDisplay: 'Alice', text: 'again', cookie: 2n, autoResponse: false, offline: false, system: false });
    expect(got).toEqual(['hi']);
    await s.asSession().sendIm('alice', '<B>x</B>', { priority: 'notice' });
    expect(s.sent).toEqual([{ to: 'alice', html: '<B>x</B>', priority: 'notice' }]);
    s.failNext = new Error('boom');
    await expect(s.asSession().sendIm('alice', 'y')).rejects.toThrow('boom');
    await expect(s.asSession().sendIm('alice', 'z')).resolves.toMatchObject({ storedOffline: true });
    s.setPresence('alice', { online: true });
    await expect(s.asSession().sendIm('alice', 'z')).resolves.toMatchObject({ storedOffline: false });
  });

  it('tracks presence and state', () => {
    const s = new FakeSession();
    expect(s.asSession().presenceOf('alice')).toBeUndefined();
    s.setPresence('alice', { online: true });
    expect(s.asSession().presenceOf('alice')?.online).toBe(true);
    s.setState({ phase: 'online' });
    expect(s.asSession().getState().phase).toBe('online');
  });
});
