import { beforeEach, describe, expect, it, vi } from 'vitest';

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

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/channel-core';
import { CHANNEL_ID, oscarPlugin } from '../../src/channel.js';
import { TOOL_NAMES } from '../../src/config.js';
import entry from '../../src/index.js';
import { liveConfig, resetRuntimeForTests } from '../../src/runtime.js';
import setupEntry from '../../src/setup-entry.js';

type Mode = OpenClawPluginApi['registrationMode'];

function fakeApi(mode: Mode) {
  const registerChannel = vi.fn();
  const tools: (string[] | undefined)[] = [];
  const info: string[] = [];
  const api = {
    registrationMode: mode,
    registerChannel,
    runtime: { config: { current: () => ({ live: true }) }, llm: { complete: async () => ({ text: '' }) } },
    on: () => undefined,
    agent: { events: { registerAgentEventSubscription: () => undefined } },
    registerTool: (_factory: unknown, opts?: { names?: string[] }) => { tools.push(opts?.names); },
    logger: { info: (message: string) => { info.push(message); }, warn: () => undefined, error: () => undefined },
  } as unknown as OpenClawPluginApi;
  return { api, registerChannel, tools, info };
}

beforeEach(() => resetRuntimeForTests());

describe('entry', () => {
  it('uses the channel id as the plugin id', () => {
    expect(CHANNEL_ID).toBe('oscar');
    expect(entry.id).toBe('oscar');
    expect(entry.channelPlugin).toBe(oscarPlugin);
  });

  it.each<[Mode, number]>([
    ['full', 1],
    ['discovery', 1],
    ['setup-only', 1],
    ['setup-runtime', 1],
    ['tool-discovery', 0],
    ['cli-metadata', 0],
  ])('in %s mode registers the channel %i time(s)', (mode, times) => {
    const { api, registerChannel } = fakeApi(mode);
    entry.register(api);
    expect(registerChannel).toHaveBeenCalledTimes(times);
    if (times > 0) expect(registerChannel).toHaveBeenCalledWith({ plugin: oscarPlugin });
  });

  it('setup entry exposes the same plugin object', () => {
    expect(setupEntry.plugin).toBe(oscarPlugin);
  });
});

describe('tools and host runtime', () => {
  it('registers three tool names and keeps the host runtime in full mode', () => {
    const t = fakeApi('full');
    entry.register(t.api);
    expect(t.tools).toEqual(TOOL_NAMES.map((n) => [n]));
    expect(liveConfig({ live: false })).toEqual({ live: true });
    expect(t.info).toHaveLength(1);
  });

  it('registers only tools in tool-discovery and touches nothing else', () => {
    const t = fakeApi('tool-discovery');
    entry.register(t.api);
    expect(t.tools).toEqual(TOOL_NAMES.map((n) => [n]));
    expect(liveConfig({ live: false })).toEqual({ live: false });
    expect(t.info).toEqual([]);
  });

  it.each<[Mode]>([['setup-only'], ['setup-runtime'], ['discovery']])('keeps the host runtime but registers no tools in %s', (mode) => {
    const t = fakeApi(mode);
    entry.register(t.api);
    expect(t.tools).toEqual([]);
    expect(liveConfig({ live: false })).toEqual({ live: true });
  });

  it('does nothing at all in cli-metadata', () => {
    const t = fakeApi('cli-metadata');
    entry.register(t.api);
    expect(t.tools).toEqual([]);
    expect(liveConfig({ live: false })).toEqual({ live: false });
  });
});
