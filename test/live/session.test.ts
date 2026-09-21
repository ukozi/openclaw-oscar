import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOscarSession, type OscarEvents, type OscarSession } from '../../src/oscar/index.js';
import { liveEnabled, startLiveServer, type LiveServer } from './harness.js';
import { TocPeer } from './toc-peer.js';

const PASSWORD = 'hunter22';
const WAIT_MS = 10_000;
const quiet = { debug() {}, info() {}, warn() {}, error() {} };

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

// Every login spends one of ten per-minute slots the server keeps per source address, so the file signs on once.
describe.skipIf(!liveEnabled)('against a real server', () => {
  let server: LiveServer;
  let botone: OscarSession;
  let bottwo: OscarSession;
  let alice: TocPeer;

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
    await server.createUser('alice', PASSWORD);
    botone = connect('botone', ['bottwo', 'alice']);
    bottwo = connect('bottwo', ['botone']);
    const up = [nextEvent(botone, 'state', (s) => s.phase === 'online'), nextEvent(bottwo, 'state', (s) => s.phase === 'online')];
    botone.start();
    bottwo.start();
    await Promise.all(up);
    alice = await TocPeer.signOn({ host: server.host, port: server.tocPort, name: 'alice', password: PASSWORD });
  }, 60_000);

  afterAll(async () => {
    alice?.close();
    await botone?.stop();
    await bottwo?.stop();
    await server?.stop();
  }, 30_000);

  it('signs on and reads its own name and bot flag', () => {
    expect(botone.selfInfo()).toEqual({ screenName: 'botone', bot: true });
    expect(bottwo.selfInfo()).toEqual({ screenName: 'bottwo', bot: false });
  });

  it('carries an IM each way with a receipt', async () => {
    const there = nextEvent(bottwo, 'im', (im) => im.from === 'botone');
    await expect(botone.sendIm('bottwo', 'ping')).resolves.toMatchObject({ storedOffline: false });
    expect((await there).text).toBe('ping');
    const back = nextEvent(botone, 'im', (im) => im.from === 'bottwo');
    await bottwo.sendIm('botone', 'pong');
    expect((await back).text).toBe('pong');
  });

  it('gives a TOC sender cookie 0 on an IM', async () => {
    const got = nextEvent(botone, 'im', (im) => im.from === 'alice');
    alice.sendIm('botone', 'from toc');
    expect(await got).toMatchObject({ text: 'from toc', cookie: 0n });
  });

  it('joins a private room and sees who is there', async () => {
    const room = { exchange: 4 as const, name: 'liveroom' };
    await botone.joinRoom(room, { persistent: true });
    const sawJoin = nextEvent(botone, 'roomJoin', (e) => e.name === 'bottwo');
    await bottwo.joinRoom(room);
    await sawJoin;
    expect(botone.rooms().find((r) => r.room.name === 'liveroom')?.occupants.sort()).toEqual(['botone', 'bottwo']);
    expect(bottwo.rooms()[0]?.occupants.sort()).toEqual(['botone', 'bottwo']);
  });

  it('gets its room line reflected and delivers it with a non-zero cookie', async () => {
    const room = { exchange: 4 as const, name: 'liveroom' };
    const heard = nextEvent(bottwo, 'roomMessage', (m) => m.from === 'botone');
    const receipt = await botone.sendRoom(room, 'hello café');
    expect(receipt.id).not.toBe('0');
    expect(await heard).toMatchObject({ text: 'hello café', whisper: false });
    expect((await heard).cookie).not.toBe(0n);
  });

  it('takes its own receipt from a line the server rewrites, and both sides see the rewrite', async () => {
    const room = { exchange: 4 as const, name: 'liveroom' };
    const mine = nextEvent(botone, 'roomMessage', (m) => m.serverGenerated);
    const theirs = nextEvent(bottwo, 'roomMessage', (m) => m.serverGenerated);
    // the outbound converter guards a leading //roll; this is the raw HTML the server rewrites
    const receipt = await botone.sendRoom(room, '//roll');
    expect(receipt.id).not.toBe('0');
    expect(await mine).toMatchObject({ from: 'onlinehost', serverGenerated: true });
    expect((await mine).text).toContain('rolled');
    expect(await theirs).toMatchObject({ from: 'onlinehost', serverGenerated: true });
  });

  it('delivers a whisper to its target only, marked as a whisper', async () => {
    const room = { exchange: 4 as const, name: 'liveroom' };
    const heard = nextEvent(bottwo, 'roomMessage', (m) => m.text === 'psst');
    await botone.sendRoom(room, 'psst', { whisperTo: 'bottwo' });
    expect((await heard).whisper).toBe(true);
  });

  it('accepts an invite from a TOC user and reads their room lines: cookie 0, UTF-8, no encoding', async () => {
    const chatId = await alice.joinRoom('inviteroom');
    const invited = nextEvent(botone, 'invite');
    alice.invite(chatId, 'botone', 'come in');
    const invite = await invited;
    expect(invite).toMatchObject({ from: 'alice', room: { exchange: 4, name: 'inviteroom' }, roomCookie: '4-0-inviteroom', text: 'come in' });
    const ready = nextEvent(botone, 'roomReady', (e) => e.room.name === 'inviteroom');
    await botone.joinInvited(invite);
    expect((await ready).occupants.sort()).toEqual(['alice', 'botone']);
    const first = nextEvent(botone, 'roomMessage', (m) => m.text === 'café one');
    const second = nextEvent(botone, 'roomMessage', (m) => m.text === 'café two');
    alice.say(chatId, 'café one');
    alice.say(chatId, 'café two');
    expect(await first).toMatchObject({ from: 'alice', cookie: 0n, whisper: false });
    expect(await second).toMatchObject({ from: 'alice', cookie: 0n });
    await alice.waitFor('CHAT_IN:');
  });

  it('reports a missing public room, then joins it once the operator made it', async () => {
    const room = { exchange: 5 as const, name: 'livelobby' };
    await expect(botone.joinRoom(room)).rejects.toMatchObject({ code: 'no-such-room' });
    expect(botone.getState().phase).toBe('online');
    await server.createPublicRoom('livelobby');
    await expect(botone.joinRoom(room)).resolves.toBeUndefined();
  });

  it('shows away to a buddy and clears it again', async () => {
    const away = nextEvent(bottwo, 'presence', (p) => p.name === 'botone' && p.away);
    await botone.setAway('Working on something.');
    expect(await away).toMatchObject({ online: true, away: true, bot: true });
    const back = nextEvent(bottwo, 'presence', (p) => p.name === 'botone' && !p.away);
    await botone.setAway(null);
    expect((await back).away).toBe(false);
  });

  it('leaves a room by closing its socket, and the others see it go', async () => {
    const room = { exchange: 4 as const, name: 'liveroom' };
    const gone = nextEvent(botone, 'roomLeave', (e) => e.room.name === 'liveroom' && e.name === 'bottwo');
    const closed = nextEvent(bottwo, 'roomClosed', (e) => e.room.name === 'liveroom');
    await bottwo.leaveRoom(room);
    expect((await closed).willRejoin).toBe(false);
    await gone;
    expect(bottwo.rooms()).toEqual([]);
  });
});
