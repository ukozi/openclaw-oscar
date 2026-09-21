import { describe, expect, it } from 'vitest';
import { ServiceRefusedError, encodeServiceRequest } from '../../../src/oscar/bos.js';
import { RedirectRefusedError } from '../../../src/oscar/connection.js';
import {
  decodeNavInfo,
  encodeCreateRoom,
  encodeRequestRoomInfo,
  encodeServiceRoomInfo,
  joinTooLong,
  requestService,
  resolveRoom,
  roomCookie,
  roomFromCookie,
  roomKey,
  type NavDeps,
  type RoomInfo,
  type ServiceResolver,
} from '../../../src/oscar/chatnav.js';
import {
  CHATNAV_CREATE_ROOM,
  CHATNAV_ERR,
  CHATNAV_NAV_INFO,
  CHATNAV_REQUEST_ROOM_INFO,
  FAMILY_CHAT,
  FAMILY_CHATNAV,
  FAMILY_OSERVICE,
  OSERVICE_RATE_PARAM_CHANGE,
} from '../../../src/oscar/constants.js';
import { OscarRoomError, OscarSendError, type ServiceGrant, type SnacLink } from '../../../src/oscar/types.js';
import { FakeLink, quietLog, toHex, vector, vectorHex, vectorSource } from './room-kit.js';

const testroom: RoomInfo = { exchange: 4, cookie: '4-0-testroom', name: 'testroom' };

type TestDeps = NavDeps & { slept: number[]; opened: number };

function deps(links: FakeLink[], over: Partial<NavDeps> = {}): TestDeps {
  const state: TestDeps = {
    slept: [],
    opened: 0,
    open: async (): Promise<SnacLink> => {
      const link = links[state.opened];
      state.opened += 1;
      if (!link) throw new Error('no more links scripted');
      return link;
    },
    sleep: async (ms: number): Promise<void> => {
      state.slept.push(ms);
    },
    random: () => 0.5,
    log: quietLog,
    ...over,
  };
  return state;
}

describe('room names and cookies', () => {
  it('names the source of its vectors', () => {
    expect(vectorSource).toContain('open-oscar-server 7bdd674');
  });

  it.each([
    ['4-0-testroom', { exchange: 4, name: 'testroom' }],
    ['5-0-Lobby', { exchange: 5, name: 'lobby' }],
    ['4-0-ops-team', { exchange: 4, name: 'ops-team' }],
    ['4-0-', null],
    ['6-0-nope', null],
    ['testroom', null],
    ['', null],
  ])('reads %s', (cookie, expected) => {
    expect(roomFromCookie(cookie)).toEqual(expected);
  });

  it('lowercases the name in keys and cookies', () => {
    expect(roomKey({ exchange: 4, name: 'TestRoom' })).toBe('4:testroom');
    expect(roomCookie({ exchange: 4, name: 'TestRoom' })).toBe('4-0-testroom');
  });
});

describe('chatnav codecs', () => {
  it('encodes CreateRoom with the name in TLV 0xD3', () => {
    expect(toHex(encodeCreateRoom({ exchange: 4, name: 'testroom' }))).toBe(vectorHex('createRoom'));
  });

  it('sends the room name lowercased', () => {
    expect(toHex(encodeCreateRoom({ exchange: 4, name: 'TestRoom' }))).toBe(vectorHex('createRoom'));
  });

  it('encodes RequestRoomInfo by cookie', () => {
    expect(toHex(encodeRequestRoomInfo(4, '4-0-testroom'))).toBe(vectorHex('requestRoomInfo'));
  });

  it('decodes the room from NavInfo TLV 0x04', () => {
    expect(decodeNavInfo(vector('navInfoRoom'))).toEqual(testroom);
  });

  it.each([
    ['empty body', new Uint8Array(0)],
    ['no TLV 0x04', Uint8Array.from([0x00, 0x02, 0x00, 0x01, 0x0a])],
    ['truncated TLV', vector('navInfoRoom').subarray(0, 12)],
  ])('returns null for %s', (_label, body) => {
    expect(decodeNavInfo(body)).toBeNull();
  });
});

describe('the room info a chat service request carries', () => {
  it('is the exchange, the cookie and instance 0', () => {
    expect(toHex(encodeServiceRoomInfo(testroom))).toBe('00040c342d302d74657374726f6f6d0000');
  });

  it('gives the server\'s own bytes when the one service request encoder wraps it', () => {
    const roomInfo = encodeServiceRoomInfo(testroom);
    expect(toHex(encodeServiceRequest(FAMILY_CHAT, { useSsl: false, roomInfo }))).toBe(vectorHex('serviceRequestChat'));
    expect(toHex(encodeServiceRequest(FAMILY_CHAT, { useSsl: true, roomInfo }))).toBe(vectorHex('serviceRequestChatTls'));
    expect(toHex(encodeServiceRequest(FAMILY_CHATNAV, { useSsl: false }))).toBe(vectorHex('serviceRequestChatNav'));
  });
});

