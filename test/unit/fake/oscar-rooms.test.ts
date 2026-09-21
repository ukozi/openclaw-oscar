import { describe, expect, it } from 'vitest';
import { FakeRooms, firstTextToken, serverSeesRoll, type FakeConn, type FakeConnKind, type FakeGeneration } from '../../fake/oscar-rooms.js';
import { encodeServiceRequest as encodeBosServiceRequest, parseInvite } from '../../../src/oscar/bos.js';
import { decodeNavInfo, encodeCreateRoom, encodeRequestRoomInfo, encodeServiceRoomInfo, type RoomInfo } from '../../../src/oscar/chatnav.js';
import { decodeRoomMessage, decodeRoster, encodeClassIds, encodeRoomClientOnline, encodeRoomSend } from '../../../src/oscar/chatroom.js';
import {
  CHATNAV_CREATE_ROOM,
  CHATNAV_ERR,
  CHATNAV_NAV_INFO,
  CHATNAV_REQUEST_ROOM_INFO,
  CHAT_MSG_TO_CLIENT,
  CHAT_MSG_TO_HOST,
  CHAT_USERS_JOINED,
  CHAT_USERS_LEFT,
  FAMILY_CHAT,
  FAMILY_CHATNAV,
  FAMILY_ICBM,
  FAMILY_OSERVICE,
  ICBM_MSG_TO_CLIENT,
  OSERVICE_CLIENT_ONLINE,
  OSERVICE_ERR,
  OSERVICE_HOST_ONLINE,
  OSERVICE_RATE_PARAMS_SUB_ADD,
  OSERVICE_RATE_PARAM_CHANGE,
  OSERVICE_SERVICE_REQUEST,
  OSERVICE_SERVICE_RESPONSE,
} from '../../../src/oscar/constants.js';
import { encodeUserInfo } from '../../../src/oscar/snac.js';
import { decodeTlvs, encodeTlvs, findTlv } from '../../../src/oscar/tlv.js';
import { vector } from '../oscar/room-kit.js';

type Out = { family: number; subtype: number; body: Uint8Array; requestId: number };

class StubConn implements FakeConn {
  readonly out: Out[] = [];
  ended: 'open' | 'destroyed' | 'bare' = 'open';
  constructor(readonly kind: FakeConnKind, readonly display: string) {}
  get name(): string {
    return this.display.replace(/ /g, '').toLowerCase();
  }
  send(family: number, subtype: number, body: Uint8Array, requestId = 0): void {
    this.out.push({ family, subtype, body, requestId });
  }
  destroy(): void {
    this.ended = 'destroyed';
  }
  signoffBare(): void {
    this.ended = 'bare';
  }
  of(family: number, subtype: number): Out[] {
    return this.out.filter((o) => o.family === family && o.subtype === subtype);
  }
}

const testroom = { exchange: 4 as const, name: 'testroom' };
const info: RoomInfo = { exchange: 4, cookie: '4-0-testroom', name: 'testroom' };

// the body the client really sends: P1a's encoder around this plan's room info bytes
function encodeServiceRequest(group: number, room: RoomInfo | undefined, useSsl: boolean): Uint8Array {
  return encodeBosServiceRequest(group, room ? { useSsl, roomInfo: encodeServiceRoomInfo(room) } : { useSsl });
}

function decodeServiceResponse(body: Uint8Array): { address: string; cookie: Uint8Array; sslState: number } | null {
  const tlvs = decodeTlvs(body);
  const address = findTlv(tlvs, 0x0005);
  const cookie = findTlv(tlvs, 0x0006);
  if (!address || !cookie) return null;
  return { address: Buffer.from(address).toString('utf8'), cookie, sslState: findTlv(tlvs, 0x008e)?.[0] ?? 0 };
}

