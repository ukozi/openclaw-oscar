import { describe, expect, it } from 'vitest';
import {
  CHATNAV_CREATE_ROOM,
  CHATNAV_ERR,
  CHATNAV_NAV_INFO,
  CHATNAV_REQUEST_ROOM_INFO,
  CHAT_MSG_TO_CLIENT,
  CHAT_USERS_JOINED,
  FAMILY_CHAT,
  FAMILY_CHATNAV,
  FAMILY_OSERVICE,
  OSERVICE_CLIENT_ONLINE,
  OSERVICE_RATE_PARAMS_QUERY,
  OSERVICE_RATE_PARAMS_REPLY,
} from '../../../src/oscar/constants.js';
import { RoomManager, type RoomEventName, type RoomsHost } from '../../../src/oscar/rooms.js';
import { encodeUserInfo } from '../../../src/oscar/snac.js';
import { OscarSendError, type InviteEvent, type OscarEvents, type ServiceGrant, type SnacLink } from '../../../src/oscar/types.js';
import { FakeLink, ManualClock, StubPacer, flush, quietLog, toHex, vector } from './room-kit.js';

const testroom = { exchange: 4 as const, name: 'testroom' };
const invite: InviteEvent = { from: 'alice', fromDisplay: 'Alice', room: testroom, roomCookie: '4-0-testroom', text: '' };

type Seen = { [E in RoomEventName]: OscarEvents[E][] };

// The session's BOS side as rooms see it: online or not, and one service request at a time.
type Bos = {
  closed: boolean;
  asked: { family: number; roomInfo: Uint8Array | undefined }[];
  onAsk: ((family: number) => 'drop' | undefined) | null;
  drop(): void;
};

function world() {
  const clock = new ManualClock();
  const seen: Seen = { roomReady: [], roomJoin: [], roomLeave: [], roomMessage: [], roomClosed: [], rate: [] };
  const log: string[] = [];
  const state = {
    bos: null as Bos | null,
    navLinks: [] as FakeLink[],
    chatLinks: [] as FakeLink[],
    navReply: 'room' as 'room' | 'missing' | 'drop',
    grants: [] as ServiceGrant[],
    targets: [] as { host: string; port: number }[],
    grantTtl: 60_000,
    onChatLink: null as (() => void) | null,
  };

  function newBos(): Bos {
    const bos: Bos = {
      closed: false,
      asked: [],
      onAsk: null,
      drop: () => {
        bos.closed = true;
      },
    };
    state.bos = bos;
    return bos;
  }

  function navLink(): FakeLink {
    const link = new FakeLink();
    link.onRequest = (snac) => {
      log.push(snac.subtype === CHATNAV_CREATE_ROOM ? 'nav:create' : 'nav:cookie');
      if (state.navReply === 'drop') return 'drop';
      if (state.navReply === 'missing') return { family: FAMILY_CHATNAV, subtype: CHATNAV_ERR, body: vector('chatNavErrNoMatch') };
      return { family: FAMILY_CHATNAV, subtype: CHATNAV_NAV_INFO, body: vector('navInfoRoom') };
    };
    state.navLinks.push(link);
    return link;
  }

  function chatLink(): FakeLink {
    const link = new FakeLink();
    link.onRequest = (snac) =>
      snac.subtype === OSERVICE_RATE_PARAMS_QUERY ? { family: FAMILY_OSERVICE, subtype: OSERVICE_RATE_PARAMS_REPLY } : undefined;
    link.onSend = (snac) => {
      if (snac.family !== FAMILY_OSERVICE || snac.subtype !== OSERVICE_CLIENT_ONLINE) return;
      log.push('chat:online');
      queueMicrotask(() =>
        link.deliver({
          family: FAMILY_CHAT,
          subtype: CHAT_USERS_JOINED,
          body: Buffer.concat(['botone', 'alice'].map((name) => Buffer.from(encodeUserInfo({ name, warning: 0, tlvs: [] })))),
        }),
      );
    };
    state.chatLinks.push(link);
    state.onChatLink?.();
    return link;
  }

  const host: RoomsHost = {
    screenName: () => 'botone',
    online: () => state.bos !== null && !state.bos.closed,
    resolveService: async (family, roomInfo) => {
      const bos = state.bos;
      if (!bos || bos.closed) throw new OscarSendError('not-online');
      bos.asked.push({ family, roomInfo });
      log.push(`bos:service:${family.toString(16)}`);
      if (bos.onAsk?.(family) === 'drop') {
        bos.closed = true;
        throw new Error('connection closed');
      }
      const grant: ServiceGrant = {
        host: family === FAMILY_CHATNAV ? 'nav.example.net' : 'chat.example.net',
        port: 5190,
        cookie: Uint8Array.from([family]),
        pinned: false,
        expiresAt: clock.now() + state.grantTtl,
      };
      state.grants.push(grant);
      return grant;
    },
    connect: async (target, cookie): Promise<SnacLink> => {
      state.targets.push({ host: target.host, port: target.port });
      return cookie[0] === FAMILY_CHATNAV ? navLink() : chatLink();
    },
    makePacer: () => new StubPacer(),
    bosRateNotice: () => undefined,
    emit: (event, payload) => {
      (seen[event] as unknown[]).push(payload);
    },
    log: quietLog,
    now: clock.now,
    timers: clock.timers,
    random: () => 0.5,
  };
  newBos();
  const manager = new RoomManager(host);
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await flush();
  };
  return { manager, clock, seen, log, state, newBos, settle };
}