describe('join length guard', () => {
  it.each([
    ['botone', '4-0-testroom', false],
    ['botone', `4-0-${'x'.repeat(170)}`, false],
    ['botone', `4-0-${'x'.repeat(171)}`, true],
    ['b'.repeat(16), `4-0-${'x'.repeat(161)}`, true],
  ])('%s + %s too long: %s', (name, cookie, expected) => {
    expect(joinTooLong(name, cookie)).toBe(expected);
  });
});

describe('requestService', () => {
  const granted: ServiceGrant = { host: '127.0.0.1', port: 5190, cookie: Uint8Array.from([0xaa, 0xbb]), pinned: false, expiresAt: 61_000 };

  function resolver(answer: () => Promise<ServiceGrant>): { resolve: ServiceResolver; asked: { family: number; roomInfo: Uint8Array | undefined }[] } {
    const asked: { family: number; roomInfo: Uint8Array | undefined }[] = [];
    return {
      asked,
      resolve: (family, roomInfo) => {
        asked.push({ family, roomInfo });
        return answer();
      },
    };
  }

  it('asks the one service request for the room and hands its grant back untouched', async () => {
    const r = resolver(async () => granted);
    await expect(requestService(r.resolve, { foodGroup: FAMILY_CHAT, room: testroom, screenName: 'botone' })).resolves.toBe(granted);
    expect(r.asked.map((a) => a.family)).toEqual([FAMILY_CHAT]);
    expect(toHex(r.asked[0]!.roomInfo ?? new Uint8Array(0))).toBe('00040c342d302d74657374726f6f6d0000');
  });

  it('asks for chatnav with no room info', async () => {
    const r = resolver(async () => granted);
    await requestService(r.resolve, { foodGroup: FAMILY_CHATNAV, screenName: 'botone' });
    expect(r.asked).toEqual([{ family: FAMILY_CHATNAV, roomInfo: undefined }]);
  });

  it('never sends a join that is too long', async () => {
    const r = resolver(async () => granted);
    const room: RoomInfo = { exchange: 4, cookie: `4-0-${'x'.repeat(200)}`, name: 'x'.repeat(200) };
    await expect(requestService(r.resolve, { foodGroup: FAMILY_CHAT, room, screenName: 'botone' })).rejects.toMatchObject({ code: 'too-long' });
    expect(r.asked).toHaveLength(0);
  });

  it('refuses a chat request with no resolved room', async () => {
    const r = resolver(async () => granted);
    await expect(requestService(r.resolve, { foodGroup: FAMILY_CHAT, screenName: 'botone' })).rejects.toBeInstanceOf(OscarRoomError);
    expect(r.asked).toHaveLength(0);
  });

  it.each([
    ['ServiceRefusedError', 'service request refused (0x1c)'],
    ['RedirectRefusedError', 'the server answered with the plaintext address'],
  ])('reports unavailable when the session says %s', async (name, message) => {
    const refusal = Object.assign(new Error(message), { name });
    const r = resolver(async () => {
      throw refusal;
    });
    await expect(requestService(r.resolve, { foodGroup: FAMILY_CHAT, room: testroom, screenName: 'botone' })).rejects.toMatchObject({
      code: 'unavailable',
      message,
    });
    expect(r.asked).toHaveLength(1);
  });

  it('reports unavailable for the refusals the session really throws', async () => {
    for (const refusal of [new ServiceRefusedError(0x1c), new RedirectRefusedError('127.0.0.1:5190')]) {
      const r = resolver(async () => {
        throw refusal;
      });
      await expect(requestService(r.resolve, { foodGroup: FAMILY_CHAT, room: testroom, screenName: 'botone' })).rejects.toMatchObject({
        code: 'unavailable',
        message: refusal.message,
      });
    }
  });

  it('reports not-online when BOS is down or closes under the request', async () => {
    for (const failure of [new OscarSendError('not-online'), new Error('connection closed'), new Error('request timed out')]) {
      const r = resolver(async () => {
        throw failure;
      });
      await expect(requestService(r.resolve, { foodGroup: FAMILY_CHATNAV, screenName: 'botone' })).rejects.toMatchObject({ code: 'not-online' });
    }
  });
});