function setup(generation: FakeGeneration = 'main', tlsListener = false) {
  const bos = new Map<string, StubConn>();
  const rooms = new FakeRooms({
    generation: () => generation,
    advertised: () => '127.0.0.1:5190',
    bosConn: (name) => bos.get(name),
    bosUserInfo: (name) => encodeUserInfo({ name: name === 'alice' ? 'Alice' : name, warning: 0, tlvs: [] }),
    sslState: (wantsSsl) => (wantsSsl && tlsListener ? 2 : 0),
  });
  const signOn = (display: string): StubConn => {
    const conn = new StubConn('bos', display);
    bos.set(conn.name, conn);
    return conn;
  };
  const service = (conn: StubConn, body: Uint8Array): StubConn | null => {
    rooms.serviceRequest(conn, 7, body);
    const reply = conn.of(FAMILY_OSERVICE, OSERVICE_SERVICE_RESPONSE).at(-1);
    if (!reply || conn.ended !== 'open') return null;
    const grant = decodeServiceResponse(reply.body);
    const ticket = grant ? rooms.claim(grant.cookie) : null;
    if (!ticket) return null;
    const next = new StubConn(ticket.kind, ticket.display);
    rooms.attach(next, ticket);
    return next;
  };
  const join = (bosConn: StubConn, room = info): StubConn => {
    const chat = service(bosConn, encodeServiceRequest(FAMILY_CHAT, room, false));
    if (!chat) throw new Error('no chat socket');
    rooms.snac(chat, FAMILY_OSERVICE, OSERVICE_RATE_PARAMS_SUB_ADD, 0, encodeClassIds([1, 2, 3, 4, 5]));
    rooms.snac(chat, FAMILY_OSERVICE, OSERVICE_CLIENT_ONLINE, 0, encodeRoomClientOnline());
    return chat;
  };
  return { rooms, signOn, service, join };
}

