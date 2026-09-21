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

const OSERVICE = 0x01;
const CLIENT_ONLINE = 0x02;
const BUDDY = 0x03;
const BUDDY_ADD = 0x04;

let flow: Flow | undefined;
afterEach(async () => { await flow?.stop(); flow = undefined; });

describe('/allowlist add', () => {
  it('admits the person on their next message with the same session, and tells the server about the new buddy', async () => {
    flow = await startFlow();
    const plugin = oscarPlugin as unknown as { reload: { noopPrefixes: string[] }; allowlist: { applyConfigEdit(p: Record<string, unknown>): unknown } };
    expect(plugin.reload.noopPrefixes).toContain('channels.oscar.allowFrom');
    const alice = flow.peer('alice');
    const mallory = flow.peer('mallory');
    mallory.sendIm('botone', 'let me in');
    await waitFor(() => alice.ims().length === 1);

    // What core's /allowlist handler does: clone the parsed file, let the plugin edit the clone, write it; the host then swaps its snapshot.
    const parsedConfig = structuredClone(flow.cfgRef.current);
    expect(plugin.allowlist.applyConfigEdit({ cfg: flow.cfgRef.current, parsedConfig, accountId: 'default', scope: 'dm', action: 'add', entry: 'Mallory' })).toMatchObject({ kind: 'ok', changed: true });
    flow.cfgRef.current = parsedConfig;

    sdk.agent = () => [{ text: 'welcome' }];
    mallory.sendIm('botone', 'hello again');
    await waitFor(() => mallory.ims().length === 1, 8000, 'the reply to the newly approved person');
    expect(mallory.ims()[0]?.text).toBe('welcome');
    expect(alice.ims()).toHaveLength(1);

    const fromBot = flow.server.snacsFrom('botone');
    expect(fromBot.filter((s) => s.conn === 'bos' && s.family === OSERVICE && s.subtype === CLIENT_ONLINE)).toHaveLength(1);
    expect(fromBot.some((s) => s.family === BUDDY && s.subtype === BUDDY_ADD && Buffer.from(s.body).toString('latin1').toLowerCase().includes('mallory'))).toBe(true);
  });
});
