import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { toWireHtml } from '../../src/oscar/text.js';
import { decodeTlvs, findTlv } from '../../src/oscar/tlv.js';
import { FakeOscarServer, type FakeGeneration } from '../fake/oscar-server.js';
import { chatSends, serviceRequests, signOn, until, type Bot } from './room-kit.js';

const testroom = { exchange: 4 as const, name: 'testroom' };

describe.each<FakeGeneration>(['v0.24', 'main'])('joining rooms on %s', (generation) => {
  let server: FakeOscarServer;
  let bot: Bot;

  beforeEach(async () => {
    server = await FakeOscarServer.start({ generation });
    bot = await signOn(server, 'botone');
  });

  afterEach(async () => {
    await bot.session.stop();
    await server.stop();
  });

  it('joins a private room, creating it, and reports who is there', async () => {
    server.peer('alice').joinRoom(testroom);
    await bot.session.joinRoom(testroom);
    expect(bot.seen.roomReady).toEqual([{ room: testroom, occupants: expect.arrayContaining(['alice', 'botone']) }]);
    expect(bot.session.rooms()).toMatchObject([{ room: testroom }]);
    expect(server.occupants(testroom)).toContain('botone');
  });

  it('resolves through chatnav before asking BOS for the room, and subscribes to rates before going online there', async () => {
    await bot.session.joinRoom(testroom);
    const wire = server
      .snacsFrom('botone')
      .filter((s) => s.conn !== 'auth' && s.subtype !== 0x001f && (s.conn !== 'bos' || (s.family === 0x0001 && s.subtype === 0x0004)))
      .map((s) => `${s.conn}:${s.family.toString(16)}/${s.subtype.toString(16)}`);
    expect(wire).toEqual(['bos:1/4', 'chatnav:d/8', 'bos:1/4', 'chat:1/6', 'chat:1/8', 'chat:1/2']);
    expect(serviceRequests(server, 'botone')).toEqual([0x000d, 0x000e]);
  });
});

