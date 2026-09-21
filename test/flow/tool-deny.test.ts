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

import { oscarPlugin } from '../../src/channel.js';
import { sdk } from '../fake/openclaw.js';
import { startFlow, waitFor } from './helpers.js';
import type { Flow } from './helpers.js';

let flow: Flow | undefined;
afterEach(async () => { await flow?.stop(); flow = undefined; });

describe('non-owner tool deny', () => {
  it('denies shell and file tools for the approved person and nothing for the owner, from the session key alone', async () => {
    flow = await startFlow();
    sdk.agent = () => [{ text: 'ok' }];
    flow.peer('bob').sendIm('botone', 'hi');
    flow.peer('alice').sendIm('botone', 'hi');
    await waitFor(() => sdk.inbound.length === 2);
    const groups = (oscarPlugin as unknown as { groups: { resolveToolPolicy(p: Record<string, unknown>): unknown } }).groups;
    // Core derives the group id from the session key's peer id.
    const groupIdOf = (from: string) => String(sdk.inbound.find((r) => r.ctx.SenderId === from)?.turn.routeSessionKey).replace('agent:main:oscar:group:', '');
    const deny = ['group:runtime', 'group:fs', 'group:automation', 'group:nodes', 'sessions_spawn'];
    expect(groups.resolveToolPolicy({ cfg: flow.cfgRef.current, groupId: groupIdOf('bob'), accountId: 'default', senderId: 'bob' })).toEqual({ deny });
    expect(groups.resolveToolPolicy({ cfg: flow.cfgRef.current, groupId: groupIdOf('bob'), accountId: 'default' })).toEqual({ deny });
    expect(groups.resolveToolPolicy({ cfg: flow.cfgRef.current, groupId: groupIdOf('alice'), accountId: 'default', senderId: 'alice' })).toBeUndefined();
  });
});