describe('fake chatnav', () => {
  it('creates a private room on first ask and finds it case-insensitively afterwards', () => {
    const { rooms, signOn, service } = setup();
    const nav = service(signOn('botone'), encodeServiceRequest(FAMILY_CHATNAV, undefined, false));
    rooms.snac(nav!, FAMILY_CHATNAV, CHATNAV_CREATE_ROOM, 1, encodeCreateRoom(testroom));
    rooms.snac(nav!, FAMILY_CHATNAV, CHATNAV_CREATE_ROOM, 2, encodeCreateRoom({ exchange: 4, name: 'TESTROOM' }));
    const replies = nav!.of(FAMILY_CHATNAV, CHATNAV_NAV_INFO);
    expect(replies.map((r) => decodeNavInfo(r.body)?.cookie)).toEqual(['4-0-testroom', '4-0-testroom']);
    expect(replies.map((r) => r.requestId)).toEqual([1, 2]);
  });

  it('keeps the spelling of whoever made the room and hands that cookie to a lowercase ask', () => {
    const { rooms, signOn, service } = setup();
    rooms.addRoom({ exchange: 4, name: 'MixedCase' });
    const nav = service(signOn('botone'), encodeServiceRequest(FAMILY_CHATNAV, undefined, false))!;
    rooms.snac(nav, FAMILY_CHATNAV, CHATNAV_CREATE_ROOM, 1, encodeCreateRoom({ exchange: 4, name: 'mixedcase' }));
    expect(decodeNavInfo(nav.of(FAMILY_CHATNAV, CHATNAV_NAV_INFO)[0]!.body)).toEqual({ exchange: 4, cookie: '4-0-MixedCase', name: 'mixedcase' });
  });

  it('puts a BOS rate notice on the ChatNav socket ahead of the reply, on v0.24 only', () => {
    const old = setup('v0.24');
    old.rooms.strayRateOnNextNav();
    const oldNav = old.service(old.signOn('botone'), encodeServiceRequest(FAMILY_CHATNAV, undefined, false))!;
    old.rooms.snac(oldNav, FAMILY_CHATNAV, CHATNAV_CREATE_ROOM, 1, encodeCreateRoom(testroom));
    const order = oldNav.out.filter((o) => o.subtype !== OSERVICE_HOST_ONLINE).map((o) => [o.family, o.subtype]);
    expect(order).toEqual([[FAMILY_OSERVICE, OSERVICE_RATE_PARAM_CHANGE], [FAMILY_CHATNAV, CHATNAV_NAV_INFO]]);
    expect(Buffer.from(oldNav.of(FAMILY_OSERVICE, OSERVICE_RATE_PARAM_CHANGE)[0]!.body).readUInt16BE(2)).toBe(3);
    const main = setup('main');
    main.rooms.strayRateOnNextNav();
    const mainNav = main.service(main.signOn('botone'), encodeServiceRequest(FAMILY_CHATNAV, undefined, false))!;
    main.rooms.snac(mainNav, FAMILY_CHATNAV, CHATNAV_CREATE_ROOM, 1, encodeCreateRoom(testroom));
    expect(mainNav.of(FAMILY_OSERVICE, OSERVICE_RATE_PARAM_CHANGE)).toEqual([]);
  });

  it('answers NoMatch for a public room nobody created, and finds one added by the operator', () => {
    const { rooms, signOn, service } = setup();
    const nav = service(signOn('botone'), encodeServiceRequest(FAMILY_CHATNAV, undefined, false))!;
    rooms.snac(nav, FAMILY_CHATNAV, CHATNAV_CREATE_ROOM, 1, encodeCreateRoom({ exchange: 5, name: 'lobby' }));
    expect(nav.of(FAMILY_CHATNAV, CHATNAV_ERR)[0]?.body).toEqual(Buffer.from([0x00, 0x14]));
    rooms.addRoom({ exchange: 5, name: 'lobby' });
    rooms.snac(nav, FAMILY_CHATNAV, CHATNAV_CREATE_ROOM, 2, encodeCreateRoom({ exchange: 5, name: 'lobby' }));
    expect(decodeNavInfo(nav.of(FAMILY_CHATNAV, CHATNAV_NAV_INFO)[0]!.body)?.cookie).toBe('5-0-lobby');
  });

  it('drops the socket of the loser of a create race and keeps the room', () => {
    const { rooms, signOn, service } = setup();
    rooms.raceNextCreate();
    const bos = signOn('botone');
    const loser = service(bos, encodeServiceRequest(FAMILY_CHATNAV, undefined, false))!;
    rooms.snac(loser, FAMILY_CHATNAV, CHATNAV_CREATE_ROOM, 1, encodeCreateRoom(testroom));
    expect(loser.ended).toBe('destroyed');
    const again = service(bos, encodeServiceRequest(FAMILY_CHATNAV, undefined, false))!;
    rooms.snac(again, FAMILY_CHATNAV, CHATNAV_CREATE_ROOM, 2, encodeCreateRoom(testroom));
    expect(again.of(FAMILY_CHATNAV, CHATNAV_NAV_INFO)).toHaveLength(1);
  });

  it('drops the socket on a room info request for an unknown cookie', () => {
    const { rooms, signOn, service } = setup();
    const nav = service(signOn('botone'), encodeServiceRequest(FAMILY_CHATNAV, undefined, false))!;
    rooms.snac(nav, FAMILY_CHATNAV, CHATNAV_REQUEST_ROOM_INFO, 1, encodeRequestRoomInfo(4, '4-0-gone'));
    expect(nav.ended).toBe('destroyed');
  });
});