describe('rooms', () => {
  let server: FakeOscarServer;
  let bot: Bot;

  beforeEach(async () => {
    server = await FakeOscarServer.start();
    bot = await signOn(server, 'botone');
  });

  afterEach(async () => {
    await bot.session.stop();
    await server.stop();
  });

  it('reports a public room nobody created, stays online, and joins once it exists', async () => {
    const lobby = { exchange: 5 as const, name: 'lobby' };
    await expect(bot.session.joinRoom(lobby)).rejects.toMatchObject({ code: 'no-such-room' });
    expect(bot.session.getState().phase).toBe('online');
    expect(serviceRequests(server, 'botone')).toEqual([0x000d]);
    server.addRoom(lobby);
    await bot.session.joinRoom(lobby);
    expect(server.occupants(lobby)).toEqual(['botone']);
  });

  it('gets in even when it loses the race to create the room', async () => {
    server.raceNextCreate();
    await bot.session.joinRoom(testroom);
    const creates = server.snacsFrom('botone').filter((s) => s.conn === 'chatnav' && s.subtype === 0x0008);
    expect(creates).toHaveLength(2);
    expect(bot.session.getState().phase).toBe('online');
  });

  it('never sends a join over 180 bytes', async () => {
    await expect(bot.session.joinRoom({ exchange: 4, name: 'x'.repeat(200) })).rejects.toMatchObject({ code: 'too-long' });
    expect(serviceRequests(server, 'botone')).toEqual([]);
    expect(bot.session.getState().phase).toBe('online');
  });

  it('reports people coming and going', async () => {
    await bot.session.joinRoom(testroom);
    const alice = server.peer('Alice');
    alice.joinRoom(testroom);
    await until(() => bot.seen.roomJoin.length === 1, 'roomJoin');
    alice.leaveRoom(testroom);
    await until(() => bot.seen.roomLeave.length === 1, 'roomLeave');
    expect(bot.seen.roomJoin[0]).toEqual({ room: testroom, name: 'alice', display: 'Alice' });
    expect(bot.session.rooms()[0]?.occupants).toEqual(['botone']);
  });

  it('delivers a line as plain text with its cookie', async () => {
    const alice = server.peer('alice');
    alice.joinRoom(testroom);
    await bot.session.joinRoom(testroom);
    alice.say(testroom, '<B>hello</B> room', { cookie: 77n });
    const line = await until(() => bot.seen.roomMessage[0], 'roomMessage');
    expect(line).toEqual({
      room: testroom,
      from: 'alice',
      fromDisplay: 'alice',
      text: 'hello room',
      cookie: 77n,
      whisper: false,
      serverGenerated: false,
    });
  });

  it('delivers every line from a TOC occupant: cookie 0, no encoding TLV, UTF-8 bytes', async () => {
    const alice = server.peer('alice');
    alice.joinRoom(testroom);
    await bot.session.joinRoom(testroom);
    alice.say(testroom, 'café', { toc: true });
    alice.say(testroom, 'café', { toc: true });
    await until(() => bot.seen.roomMessage.length === 2, 'two lines');
    expect(bot.seen.roomMessage.map((m) => [m.text, m.cookie])).toEqual([['café', 0n], ['café', 0n]]);
  });

  it('marks a whisper by the missing public flag and never sees whispers to others', async () => {
    const alice = server.peer('alice');
    alice.joinRoom(testroom);
    server.peer('bob').joinRoom(testroom);
    await bot.session.joinRoom(testroom);
    alice.say(testroom, 'not for you', { whisperTo: 'bob' });
    alice.say(testroom, 'psst', { whisperTo: 'botone' });
    const line = await until(() => bot.seen.roomMessage[0], 'whisper');
    expect(line).toMatchObject({ text: 'psst', whisper: true });
    expect(bot.seen.roomMessage).toHaveLength(1);
  });

  it('surfaces a line the server rewrote into an OnlineHost line, marked as the server\'s own', async () => {
    const alice = server.peer('alice');
    alice.joinRoom(testroom);
    await bot.session.joinRoom(testroom);
    alice.say(testroom, '//roll');
    alice.say(testroom, 'after the dice');
    await until(() => bot.seen.roomMessage.length === 2, 'two lines');
    expect(bot.seen.roomMessage.map((m) => [m.from, m.text, m.serverGenerated])).toEqual([
      ['onlinehost', 'alice rolled 2 6-sided dice: 3 4', true],
      ['alice', 'after the dice', false],
    ]);
  });

  it('takes its own receipt from a line the server rewrote, sending it once and reading no rate limit', async () => {
    const alice = server.peer('alice');
    alice.joinRoom(testroom);
    await bot.session.joinRoom(testroom);
    // the outbound converter guards a leading //roll; this is the raw HTML the server would rewrite
    const receipt = await bot.session.sendRoom(testroom, '//roll');
    expect(chatSends(server, 'botone')).toHaveLength(1);
    expect(Buffer.from(chatSends(server, 'botone')[0]!).readBigUInt64BE(0).toString(16)).toBe(receipt.id);
    expect(bot.seen.rate).toEqual([]);
    expect(bot.seen.roomMessage.map((m) => [m.from, m.serverGenerated])).toEqual([['onlinehost', true]]);
    expect(alice.roomLines(testroom)).toEqual([
      { from: 'onlinehost', text: '<HTML><BODY>botone rolled 2 6-sided dice: 3 4</BODY></HTML>', whisper: false },
    ]);
  });

  it('sends with TLVs 0x01 and 0x06 and a non-zero cookie, takes the reflection as receipt, and never hears itself', async () => {
    const alice = server.peer('alice');
    alice.joinRoom(testroom);
    await bot.session.joinRoom(testroom);
    const receipt = await bot.session.sendRoom(testroom, 'café time');
    expect(receipt.storedOffline).toBe(false);
    const body = chatSends(server, 'botone')[0]!;
    expect(Buffer.from(body).readBigUInt64BE(0)).not.toBe(0n);
    expect(Buffer.from(body).readBigUInt64BE(0).toString(16)).toBe(receipt.id);
    const tlvs = decodeTlvs(body.subarray(10));
    expect(findTlv(tlvs, 0x01)).toBeDefined();
    expect(findTlv(tlvs, 0x06)).toBeDefined();
    expect(alice.roomLines(testroom)).toEqual([{ from: 'botone', text: 'caf&#233; time', whisper: false }]);
    expect(bot.seen.roomMessage).toEqual([]);
  });

  it('keeps a leading space, so a guarded //roll arrives as the bot\'s own line and not as dice', async () => {
    const alice = server.peer('alice');
    alice.joinRoom(testroom);
    await bot.session.joinRoom(testroom);
    await bot.session.sendRoom(testroom, toWireHtml('//roll'));
    await bot.session.sendRoom(testroom, toWireHtml('**//roll-dice4**'));
    const texts = chatSends(server, 'botone').map((body) => {
      const inner = decodeTlvs(findTlv(decodeTlvs(body.subarray(10)), 0x05) ?? new Uint8Array(0));
      return Buffer.from(findTlv(inner, 0x01) ?? new Uint8Array(0)).toString('latin1');
    });
    expect(texts).toEqual([' //roll', '<B> //roll-dice4</B>']);
    expect(alice.roomLines(testroom)).toEqual([
      { from: 'botone', text: ' //roll', whisper: false },
      { from: 'botone', text: '<B> //roll-dice4</B>', whisper: false },
    ]);
  });

  it('whispers to one occupant', async () => {
    const alice = server.peer('alice');
    const bob = server.peer('bob');
    alice.joinRoom(testroom);
    bob.joinRoom(testroom);
    await bot.session.joinRoom(testroom);
    await bot.session.sendRoom(testroom, '#oc took k', { whisperTo: 'bob', priority: 'control' });
    expect(bob.roomLines(testroom)).toEqual([{ from: 'botone', text: '#oc took k', whisper: true }]);
    expect(alice.roomLines(testroom)).toEqual([]);
    const tlvs = decodeTlvs(chatSends(server, 'botone')[0]!.subarray(10));
    expect(findTlv(tlvs, 0x01)).toBeUndefined();
  });

  it('fails a send to a room it is not in', async () => {
    await expect(bot.session.sendRoom(testroom, 'hi')).rejects.toMatchObject({ code: 'room-not-joined' });
  });

  it('leaves by closing the socket', async () => {
    await bot.session.joinRoom(testroom);
    await bot.session.leaveRoom(testroom);
    await until(() => server.occupants(testroom).length === 0, 'seat freed');
    expect(bot.seen.roomClosed).toEqual([{ room: testroom, willRejoin: false }]);
    expect(bot.session.rooms()).toEqual([]);
  });
});