describe('joining', () => {
  it('resolves through chatnav, then asks BOS for the room, then signs the room socket on', async () => {
    const w = world();
    await w.manager.joinRoom(testroom);
    expect(w.log).toEqual(['bos:service:d', 'nav:create', 'bos:service:e', 'chat:online']);
    expect(w.seen.roomReady).toEqual([{ room: testroom, occupants: ['botone', 'alice'] }]);
    expect(w.manager.rooms()).toMatchObject([{ room: testroom, occupants: ['botone', 'alice'] }]);
    expect(w.state.navLinks[0]?.closed).toBe(true);
  });

  it('lowercases the room name', async () => {
    const w = world();
    await w.manager.joinRoom({ exchange: 4, name: 'TestRoom' });
    expect(w.seen.roomReady[0]?.room).toEqual(testroom);
  });

  it('does not join a room it already holds', async () => {
    const w = world();
    await w.manager.joinRoom(testroom);
    await w.manager.joinRoom(testroom);
    await w.manager.joinInvited(invite);
    expect(w.state.chatLinks).toHaveLength(1);
  });

  it('shares one attempt between two callers', async () => {
    const w = world();
    await Promise.all([w.manager.joinRoom(testroom), w.manager.joinRoom(testroom)]);
    expect(w.state.chatLinks).toHaveLength(1);
  });

  it('refuses a join over 180 bytes before anything reaches the wire', async () => {
    const w = world();
    await expect(w.manager.joinRoom({ exchange: 4, name: 'x'.repeat(200) })).rejects.toMatchObject({ code: 'too-long' });
    expect(w.log).toEqual([]);
    expect(w.state.bos?.asked).toHaveLength(0);
  });

  it('joins an invited room by cookie and never creates it', async () => {
    const w = world();
    await w.manager.joinInvited(invite);
    expect(w.log).toEqual(['bos:service:d', 'nav:cookie', 'bos:service:e', 'chat:online']);
    expect(w.state.navLinks[0]?.sentOf(FAMILY_CHATNAV, CHATNAV_REQUEST_ROOM_INFO)).toHaveLength(1);
  });

  it('never asks BOS for a room chatnav could not find', async () => {
    const w = world();
    w.state.navReply = 'drop';
    const join = w.manager.joinInvited(invite);
    const failed = expect(join).rejects.toMatchObject({ code: 'no-such-room' });
    await w.settle();
    await w.clock.advance(500);
    await failed;
    expect(w.log.filter((l) => l === 'bos:service:e')).toEqual([]);
  });

  it('rejects a session join while offline and takes a persistent one for later', async () => {
    const w = world();
    w.state.bos?.drop();
    await expect(w.manager.joinRoom(testroom)).rejects.toMatchObject({ code: 'not-online' });
    await expect(w.manager.joinRoom(testroom, { persistent: true })).resolves.toBeUndefined();
    w.newBos();
    w.manager.bosOnline();
    await w.settle();
    expect(w.seen.roomReady).toHaveLength(1);
  });
});

