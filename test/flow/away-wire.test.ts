import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AwayConfig } from '../../src/config.js';
import { createOscarSession, type OscarSession } from '../../src/oscar/index.js';
import { createAwayController } from '../../src/presence/away.js';
import { createRunTracker } from '../../src/presence/runs.js';
import { FakeOscarServer } from '../fake/oscar-server.js';
import { quietLog } from '../fake/stub-session.js';

const IM = 'agent:main:oscar:group:botone/alice';
const DEFAULT = 'Working on something. Back in a bit.';
const LOCATE = 0x0002;
const LOCATE_SET_INFO = 0x0004;
const TLV_AWAY_TEXT = 0x0004;

function tlvValue(body: Uint8Array, tag: number): Uint8Array | null {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  let offset = 0;
  while (offset + 4 <= body.byteLength) {
    const length = view.getUint16(offset + 2);
    if (view.getUint16(offset) === tag) return body.subarray(offset + 4, offset + 4 + length);
    offset += 4 + length;
  }
  return null;
}

function awayTexts(server: FakeOscarServer, from = 0): string[] {
  return server
    .snacsFrom('botone')
    .slice(from)
    .filter((snac) => snac.conn === 'bos' && snac.family === LOCATE && snac.subtype === LOCATE_SET_INFO)
    .flatMap((snac) => {
      const value = tlvValue(snac.body, TLV_AWAY_TEXT);
      return value ? [new TextDecoder('latin1').decode(value)] : [];
    });
}

describe('away on the wire', () => {
  let server: FakeOscarServer;
  const sessions: OscarSession[] = [];
  const base: AwayConfig = { enabled: true, message: DEFAULT, blurb: 'agent', graceMs: 30, maxLength: 100, replyCooldownMinutes: 10 };

  beforeEach(async () => {
    server = await FakeOscarServer.start();
    server.addUser('botone', 'hunter22');
    server.addUser('alice', 'hunter23');
  });
  afterEach(async () => {
    for (const session of sessions.splice(0)) await session.stop();
    await server.stop();
  });

  function boot(graceMs = 30) {
    const away: AwayConfig = { ...base, graceMs };
    const session = createOscarSession({
      host: '127.0.0.1', port: server.port, tls: false, redirect: 'pin',
      screenName: 'botone', getPassword: async () => 'hunter22', buddies: () => ['alice'],
      log: quietLog, loginBudget: { take: async () => {} },
    });
    sessions.push(session);
    const tracker = createRunTracker();
    tracker.bind(IM, 'botone', 'owner');
    const controller = createAwayController({
      accountId: 'botone', tracker, session, config: () => away, forbidden: () => ['alice'], log: quietLog,
    });
    return { session, tracker, controller };
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

  it('sets plain ASCII text after the grace period and clears it within a second of the run ending', async () => {
    const { session, tracker } = boot();
    const ready = online(session);
    session.start();
    await ready;
    tracker.seen('r1', IM);
    await vi.waitFor(() => expect(awayTexts(server).filter((text) => text !== '')).toEqual([DEFAULT]));
    const endedAt = Date.now();
    tracker.ended('r1');
    await vi.waitFor(() => expect(awayTexts(server).at(-1)).toBe(''));
    expect(Date.now() - endedAt).toBeLessThan(1000);
  });

  it('is not away after the process died mid-run and came back', async () => {
    const first = boot();
    const firstReady = online(first.session);
    first.session.start();
    await firstReady;
    first.tracker.seen('r1', IM);
    await vi.waitFor(() => expect(awayTexts(server)).toContain(DEFAULT));
    await first.session.stop();
    sessions.splice(sessions.indexOf(first.session), 1);
    const mark = server.snacsFrom('botone').length;

    const alice = server.peer('alice');
    const second = boot(0);
    const secondReady = online(second.session);
    second.session.start();
    await secondReady;
    expect(second.tracker.isBusy('botone')).toBe(false);
    await second.session.sendIm('alice', 'ping');
    await vi.waitFor(() => expect(alice.ims()).toHaveLength(1));
    expect(awayTexts(server, mark).filter((text) => text !== '')).toEqual([]);
  });

  it('puts the line back after a reconnect once the run shows life', async () => {
    const { session, tracker, controller } = boot();
    const ready = online(session);
    session.start();
    await ready;
    tracker.seen('r1', IM);
    await vi.waitFor(() => expect(awayTexts(server)).toContain(DEFAULT));
    const mark = server.snacsFrom('botone').length;
    const back = online(session);
    server.dropSocket('botone', 'bos');
    await back;
    expect(tracker.isBusy('botone')).toBe(false);
    tracker.toolStart('r1', 't1', 'exec', IM);
    controller.noteTool('r1', 'exec');
    await vi.waitFor(() => expect(awayTexts(server, mark)).toContain('Running some commands'));
  }, 20_000);
});