describe('invites', () => {
  let server: FakeOscarServer;
  let bot: Bot;

  beforeEach(async () => {
    server = await FakeOscarServer.start();
    bot = await signOn(server, 'botone');
  });

  afterEach(async () => {
    await bot.session.stop();
    await server.stop();
  });

  it('surfaces an invite as an invite and not as an IM', async () => {
    const alice = server.peer('Alice');
    alice.joinRoom(testroom);
    alice.invite('botone', testroom, 'come in');
    const invite = await until(() => bot.seen.invite[0], 'invite');
    expect(invite).toEqual({ from: 'alice', fromDisplay: 'Alice', room: testroom, roomCookie: '4-0-testroom', text: 'come in' });
    expect(bot.seen.im).toEqual([]);
    expect(server.snacsFrom('botone').filter((s) => s.family === 0x0004 && s.subtype === 0x0006)).toEqual([]);
  });

  it('joins the invited room by cookie, once', async () => {
    const alice = server.peer('alice');
    alice.joinRoom(testroom);
    alice.invite('botone', testroom);
    const invite = await until(() => bot.seen.invite[0], 'invite');
    await bot.session.joinInvited(invite);
    await bot.session.joinInvited(invite);
    expect(server.occupants(testroom)).toEqual(['alice', 'botone']);
    const nav = server.snacsFrom('botone').filter((s) => s.conn === 'chatnav');
    expect(nav.map((s) => s.subtype)).toEqual([0x0004]);
    expect(serviceRequests(server, 'botone')).toEqual([0x000d, 0x000e]);
  });

  it('does not ask BOS for a room that is gone, and stays online with its other rooms', async () => {
    await bot.session.joinRoom(testroom);
    server.peer('alice').invite('botone', { exchange: 4, name: 'ghost' });
    const invite = await until(() => bot.seen.invite[0], 'invite');
    await expect(bot.session.joinInvited(invite)).rejects.toMatchObject({ code: 'no-such-room' });
    expect(serviceRequests(server, 'botone').filter((g) => g === 0x000e)).toHaveLength(1);
    expect(bot.session.getState().phase).toBe('online');
    expect(bot.session.rooms().map((r) => r.room.name)).toEqual(['testroom']);
  });

  it('refuses an invite whose room name would overflow the service cookie', async () => {
    const long = { exchange: 4 as const, name: 'y'.repeat(200) };
    const alice = server.peer('alice');
    alice.joinRoom(long);
    alice.invite('botone', long);
    const invite = await until(() => bot.seen.invite[0], 'invite');
    await expect(bot.session.joinInvited(invite)).rejects.toMatchObject({ code: 'too-long' });
    expect(serviceRequests(server, 'botone')).toEqual([]);
    expect(bot.session.getState().phase).toBe('online');
  });
});