describe('fake service requests', () => {
  it('drops BOS on a chat request for a cookie it does not know', () => {
    const { rooms, signOn } = setup();
    const bos = signOn('botone');
    rooms.serviceRequest(bos, 1, encodeServiceRequest(FAMILY_CHAT, info, false));
    expect(bos.ended).toBe('destroyed');
  });

  it('drops BOS when name plus cookie pass 202 bytes', () => {
    const { rooms, signOn } = setup();
    const long = 'x'.repeat(200);
    rooms.addRoom({ exchange: 4, name: long });
    const bos = signOn('botone');
    rooms.serviceRequest(bos, 1, encodeServiceRequest(FAMILY_CHAT, { exchange: 4, cookie: `4-0-${long}`, name: long }, false));
    expect(bos.ended).toBe('destroyed');
  });

  it('answers 0x01/0x01 to TLV 0x8C on v0.24 and a plaintext redirect on main', () => {
    const old = setup('v0.24');
    const oldBos = old.signOn('botone');
    old.rooms.serviceRequest(oldBos, 1, encodeServiceRequest(FAMILY_CHATNAV, undefined, true));
    expect(oldBos.of(FAMILY_OSERVICE, OSERVICE_ERR)[0]?.body).toEqual(Buffer.from([0x00, 0x1c]));
    const main = setup('main');
    const mainBos = main.signOn('botone');
    main.rooms.serviceRequest(mainBos, 1, encodeServiceRequest(FAMILY_CHATNAV, undefined, true));
    expect(decodeServiceResponse(mainBos.of(FAMILY_OSERVICE, OSERVICE_SERVICE_RESPONSE)[0]!.body)?.sslState).toBe(0);
  });

  it('lays a service response out as the server does', () => {
    expect(decodeServiceResponse(vector('serviceResponse'))).toEqual({
      address: '127.0.0.1:5190',
      cookie: Uint8Array.from([0xaa, 0xbb, 0xcc, 0xdd]),
      sslState: 0,
    });
    const { rooms, signOn } = setup();
    const bos = signOn('botone');
    rooms.serviceRequest(bos, 1, encodeServiceRequest(FAMILY_CHATNAV, undefined, false));
    const tags = (body: Uint8Array): number[] => decodeTlvs(body).map((t) => t.tag);
    expect(tags(bos.of(FAMILY_OSERVICE, OSERVICE_SERVICE_RESPONSE)[0]!.body)).toEqual(tags(vector('serviceResponse')));
  });

  it('takes the SSL state of a service response from the server it sits in', () => {
    const secure = setup('main', true);
    const bos = secure.signOn('botone');
    secure.rooms.serviceRequest(bos, 1, encodeServiceRequest(FAMILY_CHATNAV, undefined, true));
    secure.rooms.serviceRequest(bos, 2, encodeServiceRequest(FAMILY_CHATNAV, undefined, false));
    const states = bos.of(FAMILY_OSERVICE, OSERVICE_SERVICE_RESPONSE).map((o) => decodeServiceResponse(o.body)?.sslState);
    expect(states).toEqual([2, 0]);
  });

  it('refuses a service request that does not come from BOS', () => {
    const { rooms, signOn, service } = setup();
    const nav = service(signOn('botone'), encodeServiceRequest(FAMILY_CHATNAV, undefined, false))!;
    rooms.snac(nav, FAMILY_OSERVICE, OSERVICE_SERVICE_REQUEST, 5, encodeServiceRequest(FAMILY_CHATNAV, undefined, false));
    expect(nav.of(FAMILY_OSERVICE, OSERVICE_ERR)[0]?.body).toEqual(Buffer.from([0x00, 0x08]));
  });
});

