import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AwayConfig } from '../../src/config.js';
import { createOscarSession, type OscarSession } from '../../src/oscar/index.js';
import { createAutoReplier } from '../../src/presence/auto-reply.js';
import { createAwayController } from '../../src/presence/away.js';
import { createRunTracker } from '../../src/presence/runs.js';
import { FakeOscarServer } from '../fake/oscar-server.js';
import { quietLog } from '../fake/stub-session.js';

const IM = 'agent:main:oscar:group:botone/bob';
const DEFAULT = 'Working on something. Back in a bit.';
const ICBM = 0x0004;
const ICBM_MSG_TO_HOST = 0x0006;
const TLV_AUTO_RESPONSE = 0x0004;

function outgoingImTags(server: FakeOscarServer): number[][] {
  return server
    .snacsFrom('botone')
    .filter((snac) => snac.conn === 'bos' && snac.family === ICBM && snac.subtype === ICBM_MSG_TO_HOST)
    .map((snac) => {
      const body = snac.body;
      const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
      const tags: number[] = [];
      let offset = 11 + (body[10] ?? 0);
      while (offset + 4 <= body.byteLength) {
        tags.push(view.getUint16(offset));
        offset += 4 + view.getUint16(offset + 2);
      }
      return tags;
    });
}

describe('the away auto-reply on the wire', () => {
  let server: FakeOscarServer;
  const sessions: OscarSession[] = [];

  beforeEach(async () => {
    server = await FakeOscarServer.start();
    server.addUser('botone', 'hunter22');
    server.addUser('bob', 'hunter24');
  });
  afterEach(async () => {
    for (const session of sessions.splice(0)) await session.stop();
    await server.stop();
  });

  function boot(graceMs: number) {
    const away: AwayConfig = {
      enabled: true, message: DEFAULT, blurb: 'agent', graceMs, maxLength: 100, replyCooldownMinutes: 10,
    };
    const session = createOscarSession({
      host: '127.0.0.1', port: server.port, tls: false, redirect: 'pin',
      screenName: 'botone', getPassword: async () => 'hunter22', buddies: () => ['bob'],
      log: quietLog, loginBudget: { take: async () => {} },
    });
    sessions.push(session);
    const tracker = createRunTracker();
    tracker.bind(IM, 'botone', 'approved');
    const controller = createAwayController({
      accountId: 'botone', tracker, session, config: () => away, forbidden: () => ['bob'], log: quietLog,
    });
    const replier = createAutoReplier({
      accountId: 'botone', tracker, away: controller, config: () => away,
      repliedAt: () => undefined,
      send: async (to, text) => {
        await session.sendIm(to, text, { priority: 'notice', auto: true });
      },
      log: quietLog,
    });
    return { session, tracker, controller, replier };
  }

  function online(session: OscarSession): Promise<void> {
    return new Promise((resolve) => {
      const off = session.on('state', (state) => {
        if (state.phase !== 'online') return;
        off();
        resolve();
      });
    });
  }

  it('sends the away line back and marks it as an automatic reply', async () => {
    const { session, tracker, controller, replier } = boot(30);
    const ready = online(session);
    session.start();
    await ready;
    const bob = server.peer('bob');
    tracker.seen('r1', IM);
    await vi.waitFor(() => expect(controller.current()).toBe(DEFAULT));
    replier.contacted('bob');
    await vi.waitFor(() => expect(bob.ims().map((im) => im.text)).toEqual([DEFAULT]));
    expect(outgoingImTags(server).at(-1)).toContain(TLV_AUTO_RESPONSE);
  });

  it('sends nothing when the run ends inside the grace period', async () => {
    const { session, tracker, replier } = boot(3000);
    const ready = online(session);
    session.start();
    await ready;
    const bob = server.peer('bob');
    tracker.seen('r1', IM);
    replier.contacted('bob');
    tracker.ended('r1');
    await session.sendIm('bob', 'done');
    await vi.waitFor(() => expect(bob.ims()).toHaveLength(1));
    expect(bob.ims().map((im) => im.text)).toEqual(['done']);
    expect(outgoingImTags(server).at(-1)).not.toContain(TLV_AUTO_RESPONSE);
  });
});