describe('missing public room', () => {
  it('fails a session join and forgets it', async () => {
    const w = world();
    w.state.navReply = 'missing';
    await expect(w.manager.joinRoom({ exchange: 5, name: 'lobby' })).rejects.toMatchObject({ code: 'no-such-room' });
    w.state.navReply = 'room';
    await w.clock.advance(600_000);
    expect(w.state.chatLinks).toHaveLength(0);
  });

  it('keeps trying a persistent room every five minutes until it exists', async () => {
    const w = world();
    w.state.navReply = 'missing';
    await expect(w.manager.joinRoom(testroom, { persistent: true })).rejects.toMatchObject({ code: 'no-such-room' });
    await w.clock.advance(299_999);
    expect(w.state.navLinks).toHaveLength(1);
    w.state.navReply = 'room';
    await w.clock.advance(1);
    await w.settle();
    expect(w.seen.roomReady).toHaveLength(1);
  });
});

describe('room drops', () => {
  it('rejoins a dropped room after 2 s with a fresh service cookie and fails pending sends', async () => {
    const w = world();
    await w.manager.joinRoom(testroom);
    const pending = expect(w.manager.sendRoom(testroom, 'hi')).rejects.toMatchObject({ code: 'closed' });
    w.state.chatLinks[0]?.drop();
    await pending;
    expect(w.seen.roomClosed).toEqual([{ room: testroom, willRejoin: true }]);
    expect(w.manager.rooms()).toEqual([]);
    await w.clock.advance(1999);
    expect(w.state.chatLinks).toHaveLength(1);
    await w.clock.advance(1);
    await w.settle();
    expect(w.seen.roomReady).toHaveLength(2);
    expect(w.log.filter((l) => l === 'bos:service:e')).toHaveLength(2);
  });

  it('backs off 2 s, 4 s, 8 s when the seat keeps being taken', async () => {
    const w = world();
    await w.manager.joinRoom(testroom);
    for (const [i, delay] of [2000, 4000, 8000].entries()) {
      w.state.chatLinks[i]?.drop();
      await w.clock.advance(delay - 1);
      expect(w.state.chatLinks).toHaveLength(i + 1);
      await w.clock.advance(1);
      await w.settle();
      expect(w.state.chatLinks).toHaveLength(i + 2);
    }
  });

  it('starts the backoff over after a minute of staying joined', async () => {
    const w = world();
    await w.manager.joinRoom(testroom);
    w.state.chatLinks[0]?.drop();
    await w.clock.advance(2000);
    await w.settle();
    await w.clock.advance(60_000);
    w.state.chatLinks[1]?.drop();
    await w.clock.advance(2000);
    await w.settle();
    expect(w.state.chatLinks).toHaveLength(3);
  });

  it('gives a session room up after five failures in a row', async () => {
    const w = world();
    await w.manager.joinRoom(testroom);
    w.state.navReply = 'drop';
    w.state.chatLinks[0]?.drop();
    await w.clock.advance(3_600_000);
    expect(w.seen.roomClosed).toEqual([
      { room: testroom, willRejoin: true },
      { room: testroom, willRejoin: false },
    ]);
  });

  it('rejoins an invited room by cookie', async () => {
    const w = world();
    await w.manager.joinInvited(invite);
    w.state.chatLinks[0]?.drop();
    await w.clock.advance(2000);
    await w.settle();
    expect(w.log.filter((l) => l.startsWith('nav:'))).toEqual(['nav:cookie', 'nav:cookie']);
  });
});

describe('BOS loss', () => {
  it('closes every room, then rejoins persistent and session rooms at the next sign-on', async () => {
    const w = world();
    await w.manager.joinRoom(testroom, { persistent: true });
    await w.manager.joinInvited({ ...invite, room: { exchange: 4, name: 'side' }, roomCookie: '4-0-side' });
    w.state.bos?.drop();
    w.manager.bosLost();
    expect(w.seen.roomClosed).toEqual([
      { room: testroom, willRejoin: true },
      { room: { exchange: 4, name: 'side' }, willRejoin: true },
    ]);
    expect(w.state.chatLinks.every((l) => l.closed)).toBe(true);
    await w.clock.advance(600_000);
    expect(w.state.chatLinks).toHaveLength(2);
    w.newBos();
    w.manager.bosOnline();
    await w.settle();
    expect(w.seen.roomReady).toHaveLength(4);
  });

  it('retries a join that lost BOS under it when BOS is already back', async () => {
    const w = world();
    const first = w.state.bos;
    if (!first) throw new Error('no BOS scripted');
    first.onAsk = (family) => {
      if (family !== FAMILY_CHAT) return undefined;
      w.manager.bosLost();
      w.newBos();
      w.manager.bosOnline();
      return 'drop';
    };
    await expect(w.manager.joinRoom(testroom, { persistent: true })).rejects.toMatchObject({ code: 'not-online' });
    expect(w.seen.roomReady).toEqual([]);
    await w.clock.advance(2000);
    await w.settle();
    expect(w.seen.roomReady).toHaveLength(1);
  });

  it('does not report a room twice when its socket closed just before BOS did', async () => {
    const w = world();
    await w.manager.joinRoom(testroom);
    w.state.chatLinks[0]?.drop();
    w.state.bos?.drop();
    w.manager.bosLost();
    await w.clock.advance(10_000);
    expect(w.seen.roomClosed).toHaveLength(1);
    expect(w.state.chatLinks).toHaveLength(1);
  });

  it('forgets session rooms on stop and keeps persistent ones', async () => {
    const w = world();
    await w.manager.joinRoom(testroom, { persistent: true });
    await w.manager.joinRoom({ exchange: 4, name: 'side' });
    w.manager.stop();
    expect(w.seen.roomClosed).toEqual([
      { room: testroom, willRejoin: true },
      { room: { exchange: 4, name: 'side' }, willRejoin: false },
    ]);
    w.manager.bosOnline();
    await w.settle();
    expect(w.manager.rooms().map((r) => r.room.name)).toEqual(['testroom']);
  });
});