describe('fake rooms', () => {
  it('sends the joiner the full roster and tells the others', () => {
    const { rooms, signOn, join } = setup();
    rooms.addRoom(testroom);
    rooms.peerJoin('Alice', testroom);
    const one = join(signOn('Bot One'));
    const two = join(signOn('bottwo'));
    expect(decodeRoster(one.of(FAMILY_CHAT, CHAT_USERS_JOINED)[0]!.body).map((u) => u.name)).toEqual(['Alice', 'Bot One']);
    expect(decodeRoster(one.of(FAMILY_CHAT, CHAT_USERS_JOINED)[1]!.body).map((u) => u.name)).toEqual(['bottwo']);
    expect(decodeRoster(two.of(FAMILY_CHAT, CHAT_USERS_JOINED)[0]!.body)).toHaveLength(3);
    expect(rooms.occupants(testroom)).toEqual(['alice', 'botone', 'bottwo']);
  });

  it('relays to everyone but the sender, reflects only on TLV 0x06, and strips extra inner TLVs', () => {
    const { rooms, signOn, join } = setup();
    rooms.addRoom(testroom);
    const one = join(signOn('botone'));
    const two = join(signOn('bottwo'));
    rooms.snac(one, FAMILY_CHAT, CHAT_MSG_TO_HOST, 9, encodeRoomSend({ cookie: 5n, text: 'hello' }));
    expect(one.of(FAMILY_CHAT, CHAT_MSG_TO_CLIENT).map((o) => o.requestId)).toEqual([9]);
    const seen = decodeRoomMessage(two.of(FAMILY_CHAT, CHAT_MSG_TO_CLIENT)[0]!.body);
    expect(seen).toMatchObject({ cookie: 5n, isPublic: true, encoding: 'us-ascii' });
    const bare = Buffer.concat([
      Buffer.alloc(8, 1),
      Buffer.from([0x00, 0x03]),
      Buffer.from(encodeTlvs([{ tag: 0x01, value: new Uint8Array(0) }, { tag: 0x05, value: encodeTlvs([{ tag: 0x01, value: Buffer.from('x') }, { tag: 0x99, value: Buffer.from('meta') }]) }])),
    ]);
    rooms.snac(two, FAMILY_CHAT, CHAT_MSG_TO_HOST, 10, bare);
    expect(two.of(FAMILY_CHAT, CHAT_MSG_TO_CLIENT)).toHaveLength(1);
    expect(Buffer.from(one.of(FAMILY_CHAT, CHAT_MSG_TO_CLIENT)[1]!.body).includes(Buffer.from('meta'))).toBe(false);
  });

  it('whispers to one occupant with no TLV 0x01 and still reflects', () => {
    const { rooms, signOn, join } = setup();
    rooms.addRoom(testroom);
    const one = join(signOn('botone'));
    const two = join(signOn('bottwo'));
    const three = join(signOn('botthree'));
    rooms.snac(one, FAMILY_CHAT, CHAT_MSG_TO_HOST, 9, encodeRoomSend({ cookie: 6n, text: '#oc took k', whisperTo: 'Bot Two' }));
    expect(decodeRoomMessage(two.of(FAMILY_CHAT, CHAT_MSG_TO_CLIENT)[0]!.body)?.isPublic).toBe(false);
    expect(three.of(FAMILY_CHAT, CHAT_MSG_TO_CLIENT)).toHaveLength(0);
    expect(one.of(FAMILY_CHAT, CHAT_MSG_TO_CLIENT)).toHaveLength(1);
  });

  it('drops the room socket for a message with no text TLV', () => {
    const { rooms, signOn, join } = setup();
    rooms.addRoom(testroom);
    const one = join(signOn('botone'));
    rooms.snac(one, FAMILY_CHAT, CHAT_MSG_TO_HOST, 1, Buffer.concat([Buffer.alloc(8, 1), Buffer.from([0x00, 0x03])]));
    expect(one.ended).toBe('destroyed');
  });

  it('rewrites //roll into an OnlineHost line', () => {
    const { rooms, signOn, join } = setup();
    rooms.addRoom(testroom);
    const one = join(signOn('botone'));
    rooms.snac(one, FAMILY_CHAT, CHAT_MSG_TO_HOST, 1, encodeRoomSend({ cookie: 7n, text: '//roll' }));
    expect(decodeRoomMessage(one.of(FAMILY_CHAT, CHAT_MSG_TO_CLIENT)[0]!.body)?.sender.name).toBe('OnlineHost');
  });

  it('decides //roll on the first text token after entity decoding, as the server does', () => {
    const { rooms, signOn, join } = setup();
    rooms.addRoom(testroom);
    const one = join(signOn('botone'));
    const senderOf = (text: string): string | undefined => {
      rooms.snac(one, FAMILY_CHAT, CHAT_MSG_TO_HOST, 1, encodeRoomSend({ cookie: 7n, text }));
      return decodeRoomMessage(one.of(FAMILY_CHAT, CHAT_MSG_TO_CLIENT).at(-1)!.body)?.sender.name;
    };
    for (const rolls of ['<B>//roll</B>', '&#47;/roll', '&#x2F;&#47;roll-dice4', '//roll-sides8 <BR>and more', '<HTML><BODY>//roll</BODY></HTML>']) {
      expect(senderOf(rolls), rolls).toBe('OnlineHost');
    }
    for (const stays of [' //roll', '<B> //roll</B>', ' &#47;/roll', 'ok<BR>//roll', '<B> </B>//roll', '//roll now', '&amp;#47;/roll']) {
      expect(senderOf(stays), stays).toBe('botone');
    }
  });

  it.each([
    ['//roll', '//roll'],
    ['<B>//roll</B>', '//roll'],
    ['<A HREF="http://example.net/?a>b">//roll</A>', '//roll'],
    ['<!-- x > y -->//roll', '//roll'],
    ['</>//roll', '//roll'],
    ['&#47&#47roll', '//roll'],
    ['&#0000000047;/roll', '//roll'],
    ['&sol;&sol;roll', '//roll'],
    ['//&#114;oll', '//roll'],
    ['//roll\r\n', '//roll\n'],
    ['<B> </B>//roll', ' '],
    ['< //roll', '< //roll'],
    ['//roll < 3<BR>x', '//roll < 3'],
    ['&amp;#47;/roll', '&#47;/roll'],
    ['a &lt; b', 'a < b'],
    ['<BR>', ''],
    ['', ''],
  ])('reads the first text token of %j as %j', (html, token) => {
    expect(firstTextToken(html)).toBe(token);
  });

  it.each([
    ['//roll', true],
    ['//roll-dice4-sides8 ', true],
    ['//roll\n', true],
    ['//roll-dice15-sides999', true],
    ['//roll-dice4-dice2', false],
    ['//roll-dice16', false],
    ['//roll-sides0', false],
    ['//roll-dice1000', false],
    ['//rolling', false],
    [' //roll', false],
    ['x//roll', false],
  ])('applies the server pattern to %j: %s', (html, rolls) => {
    expect(serverSeesRoll(html)).toBe(rolls);
  });

  it('evicts the first socket with a bare signoff when the same name joins again', () => {
    const { rooms, signOn, join } = setup();
    rooms.addRoom(testroom);
    const bos = signOn('botone');
    const watcher = join(signOn('bottwo'));
    const first = join(bos);
    const second = join(bos);
    expect(first.ended).toBe('bare');
    expect(second.ended).toBe('open');
    expect(watcher.of(FAMILY_CHAT, CHAT_USERS_LEFT)).toHaveLength(1);
    expect(rooms.occupants(testroom)).toEqual(['bottwo', 'botone']);
  });

  it('evicts on request with a bare signoff and tells the room', () => {
    const { rooms, signOn, join } = setup();
    rooms.addRoom(testroom);
    const watcher = join(signOn('bottwo'));
    const one = join(signOn('botone'));
    rooms.evict('botone', testroom);
    expect(one.ended).toBe('bare');
    expect(watcher.of(FAMILY_CHAT, CHAT_USERS_LEFT)).toHaveLength(1);
    expect(() => rooms.evict('botone', testroom)).toThrow('has no socket');
  });

  it('takes a peer out of every room when it signs off', () => {
    const { rooms } = setup();
    rooms.peerJoin('Alice', testroom);
    rooms.peerJoin('Alice', { exchange: 4, name: 'side' });
    rooms.peerLeaveAll('alice');
    expect(rooms.occupants(testroom)).toEqual([]);
    expect(rooms.occupants({ exchange: 4, name: 'side' })).toEqual([]);
  });

  it('answers the liveness probe on a room socket', () => {
    const { rooms, signOn, join } = setup();
    rooms.addRoom(testroom);
    const one = join(signOn('botone'));
    rooms.snac(one, FAMILY_OSERVICE, 0x001f, 42, new Uint8Array(0));
    expect(one.of(FAMILY_OSERVICE, 0x0020).map((o) => o.requestId)).toEqual([42]);
  });

  it('closes every room of a name whose BOS session ended', () => {
    const { rooms, signOn, join } = setup();
    rooms.addRoom(testroom);
    const chat = join(signOn('botone'));
    rooms.bosGone('botone');
    expect(chat.ended).toBe('bare');
    expect(rooms.occupants(testroom)).toEqual([]);
  });

  it('drops sends while limited and pushes the notice only to a subscribed socket', () => {
    const { rooms, signOn, join, service } = setup();
    rooms.addRoom(testroom);
    const one = join(signOn('botone'));
    rooms.setRoomRate('botone', testroom, 'limited');
    expect(Buffer.from(one.of(FAMILY_OSERVICE, OSERVICE_RATE_PARAM_CHANGE)[0]!.body).readUInt16BE(0)).toBe(3);
    rooms.snac(one, FAMILY_CHAT, CHAT_MSG_TO_HOST, 1, encodeRoomSend({ cookie: 8n, text: 'lost' }));
    expect(one.of(FAMILY_CHAT, CHAT_MSG_TO_CLIENT)).toHaveLength(0);
    rooms.setRoomRate('botone', testroom, 'clear');
    expect(Buffer.from(one.of(FAMILY_OSERVICE, OSERVICE_RATE_PARAM_CHANGE)[1]!.body).readUInt16BE(0)).toBe(4);

    const quiet = service(signOn('bottwo'), encodeServiceRequest(FAMILY_CHAT, info, false))!;
    rooms.snac(quiet, FAMILY_OSERVICE, OSERVICE_CLIENT_ONLINE, 0, encodeRoomClientOnline());
    rooms.setRoomRate('bottwo', testroom, 'limited');
    expect(quiet.of(FAMILY_OSERVICE, OSERVICE_RATE_PARAM_CHANGE)).toHaveLength(0);
  });
});