describe('resolveRoom', () => {
  const navInfo = { family: FAMILY_CHATNAV, subtype: CHATNAV_NAV_INFO, body: vector('navInfoRoom') };

  it('creates or joins by name and closes the socket', async () => {
    const link = new FakeLink();
    link.onRequest = () => navInfo;
    const d = deps([link]);
    await expect(resolveRoom({ kind: 'create', room: { exchange: 4, name: 'testroom' } }, d)).resolves.toEqual(testroom);
    expect(link.sentOf(FAMILY_CHATNAV, CHATNAV_CREATE_ROOM)).toHaveLength(1);
    expect(link.closed).toBe(true);
  });

  it('looks an invited room up by cookie', async () => {
    const link = new FakeLink();
    link.onRequest = () => navInfo;
    await resolveRoom({ kind: 'cookie', exchange: 4, cookie: '4-0-testroom' }, deps([link]));
    expect(toHex(link.sentOf(FAMILY_CHATNAV, CHATNAV_REQUEST_ROOM_INFO)[0]!.body)).toBe(vectorHex('requestRoomInfo'));
  });

  it('maps NoMatch to no-such-room without a retry', async () => {
    const link = new FakeLink();
    link.onRequest = () => ({ family: FAMILY_CHATNAV, subtype: CHATNAV_ERR, body: vector('chatNavErrNoMatch') });
    const d = deps([link]);
    await expect(resolveRoom({ kind: 'create', room: { exchange: 5, name: 'lobby' } }, d)).rejects.toMatchObject({ code: 'no-such-room' });
    expect(d.opened).toBe(1);
  });

  it('maps any other chatnav error to unavailable', async () => {
    const link = new FakeLink();
    link.onRequest = () => ({ family: FAMILY_CHATNAV, subtype: CHATNAV_ERR, body: Uint8Array.from([0x00, 0x08]) });
    await expect(resolveRoom({ kind: 'create', room: { exchange: 4, name: 'testroom' } }, deps([link]))).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('reopens the socket when a create is dropped by the race', async () => {
    const loser = new FakeLink();
    loser.onRequest = () => 'drop';
    const second = new FakeLink();
    second.onRequest = () => navInfo;
    const d = deps([loser, second]);
    await expect(resolveRoom({ kind: 'create', room: { exchange: 4, name: 'testroom' } }, d)).resolves.toEqual(testroom);
    expect(d.opened).toBe(2);
    expect(d.slept).toEqual([500]);
  });

  it('stops after three dropped creates', async () => {
    const links = [new FakeLink(), new FakeLink(), new FakeLink()];
    for (const link of links) link.onRequest = () => 'drop';
    const d = deps(links);
    await expect(resolveRoom({ kind: 'create', room: { exchange: 4, name: 'testroom' } }, d)).rejects.toMatchObject({ code: 'unavailable' });
    expect(d.slept).toEqual([500, 1500]);
  });

  it('treats a dropped cookie lookup as a missing room after one retry', async () => {
    const links = [new FakeLink(), new FakeLink()];
    for (const link of links) link.onRequest = () => 'drop';
    const d = deps(links);
    await expect(resolveRoom({ kind: 'cookie', exchange: 4, cookie: '4-0-gone' }, d)).rejects.toMatchObject({ code: 'no-such-room' });
    expect(d.opened).toBe(2);
  });

  it('reports unavailable, not a missing room, when the chatnav socket never opens for a cookie lookup', async () => {
    const d = deps([]);
    await expect(resolveRoom({ kind: 'cookie', exchange: 4, cookie: '4-0-testroom' }, d)).rejects.toMatchObject({ code: 'unavailable' });
    expect(d.opened).toBe(2);
  });

  it('passes a not-online error from open straight through', async () => {
    const d = deps([], {
      open: async () => {
        throw new OscarRoomError('not-online');
      },
    });
    await expect(resolveRoom({ kind: 'create', room: { exchange: 4, name: 'testroom' } }, d)).rejects.toMatchObject({ code: 'not-online' });
    expect(d.slept).toEqual([]);
  });

  it('hands a rate notice seen on the chatnav socket to the BOS governor', async () => {
    const link = new FakeLink();
    const seen: Uint8Array[] = [];
    link.onRequest = () => {
      queueMicrotask(() => link.deliver({ family: FAMILY_OSERVICE, subtype: OSERVICE_RATE_PARAM_CHANGE, body: Uint8Array.from([0x00, 0x03]) }));
      return undefined;
    };
    const d = deps([link], { onStrayRate: (body) => seen.push(body) });
    const pending = resolveRoom({ kind: 'create', room: { exchange: 4, name: 'testroom' } }, d);
    await new Promise((resolve) => setImmediate(resolve));
    link.deliver({ ...navInfo, requestId: link.sent[0]!.requestId });
    await pending;
    expect(seen).toHaveLength(1);
  });
});
