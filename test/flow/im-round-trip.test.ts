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

import { sdk } from '../fake/openclaw.js';
import { startFlow, waitFor } from './helpers.js';
import type { Flow } from './helpers.js';

let flow: Flow | undefined;
afterEach(async () => { await flow?.stop(); flow = undefined; });

describe('approved IM round trip', () => {
  it('answers an approved person and an owner, with command authority only for the owner', async () => {
    flow = await startFlow();
    sdk.agent = (ctx) => [{ text: `you said: ${String(ctx.Body)}` }];
    const bob = flow.peer('bob');
    const alice = flow.peer('alice');
    bob.sendIm('botone', 'hello there');
    await waitFor(() => bob.ims().length === 1, 8000, 'the reply to bob');
    expect(bob.ims()[0]).toMatchObject({ from: 'botone', text: 'you said: hello there' });
    alice.sendIm('botone', '/status');
    await waitFor(() => alice.ims().length === 1, 8000, 'the reply to alice');
    const byFrom = Object.fromEntries(sdk.inbound.map((r) => [String(r.ctx.SenderId), r.ctx]));
    expect(byFrom.bob).toMatchObject({ CommandAuthorized: false, ChatType: 'direct', SessionKey: 'agent:main:oscar:group:botone/bob' });
    expect(byFrom.alice).toMatchObject({ CommandAuthorized: true, SessionKey: 'agent:main:oscar:group:botone/alice', OwnerAllowFrom: ['alice'] });
  });

  it('joins a quick burst into one turn and decodes a UTF-16 message', async () => {
    flow = await startFlow();
    sdk.agent = () => [{ text: 'ok' }];
    const bob = flow.peer('bob');
    bob.sendIm('botone', 'one');
    bob.sendIm('botone', 'café ☃', { charset: 2 });
    await waitFor(() => bob.ims().length === 1, 8000, 'the reply to the burst');
    bob.sendIm('botone', 'three');
    await waitFor(() => bob.ims().length === 2, 8000, 'the reply to the next message');
    expect(sdk.inbound.map((r) => r.ctx.Body)).toEqual(['one\ncafé ☃', 'three']);
  });
});