describe('losing and regaining rooms', () => {
  let server: FakeOscarServer;
  let bot: Bot;

  beforeEach(async () => {
    server = await FakeOscarServer.start();
    bot = await signOn(server, 'botone');
  });

  afterEach(async () => {
    await bot.session.stop();
    await server.stop();
  });

  it('rejoins after the server takes the seat with a bare signoff', async () => {
    await bot.session.joinRoom(testroom);
    server.evictFromRoom('botone', testroom);
    await until(() => bot.seen.roomReady.length === 2, 'second roomReady');
    expect(bot.seen.roomClosed).toEqual([{ room: testroom, willRejoin: true }]);
    expect(serviceRequests(server, 'botone').filter((g) => g === 0x000e)).toHaveLength(2);
    expect(bot.session.getState().phase).toBe('online');
  });

  it('rejoins after the room socket dies, and fails the send that was in flight', async () => {
    await bot.session.joinRoom(testroom);
    server.setRate('botone', testroom, 'limited', { silent: true });
    const pending = bot.session.sendRoom(testroom, 'lost');
    const failed = expect(pending).rejects.toMatchObject({ code: 'closed' });
    await until(() => chatSends(server, 'botone').length === 1, 'the send');
    server.dropSocket('botone', 'chat', testroom);
    await failed;
    await until(() => bot.seen.roomReady.length === 2, 'second roomReady');
  });

  it('comes back to its persistent room and its invited room after BOS drops', async () => {
    const alice = server.peer('alice');
    const side = { exchange: 4 as const, name: 'side' };
    alice.joinRoom(side);
    await bot.session.joinRoom(testroom, { persistent: true });
    alice.invite('botone', side);
    await bot.session.joinInvited(await until(() => bot.seen.invite[0], 'invite'));
    server.dropSocket('botone', 'bos');
    await until(() => bot.seen.roomReady.length === 4, 'both rooms again', 8000);
    expect(bot.seen.roomClosed).toEqual(
      expect.arrayContaining([
        { room: testroom, willRejoin: true },
        { room: side, willRejoin: true },
      ]),
    );
    expect(server.occupants(testroom)).toEqual(['botone']);
    expect(server.occupants(side)).toEqual(expect.arrayContaining(['botone']));
  });

  it('comes back after a server restart', async () => {
    await bot.session.joinRoom(testroom, { persistent: true });
    await server.restart();
    await until(() => bot.seen.roomReady.length === 2, 'rejoined', 8000);
    expect(server.occupants(testroom)).toEqual(['botone']);
  });

  it('closes its rooms on stop', async () => {
    await bot.session.joinRoom(testroom);
    await bot.session.stop();
    await until(() => server.occupants(testroom).length === 0, 'seat freed');
    expect(bot.session.rooms()).toEqual([]);
  });
});

describe('a v0.24 server', () => {
  it('has its BOS rate notice heard when it comes out on the ChatNav socket', async () => {
    const server = await FakeOscarServer.start({ generation: 'v0.24' });
    const bot = await signOn(server, 'botone');
    try {
      server.strayRateOnNextNav();
      await bot.session.joinRoom(testroom);
      expect(bot.seen.rate).toContainEqual({ scope: 'bos', status: 'limited' });
    } finally {
      await bot.session.stop();
      await server.stop();
    }
  });
});

describe('room rate limits', () => {
  let server: FakeOscarServer;
  let bot: Bot;

  beforeEach(async () => {
    server = await FakeOscarServer.start();
    bot = await signOn(server, 'botone');
    await bot.session.joinRoom(testroom);
  });

  afterEach(async () => {
    await bot.session.stop();
    await server.stop();
  });

  it('hears a limited notice on the room socket, holds its sends, and resumes on clear', async () => {
    const alice = server.peer('alice');
    alice.joinRoom(testroom);
    server.setRate('botone', testroom, 'limited');
    await until(() => bot.seen.rate.length === 1, 'limited event');
    expect(bot.seen.rate[0]).toEqual({ scope: testroom, status: 'limited' });
    const pending = bot.session.sendRoom(testroom, 'held');
    alice.say(testroom, 'marker');
    await until(() => bot.seen.roomMessage.some((m) => m.text === 'marker'), 'the marker line');
    expect(chatSends(server, 'botone')).toHaveLength(0);
    server.setRate('botone', testroom, 'clear');
    await expect(pending).resolves.toMatchObject({ storedOffline: false });
    expect(chatSends(server, 'botone')).toHaveLength(1);
  });

  it('reads a missing reflection as a rate drop and resends the same cookie only after clear', async () => {
    server.setRate('botone', testroom, 'limited', { silent: true });
    const alice = server.peer('alice');
    alice.joinRoom(testroom);
    const pending = bot.session.sendRoom(testroom, 'dropped once');
    await until(() => bot.seen.rate.some((r) => r.status === 'limited'), 'limited event');
    alice.say(testroom, 'marker');
    await until(() => bot.seen.roomMessage.some((m) => m.text === 'marker'), 'the marker line');
    expect(chatSends(server, 'botone')).toHaveLength(1);
    server.setRate('botone', testroom, 'clear');
    await expect(pending).resolves.toBeDefined();
    const sends = chatSends(server, 'botone');
    expect(sends).toHaveLength(2);
    expect(Buffer.from(sends[1]!).subarray(0, 8)).toEqual(Buffer.from(sends[0]!).subarray(0, 8));
  });
});
