import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('openclaw/plugin-sdk/reply-chunking', async () => (await import('../fake/openclaw.js')).replyChunking);
vi.mock('openclaw/plugin-sdk/channel-outbound', async () => (await import('../fake/openclaw.js')).channelOutbound);

import { createOscarSession, type OscarSession } from '../../src/oscar/index.js';
import { sendMarkdown } from '../../src/outbound.js';
import { resetRuntimeForTests, setRuntime } from '../../src/runtime.js';
import { FakeOscarServer } from '../fake/oscar-server.js';
import { sdk } from '../fake/openclaw.js';
import { quietLog } from '../fake/stub-session.js';

const ICBM = 0x0004;
const ICBM_MSG_TO_HOST = 0x0006;

const cfg = {
  channels: {
    oscar: {
      host: '127.0.0.1', screenName: 'botone', password: 'hunter22', owners: ['alice'],
      fallback: [{ screenName: 'alice', channel: 'signal', to: 'c1072e4a' }],
    },
  },
};

function imsTo(server: FakeOscarServer, name: string): number {
  return server
    .snacsFrom('botone')
    .filter((snac) => snac.conn === 'bos' && snac.family === ICBM && snac.subtype === ICBM_MSG_TO_HOST)
    .filter((snac) => new TextDecoder().decode(snac.body.subarray(11, 11 + (snac.body[10] ?? 0))) === name)
    .length;
}

describe('the fallback on the wire', () => {
  let server: FakeOscarServer;
  let session: OscarSession;

  beforeEach(async () => {
    sdk.reset();
    resetRuntimeForTests();
    server = await FakeOscarServer.start();
    server.addUser('botone', 'hunter22');
    server.addUser('alice', 'hunter24');
  });
  afterEach(async () => {
    await session.stop();
    await server.stop();
    resetRuntimeForTests();
  });

  async function boot(): Promise<void> {
    session = createOscarSession({
      host: '127.0.0.1', port: server.port, tls: false, redirect: 'pin',
      screenName: 'botone', getPassword: async () => 'hunter22', buddies: () => ['alice'],
      log: quietLog, loginBudget: { take: async () => {} },
    });
    setRuntime({ accountId: 'default', session, rooms: new Map(), sessionKeys: new Map(), lastReplyAt: new Map(), counters: { droppedSends: 0, eventGaps: 0 } });
    const ready = new Promise<void>((resolve) => {
      const off = session.on('state', (state) => {
        if (state.phase !== 'online') return;
        off();
        resolve();
      });
    });
    session.start();
    await ready;
  }

  it('sends to the other channel and puts nothing on AIM while the owner is away', async () => {
    const alice = server.peer('alice');
    await boot();
    await expect.poll(() => session.presenceOf('alice')?.online).toBe(true);
    alice.setAway('out');
    await expect.poll(() => session.presenceOf('alice')?.away).toBe(true);
    await sendMarkdown({ cfg, to: 'alice', markdown: 'status report' });
    expect(sdk.foreign).toEqual([{ channel: 'signal', to: 'c1072e4a', text: 'status report' }]);
    expect(imsTo(server, 'alice')).toBe(0);
    expect(alice.ims()).toEqual([]);
  });

  it('sends on AIM while the owner is present', async () => {
    const alice = server.peer('alice');
    await boot();
    await expect.poll(() => session.presenceOf('alice')?.away).toBe(false);
    await sendMarkdown({ cfg, to: 'alice', markdown: 'status report' });
    await vi.waitFor(() => expect(alice.ims().map((im) => im.text)).toEqual(['status report']));
    expect(imsTo(server, 'alice')).toBe(1);
    expect(sdk.foreign).toEqual([]);
  });
});