describe('leaving and sending', () => {
  it('leaves by closing the socket and never rejoins', async () => {
    const w = world();
    await w.manager.joinRoom(testroom, { persistent: true });
    await w.manager.leaveRoom(testroom);
    expect(w.state.chatLinks[0]?.closed).toBe(true);
    expect(w.seen.roomClosed).toEqual([{ room: testroom, willRejoin: false }]);
    w.manager.bosOnline();
    await w.clock.advance(600_000);
    expect(w.state.chatLinks).toHaveLength(1);
  });

  it('sends nothing for a room that was left before its join started', async () => {
    const w = world();
    const join = w.manager.joinRoom(testroom);
    await w.manager.leaveRoom(testroom);
    await join;
    expect(w.log).toEqual([]);
  });

  it('closes a room that was left while its socket was signing on', async () => {
    const w = world();
    w.state.onChatLink = () => void w.manager.leaveRoom(testroom);
    await w.manager.joinRoom(testroom);
    expect(w.manager.rooms()).toEqual([]);
    expect(w.state.chatLinks[0]?.closed).toBe(true);
    expect(w.seen.roomReady).toEqual([]);
  });

  it('fails a send to a room it is not in', async () => {
    const w = world();
    await expect(w.manager.sendRoom(testroom, 'hi')).rejects.toMatchObject({ code: 'room-not-joined' });
  });

  it('passes room lines, joins and whispers up with the room attached', async () => {
    const w = world();
    await w.manager.joinRoom(testroom);
    w.state.chatLinks[0]?.deliver({ family: FAMILY_CHAT, subtype: CHAT_MSG_TO_CLIENT, body: vector('roomRelayWhisper') });
    w.state.chatLinks[0]?.deliver({ family: FAMILY_CHAT, subtype: CHAT_USERS_JOINED, body: encodeUserInfo({ name: 'Bob', warning: 0, tlvs: [] }) });
    expect(w.seen.roomMessage).toEqual([
      { room: testroom, from: 'alice', fromDisplay: 'Alice', text: 'psst', cookie: 0x1112131415161718n, whisper: true, serverGenerated: false },
    ]);
    expect(w.seen.roomJoin).toEqual([{ room: testroom, name: 'bob', display: 'Bob' }]);
  });

  it('asks the session for the chat service only after chatnav answered, with the room chatnav returned', async () => {
    const w = world();
    await w.manager.joinRoom(testroom);
    const asked = w.state.bos?.asked ?? [];
    expect(asked.map((a) => a.family)).toEqual([FAMILY_CHATNAV, FAMILY_CHAT]);
    expect(asked[0]?.roomInfo).toBeUndefined();
    expect(toHex(asked[1]?.roomInfo ?? new Uint8Array(0))).toBe('00040c342d302d74657374726f6f6d0000');
  });

  it('dials each socket where its grant says', async () => {
    const w = world();
    await w.manager.joinRoom(testroom);
    expect(w.state.targets).toEqual([
      { host: 'nav.example.net', port: 5190 },
      { host: 'chat.example.net', port: 5190 },
    ]);
  });

  it('does not present a service cookie whose 60 s have run out', async () => {
    const w = world();
    w.state.grantTtl = 0;
    await expect(w.manager.joinRoom(testroom)).rejects.toMatchObject({ code: 'unavailable' });
    expect(w.state.targets).toEqual([]);
  });
});
