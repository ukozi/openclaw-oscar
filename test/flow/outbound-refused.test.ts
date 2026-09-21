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
import { snacsReferencing, startFlow, waitFor } from './helpers.js';
import type { Flow } from './helpers.js';

let flow: Flow | undefined;
afterEach(async () => { await flow?.stop(); flow = undefined; });

describe('outbound to an unlisted name', () => {
  it('is a tool error and reaches no wire; a listed name works', async () => {
    flow = await startFlow();
    const send = (to: string) => sdk.messageTool({ cfg: flow?.cfgRef.current, accountId: 'default', to, text: 'hello' });
    await expect(send('mallory')).rejects.toThrow('mallory is not in owners or allowFrom');
    await expect(send('bottwo/bob')).rejects.toThrow('not a screen name or room');
    await expect(send('room:4:testroom')).rejects.toThrow('not in room testroom');
    const bob = flow.peer('bob');
    await send('Bob');
    await waitFor(() => bob.ims().length === 1);
    expect(snacsReferencing(flow.server, 'botone', 'mallory')).toEqual([]);
  });

  it('allowUnlisted lifts the IM half only', async () => {
    flow = await startFlow({ sec: { outbound: { allowUnlisted: true } } });
    const mallory = flow.peer('mallory');
    await sdk.messageTool({ cfg: flow.cfgRef.current, accountId: 'default', to: 'mallory', text: 'hello' });
    await waitFor(() => mallory.ims().length === 1);
    await expect(sdk.messageTool({ cfg: flow.cfgRef.current, accountId: 'default', to: 'room:testroom', text: 'x' })).rejects.toThrow('not in room');
  });
});
