import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('openclaw/plugin-sdk/channel-core', async () => (await import('../fake/openclaw.js')).channelCore);
vi.mock('openclaw/plugin-sdk/channel-outbound', async () => (await import('../fake/openclaw.js')).channelOutbound);
vi.mock('openclaw/plugin-sdk/channel-inbound', async () => (await import('../fake/openclaw.js')).channelInbound);
vi.mock('openclaw/plugin-sdk/reply-payload', async () => (await import('../fake/openclaw.js')).replyPayload);
vi.mock('openclaw/plugin-sdk/web-media', async () => (await import('../fake/openclaw.js')).webMedia);
vi.mock('openclaw/plugin-sdk/media-runtime', async () => (await import('../fake/openclaw.js')).mediaRuntime);
vi.mock('openclaw/plugin-sdk/agent-runtime', async () => (await import('../fake/openclaw.js')).agentRuntime);
vi.mock('openclaw/plugin-sdk/routing', async () => (await import('../fake/openclaw.js')).routing);
vi.mock('openclaw/plugin-sdk/session-store-runtime', async () => (await import('../fake/openclaw.js')).sessionStoreRuntime);
vi.mock('openclaw/plugin-sdk/conversation-runtime', async () => (await import('../fake/openclaw.js')).conversationRuntime);
vi.mock('openclaw/plugin-sdk/reply-dispatch-runtime', async () => (await import('../fake/openclaw.js')).replyDispatchRuntime);
vi.mock('openclaw/plugin-sdk/channel-ingress-runtime', async () => (await import('../fake/openclaw.js')).channelIngressRuntime);
vi.mock('openclaw/plugin-sdk/reply-chunking', async () => (await import('../fake/openclaw.js')).replyChunking);
vi.mock('openclaw/plugin-sdk/media-store', async () => (await import('../fake/openclaw.js')).mediaStore);
vi.mock('openclaw/plugin-sdk/status-helpers', async () => (await import('../fake/openclaw.js')).statusHelpers);

import { ICON_TIMING, iconFileFor } from '../../src/icon.js';
import { getRuntime } from '../../src/runtime.js';
import { ICON_JPEG, sdk } from '../fake/openclaw.js';
import { startFlow, waitFor } from './helpers.js';
import type { Flow } from './helpers.js';

const FEEDBAG = 0x13;
const BART = 0x10;
const LIST_WORK = [0x04, 0x08, 0x09, 0x0a];
const u32be = (n: number): number[] => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...u32be(13), ...Buffer.from('IHDR'), ...u32be(256), ...u32be(256), 8, 2, 0, 0, 0]);
const AVATAR = '/fake/agents/main/avatar.png';
const TIMING = { ...ICON_TIMING };

function seed(): void {
  sdk.avatar = { kind: 'local', filePath: AVATAR, source: 'config' };
  sdk.files.set(AVATAR, { buffer: PNG, contentType: 'image/png' });
}

// What the bot sent to read or write the server's list, or to upload an icon.
function iconWork(flow: Flow): number {
  return flow.server.snacsFrom('botone').filter((s) => s.conn !== 'auth' && (s.family === BART || (s.family === FEEDBAG && LIST_WORK.includes(s.subtype)))).length;
}

async function looked(count: number): Promise<void> {
  await waitFor(() => sdk.avatarAsks.length >= count, 8000, 'the bot to look at the avatar');
  await getRuntime('default')?.icon?.idle();
}

let flow: Flow | undefined;
afterEach(async () => {
  Object.assign(ICON_TIMING, TIMING);
  await flow?.stop();
  flow = undefined;
});

describe("the bot wears its agent's avatar", () => {
  it('another client sees the icon after sign-on, and a second sign-on sends nothing for it', async () => {
    rmSync(iconFileFor('default'), { force: true });
    ICON_TIMING.afterSignOnMs = 30;
    flow = await startFlow();
    seed();
    await looked(1);
    const icon = flow.server.iconOf('botone');
    expect(icon).not.toBeNull();
    const alice = flow.peer('alice');
    alice.watch('botone');
    await waitFor(() => alice.sightings().some((s) => s.name === 'botone' && s.event === 'arrived'), 8000, 'alice to see the bot');
    const seen = alice.sightings().filter((s) => s.name === 'botone').at(-1)?.icon;
    expect(typeof seen).toBe('string');
    expect(Buffer.from(flow.server.bartBlob(seen as string) ?? []).equals(ICON_JPEG)).toBe(true);
    const work = iconWork(flow);
    expect(work).toBeGreaterThan(0);

    await flow.restart();
    seed();
    await looked(2);
    expect(iconWork(flow)).toBe(work);
    expect(flow.server.iconOf('botone')).toEqual(icon);
  });

  it('with the setting off the bot sets no icon', async () => {
    ICON_TIMING.afterSignOnMs = 30;
    flow = await startFlow({ sec: { buddyIcon: false } });
    seed();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(sdk.avatarAsks).toEqual([]);
    expect(iconWork(flow)).toBe(0);
    expect(flow.server.iconOf('botone')).toBeNull();
  });
});