describe('fake peers', () => {
  it('speaks like a TOC occupant: cookie 0, text TLV only, raw UTF-8', () => {
    const { rooms, signOn, join } = setup();
    rooms.peerJoin('Alice', testroom);
    const one = join(signOn('botone'));
    rooms.peerSay('Alice', testroom, 'café', { toc: true, cookie: 99n });
    const msg = decodeRoomMessage(one.of(FAMILY_CHAT, CHAT_MSG_TO_CLIENT)[0]!.body);
    expect(msg).toMatchObject({ cookie: 0n, isPublic: true });
    expect(msg?.encoding).toBeUndefined();
    expect(Buffer.from(msg!.text)).toEqual(Buffer.from('café', 'utf8'));
  });

  it('speaks like a native occupant with an encoding TLV and a non-zero cookie', () => {
    const { rooms, signOn, join } = setup();
    rooms.peerJoin('Alice', testroom);
    const one = join(signOn('botone'));
    rooms.peerSay('Alice', testroom, 'café');
    const msg = decodeRoomMessage(one.of(FAMILY_CHAT, CHAT_MSG_TO_CLIENT)[0]!.body);
    expect(msg?.encoding).toBe('unicode-2-0');
    expect(msg?.cookie).not.toBe(0n);
  });

  it('records what a peer saw, whispers included', () => {
    const { rooms, signOn, join } = setup();
    rooms.peerJoin('Alice', testroom);
    const one = join(signOn('botone'));
    rooms.snac(one, FAMILY_CHAT, CHAT_MSG_TO_HOST, 1, encodeRoomSend({ cookie: 1n, text: 'to all' }));
    rooms.snac(one, FAMILY_CHAT, CHAT_MSG_TO_HOST, 2, encodeRoomSend({ cookie: 2n, text: 'to alice', whisperTo: 'alice' }));
    expect(rooms.peerLines('Alice', testroom)).toEqual([
      { from: 'botone', text: 'to all', whisper: false },
      { from: 'botone', text: 'to alice', whisper: true },
    ]);
  });

  it('sends an invite the client parser accepts', () => {
    const { rooms, signOn } = setup();
    rooms.peerJoin('Alice', testroom);
    const bos = signOn('botone');
    rooms.peerInvite('Alice', 'botone', testroom, 'come in');
    const snac = bos.of(FAMILY_ICBM, ICBM_MSG_TO_CLIENT)[0]!;
    expect(parseInvite(snac.body)).toEqual({ from: 'alice', fromDisplay: 'Alice', room: testroom, roomCookie: '4-0-testroom', text: 'come in' });
  });

  it('forgets occupants but keeps rooms across a restart', () => {
    const { rooms, signOn, service } = setup();
    rooms.peerJoin('Alice', testroom);
    rooms.reset();
    expect(rooms.occupants(testroom)).toEqual([]);
    const nav = service(signOn('botone'), encodeServiceRequest(FAMILY_CHATNAV, undefined, false))!;
    rooms.snac(nav, FAMILY_CHATNAV, CHATNAV_REQUEST_ROOM_INFO, 1, encodeRequestRoomInfo(4, '4-0-testroom'));
    expect(nav.of(FAMILY_CHATNAV, CHATNAV_NAV_INFO)).toHaveLength(1);
  });
});
