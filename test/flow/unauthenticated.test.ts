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
import { getRuntime } from '../../src/runtime.js';
import { sdk } from '../fake/openclaw.js';
import { startFlow, waitFor } from './helpers.js';
import type { Flow } from './helpers.js';

let flow: Flow | undefined;
afterEach(async () => { await flow?.stop(); flow = undefined; });
const plugin = oscarPlugin as unknown as { heartbeat: { checkReady(p: Record<string, unknown>): Promise<{ ok: boolean; reason: string }> } };

describe('unauthenticated server', () => {
  it('is refused: the account halts, says why, and answers nobody', async () => {
    flow = await startFlow({ server: { disableAuth: true }, expectOnline: false });
    await waitFor(() => getRuntime('default')?.halted !== undefined, 15_000, 'the halt');
    expect(getRuntime('default')?.halted?.reason).toBe('unauthenticated-server');
    expect(String(flow.status().lastError)).toContain('unauthenticated-server');
    expect(flow.status()).toMatchObject({ connected: false, running: false });
    expect(await plugin.heartbeat.checkReady({ cfg: flow.cfgRef.current })).toEqual({ ok: false, reason: 'unauthenticated-server' });
    await waitFor(() => ['fatal', 'stopped'].includes(getRuntime('default')?.session.getState().phase ?? ''), 8000, 'the session to be down');
    sdk.agent = () => [{ text: 'should never be sent' }];
    const bob = flow.peer('bob');
    bob.sendIm('botone', 'anyone home?');
    expect(sdk.inbound).toEqual([]);
    expect(bob.ims()).toEqual([]);
  });

  it('runs when the operator set the dangerous flag, and status still says so', async () => {
    flow = await startFlow({ server: { disableAuth: true }, sec: { dangerouslyAllowUnauthenticatedServer: true } });
    await waitFor(() => getRuntime('default')?.probe?.result === 'does-not-check', 15_000, 'the probe result');
    expect(getRuntime('default')?.halted).toBeUndefined();
    expect((await plugin.heartbeat.checkReady({ cfg: flow.cfgRef.current })).ok).toBe(true);
  });
});
