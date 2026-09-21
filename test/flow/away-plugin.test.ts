import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

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
vi.mock('openclaw/plugin-sdk/channel-lifecycle', async () => (await import('../fake/openclaw.js')).channelLifecycleMock());

import { oscarPlugin } from '../../src/channel.js';

const cfg = {
  channels: {
    oscar: {
      enabled: true, host: 'oscar.example.net', port: 5190,
      owners: ['alice'], allowFrom: ['alice', 'bob'],
      accounts: { botone: { screenName: 'botone', password: 'hunter22' } },
      defaultAccount: 'botone',
    },
  },
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

describe('presence in the plugin', () => {
  it('declares oscar_status in the manifest', () => {
    const manifest = JSON.parse(readFileSync('openclaw.plugin.json', 'utf8')) as { contracts?: { tools?: string[] } };
    expect(manifest.contracts?.tools).toContain('oscar_status');
  });

  it('offers set-presence with awayMessage on the message tool', () => {
    const described = oscarPlugin.actions?.describeMessageTool({ cfg: cfg as never, accountId: 'botone' });
    expect(described?.actions).toContain('set-presence');
    expect(JSON.stringify(described?.schema)).toContain('awayMessage');
  });

  it('tells the agent how to set the line', () => {
    const hints = oscarPlugin.agentPrompt?.messageToolHints?.({ cfg: cfg as never, accountId: 'botone' }) ?? [];
    expect(hints.join(' ')).toContain('oscar_status');
  });

  it('binds presence at every place a session key is recorded', () => {
    const binders = sourceFiles('src').filter((path) => readFileSync(path, 'utf8').includes('sessionKeys.set('));
    expect(binders.length).toBeGreaterThan(0);
    for (const path of binders) {
      expect(readFileSync(path, 'utf8'), path).toContain('presenceDispatch(');
    }
  });
});
