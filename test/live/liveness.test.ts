import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOscarSession, type OscarEvents, type OscarSession } from '../../src/oscar/index.js';
import { liveEnabled, startLiveServer, type LiveServer } from './harness.js';

const PASSWORD = 'hunter22';
// past one 90 s liveness round, which is where every connection used to die
const HOLD_MS = 100_000;
const WAIT_MS = 10_000;
const HOLD_TIMEOUT_MS = 180_000;
const room = { exchange: 4 as const, name: 'holdroom' };
const quiet = { debug() {}, info() {}, warn() {}, error() {} };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function nextEvent<E extends keyof OscarEvents>(
  session: OscarSession,
  event: E,
  match: (payload: OscarEvents[E]) => boolean = () => true,
): Promise<OscarEvents[E]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`no ${event} event in ${WAIT_MS} ms`));
    }, WAIT_MS);
    const off = session.on(event, (payload) => {
      if (!match(payload)) return;
      clearTimeout(timer);
      off();
      resolve(payload);
    });
  });
}

describe.skipIf(!liveEnabled)('a session held open past the liveness interval', () => {
  let server: LiveServer;
  let botone: OscarSession;
  let bottwo: OscarSession;
  const phases: string[] = [];

  const connect = (name: string, buddies: string[]): OscarSession =>
    createOscarSession({
      host: server.host,
      port: server.port,
      tls: false,
      redirect: 'auto',
      screenName: name,
      getPassword: async () => PASSWORD,
      buddies: () => buddies,
      log: quiet,
      loginBudget: { take: async () => undefined },
    });

  beforeAll(async () => {
    server = await startLiveServer();
    await server.createUser('botone', PASSWORD, { bot: true });
    await server.createUser('bottwo', PASSWORD);
    botone = connect('botone', ['bottwo']);
    bottwo = connect('bottwo', ['botone']);
    botone.on('state', (s) => phases.push(s.phase));
    const up = [nextEvent(botone, 'state', (s) => s.phase === 'online'), nextEvent(bottwo, 'state', (s) => s.phase === 'online')];
    botone.start();
    bottwo.start();
    await Promise.all(up);
    await botone.joinRoom(room, { persistent: true });
    await bottwo.joinRoom(room);
  }, 60_000);

  afterAll(async () => {
    await botone?.stop();
    await bottwo?.stop();
    await server?.stop();
  }, 30_000);

  it('is still the same online session, on both sockets, and can still send', async () => {
    await sleep(HOLD_MS);
    expect(botone.getState().phase).toBe('online');
    // a second connecting would mean the link died and the session spent another login
    expect(phases).toEqual(['connecting', 'online']);
    expect(botone.rooms().map((r) => r.room.name)).toEqual([room.name]);

    const im = nextEvent(bottwo, 'im', (e) => e.from === 'botone');
    await expect(botone.sendIm('bottwo', 'still here')).resolves.toMatchObject({ storedOffline: false });
    expect((await im).text).toBe('still here');

    const line = nextEvent(bottwo, 'roomMessage', (m) => m.from === 'botone');
    await expect(botone.sendRoom(room, 'room still here')).resolves.toMatchObject({ storedOffline: false });
    expect((await line).text).toBe('room still here');

    // the fatal request must not appear in the server's own log of what it was asked for
    expect(server.logs()).not.toContain('OServiceProbeReq');
    expect(server.logs()).not.toContain('attempting to marshal a nil SNAC');
  }, HOLD_TIMEOUT_MS);
});
