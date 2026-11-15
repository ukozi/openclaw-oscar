import { describe, expect, it } from 'vitest';
import { OscarError, RoomJoinError } from 'open-oscar-client-kit/client';
import { roomConversationId } from 'open-oscar-client-kit/model';
import type { RoomMessage, RoomState, RoomStatus, SelfInfo } from 'open-oscar-client-kit/model';
import { ManualTimers } from 'open-oscar-client-kit/testing';
import { RoomList, type RoomEventName } from '../../../src/oscar/room-list.js';
import type { InviteEvent, Logger, OscarEvents, RoomRef } from '../../../src/oscar/types.js';
import { StubClient } from '../../fake/stub-client.js';

const quietLog: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
};

const testroom: RoomRef = { exchange: 4, name: 'testroom' };
const side: RoomRef = { exchange: 4, name: 'side' };
const idOf = roomConversationId;
const invite: InviteEvent = { from: 'alice', fromDisplay: 'Alice', room: testroom, roomCookie: 'alice:00000000000000a1', text: '' };
const unavailable = (): { reject: unknown } => ({ reject: new RoomJoinError('unavailable') });

function status(room: RoomRef, state: RoomState, occupants: string[] = []): RoomStatus {
  return { id: idOf(room), exchange: room.exchange, name: room.name, state, occupants, createdAt: null, maxOccupancy: null };
}

function line(room: RoomRef, from: string, html: string, more: Partial<RoomMessage> = {}): RoomMessage {
  return { roomId: idOf(room), from, body: [], at: 0, whisper: false, fromServer: false, wire: { cookie: '0000000000000007', html }, ...more };
}

type Seen = { [E in RoomEventName]: OscarEvents[E][] };

function world() {
  const client = new StubClient();
  client.self = { screenName: 'botone' } as SelfInfo;
  const timers = new ManualTimers();
  const flags = { online: true };
  const seen: Seen = { roomReady: [], roomJoin: [], roomLeave: [], roomMessage: [], roomClosed: [], rate: [] };
  const list = new RoomList({
    client: () => client,
    isOnline: () => flags.online,
    emit: (event, payload) => {
      (seen[event] as unknown[]).push(payload);
    },
    log: quietLog,
    now: timers.now,
    timers: timers.api,
    random: () => 0.5,
  });
  // The client reports a room closed some time after its socket ended.
  const drop = (room: RoomRef, state: RoomState = 'disconnected'): void => {
    client.joined = client.joined.filter((r) => r.id !== idOf(room));
    client.emit('room', status(room, state));
  };
  const down = (): void => {
    flags.online = false;
    list.offline();
  };
  const up = (): void => {
    flags.online = true;
    list.online();
  };
  const joins = (): number => client.callsTo('joinRoom').length;
  return { client, timers, flags, seen, list, drop, down, up, joins };
}

describe('joining', () => {
  it('joins through the client and reports the room ready with its occupants', async () => {
    const w = world();
    w.client.script('joinRoom', { resolve: status(testroom, 'joined', ['BotOne', 'Alice B']) });
    await w.list.joinRoom(testroom);
    expect(w.client.callsTo('joinRoom')).toEqual([[testroom]]);
    expect(w.seen.roomReady).toEqual([{ room: testroom, occupants: ['botone', 'aliceb'] }]);
    expect(w.list.rooms()).toEqual([{ room: testroom, occupants: ['botone', 'aliceb'], joinedAt: w.timers.now() }]);
  });

  it('lowercases the room name', async () => {
    const w = world();
    await w.list.joinRoom({ exchange: 4, name: 'TestRoom' });
    expect(w.client.callsTo('joinRoom')).toEqual([[testroom]]);
    expect(w.seen.roomReady[0]?.room).toEqual(testroom);
  });

  it('does not join a room it already holds', async () => {
    const w = world();
    await w.list.joinRoom(testroom);
    await w.list.joinRoom(testroom);
    await w.list.joinInvited(invite);
    expect(w.joins()).toBe(1);
  });

  it('shares one attempt between two callers', async () => {
    const w = world();
    await Promise.all([w.list.joinRoom(testroom), w.list.joinRoom(testroom)]);
    expect(w.joins()).toBe(1);
  });

  it('runs one join at a time', async () => {
    const w = world();
    w.client.script('joinRoom', 'hold');
    const first = w.list.joinRoom(testroom);
    const second = w.list.joinRoom(side);
    await settle();
    expect(w.joins()).toBe(1);
    w.client.held[0]?.resolve(status(testroom, 'joined'));
    await Promise.all([first, second]);
    expect(w.client.callsTo('joinRoom')).toEqual([[testroom], [side]]);
  });

  it('refuses a join over 180 bytes before anything reaches the wire', async () => {
    const w = world();
    await expect(w.list.joinRoom({ exchange: 4, name: 'x'.repeat(200) })).rejects.toMatchObject({ code: 'too-long' });
    expect(w.joins()).toBe(0);
    expect(w.timers.pending()).toEqual([]);
  });

  it('joins an invited room by name and forgets the invitation', async () => {
    const w = world();
    await w.list.joinInvited({ ...invite, room: { exchange: 4, name: 'TestRoom' } });
    expect(w.client.callsTo('joinRoom')).toEqual([[testroom]]);
    expect(w.client.callsTo('forgetInvite')).toEqual([['alice:00000000000000a1']]);
    expect(w.seen.roomReady).toEqual([{ room: testroom, occupants: [] }]);
  });

  it('forgets the invitation to a room that could not be joined', async () => {
    const w = world();
    w.client.script('joinRoom', unavailable());
    await expect(w.list.joinInvited(invite)).rejects.toMatchObject({ code: 'unavailable' });
    expect(w.client.callsTo('forgetInvite')).toHaveLength(1);
    expect(w.timers.pending()).toEqual([]);
  });

  it('rejects a session join while offline and takes a persistent one for later', async () => {
    const w = world();
    w.flags.online = false;
    await expect(w.list.joinRoom(testroom)).rejects.toMatchObject({ code: 'not-online' });
    await expect(w.list.joinInvited(invite)).rejects.toMatchObject({ code: 'not-online' });
    await expect(w.list.joinRoom(testroom, { persistent: true })).resolves.toBeUndefined();
    expect(w.joins()).toBe(0);
    w.up();
    await settle();
    expect(w.seen.roomReady).toHaveLength(1);
  });

  it('emits roomReady once for one join, though the client reports joined twice', async () => {
    const w = world();
    await w.list.joinRoom(testroom);
    w.client.emit('room', status(testroom, 'joined', ['botone']));
    expect(w.seen.roomReady).toHaveLength(1);
  });

  it('ignores a room the client reports that nobody asked for', async () => {
    const w = world();
    w.client.emit('room', status(side, 'joined'));
    w.client.emit('room', status(side, 'disconnected'));
    expect(w.seen.roomReady).toEqual([]);
    expect(w.seen.roomClosed).toEqual([]);
    expect(w.list.rooms()).toEqual([]);
  });

  it.each([
    ['a missing room', new RoomJoinError('no-such-room'), 'no-such-room'],
    ['a join too long for the server', new RoomJoinError('name-too-long'), 'too-long'],
    ['a room that did not open', new RoomJoinError('unavailable'), 'unavailable'],
    ['a name the client will not send', new RoomJoinError('invalid-name'), 'unavailable'],
    ['a full client', new RoomJoinError('room-limit'), 'unavailable'],
    ['a client that is not signed on', new OscarError({ kind: 'not-signed-on' }), 'not-online'],
    ['anything else', new Error('boom'), 'unavailable'],
  ])('maps each join failure to its room error code: %s', async (_name, error, code) => {
    const w = world();
    w.client.script('joinRoom', { reject: error });
    await expect(w.list.joinRoom(testroom)).rejects.toMatchObject({ name: 'OscarRoomError', code });
  });
});

describe('missing public room', () => {
  it('fails a session join and forgets it', async () => {
    const w = world();
    w.client.script('joinRoom', { reject: new RoomJoinError('no-such-room') });
    await expect(w.list.joinRoom({ exchange: 5, name: 'lobby' })).rejects.toMatchObject({ code: 'no-such-room' });
    await w.timers.advance(600_000);
    expect(w.joins()).toBe(1);
  });

  it('keeps trying a persistent room every five minutes until it exists', async () => {
    const w = world();
    w.client.script('joinRoom', { reject: new RoomJoinError('no-such-room') });
    await expect(w.list.joinRoom(testroom, { persistent: true })).rejects.toMatchObject({ code: 'no-such-room' });
    await w.timers.advance(299_999);
    expect(w.joins()).toBe(1);
    await w.timers.advance(1);
    await settle();
    expect(w.seen.roomReady).toHaveLength(1);
  });
});

describe('giving up', () => {
  it('gives up a persistent room whose join is too long', async () => {
    const w = world();
    w.list.joinRoom({ exchange: 4, name: 'x'.repeat(200) }, { persistent: true }).catch(() => undefined);
    await settle();
    w.down();
    w.up();
    await w.timers.advance(600_000);
    expect(w.joins()).toBe(0);
  });

  it('gives up a persistent room whose name the client will not send', async () => {
    const w = world();
    w.client.script('joinRoom', { reject: new RoomJoinError('invalid-name') });
    await expect(w.list.joinRoom(testroom, { persistent: true })).rejects.toMatchObject({ code: 'unavailable' });
    await w.timers.advance(600_000);
    expect(w.joins()).toBe(1);
  });

  it('keeps trying a persistent room that did not open, 2 s then 4 s later', async () => {
    const w = world();
    w.client.script('joinRoom', unavailable(), unavailable());
    await expect(w.list.joinRoom(testroom, { persistent: true })).rejects.toMatchObject({ code: 'unavailable' });
    await w.timers.advance(1999);
    expect(w.joins()).toBe(1);
    await w.timers.advance(1);
    expect(w.joins()).toBe(2);
    await w.timers.advance(3999);
    expect(w.joins()).toBe(2);
    await w.timers.advance(1);
    await settle();
    expect(w.seen.roomReady).toHaveLength(1);
    expect(w.seen.roomClosed).toEqual([]);
  });

  it('gives a session room up after five failures in a row', async () => {
    const w = world();
    await w.list.joinRoom(testroom);
    w.client.script('joinRoom', ...Array.from({ length: 10 }, unavailable));
    w.drop(testroom);
    await w.timers.advance(3_600_000);
    expect(w.seen.roomClosed).toEqual([
      { room: testroom, willRejoin: true },
      { room: testroom, willRejoin: false },
    ]);
    expect(w.joins()).toBe(5);
  });

  it('never gives a persistent room up, and waits at most 2 min between tries', async () => {
    const w = world();
    await w.list.joinRoom(testroom, { persistent: true });
    w.client.script('joinRoom', ...Array.from({ length: 12 }, unavailable));
    w.drop(testroom);
    await w.timers.advance(3_600_000);
    await settle();
    expect(w.seen.roomClosed).toEqual([{ room: testroom, willRejoin: true }]);
    expect(w.seen.roomReady).toHaveLength(2);
  });
});

describe('room drops', () => {
  it('rejoins a dropped room after 2 s and fails pending sends', async () => {
    const w = world();
    await w.list.joinRoom(testroom);
    w.client.script('sendRoomMessage', 'hold');
    const sending = expect(w.list.sendRoom(testroom, 'one')).rejects.toMatchObject({ code: 'closed' });
    const waiting = expect(w.list.sendRoom(testroom, 'two')).rejects.toMatchObject({ code: 'closed' });
    await settle();
    w.client.held[0]?.reject(new OscarError({ kind: 'local', code: 'not-in-room' }));
    w.drop(testroom);
    await sending;
    await waiting;
    expect(w.client.callsTo('sendRoomMessage')).toHaveLength(1);
    expect(w.seen.roomClosed).toEqual([{ room: testroom, willRejoin: true }]);
    expect(w.list.rooms()).toEqual([]);
    await w.timers.advance(1999);
    expect(w.joins()).toBe(1);
    await w.timers.advance(1);
    await settle();
    expect(w.seen.roomReady).toHaveLength(2);
  });

  it('leaves a room the client reports disconnected before it joins it again', async () => {
    const w = world();
    await w.list.joinRoom(testroom);
    w.drop(testroom);
    await w.timers.advance(2000);
    await settle();
    expect(w.client.calls.map((c) => c.method)).toEqual(['joinRoom', 'leaveRoom', 'joinRoom']);
    expect(w.client.callsTo('leaveRoom')).toEqual([[idOf(testroom)]]);
  });

  it('treats a room the client reports not available as closed', async () => {
    const w = world();
    await w.list.joinRoom(testroom);
    w.drop(testroom, 'notAvailable');
    expect(w.seen.roomClosed).toEqual([{ room: testroom, willRejoin: true }]);
    expect(w.client.callsTo('leaveRoom')).toHaveLength(1);
  });

  it('backs off 2 s, 4 s, 8 s when the seat keeps being taken', async () => {
    const w = world();
    await w.list.joinRoom(testroom);
    for (const [i, delay] of [2000, 4000, 8000].entries()) {
      w.drop(testroom);
      await w.timers.advance(delay - 1);
      expect(w.joins()).toBe(i + 1);
      await w.timers.advance(1);
      await settle();
      expect(w.joins()).toBe(i + 2);
    }
  });

  it('starts the backoff over after a minute of staying joined', async () => {
    const w = world();
    await w.list.joinRoom(testroom);
    w.drop(testroom);
    await w.timers.advance(2000);
    await settle();
    await w.timers.advance(60_000);
    w.drop(testroom);
    await w.timers.advance(2000);
    await settle();
    expect(w.joins()).toBe(3);
  });

  it('does not rejoin a dropped room while the session is offline', async () => {
    const w = world();
    await w.list.joinRoom(testroom);
    w.flags.online = false;
    w.drop(testroom);
    expect(w.seen.roomClosed).toEqual([{ room: testroom, willRejoin: true }]);
    expect(w.timers.pending()).toEqual([]);
  });
});

describe('session loss', () => {
  it('emits roomClosed for each live room when the session goes offline', async () => {
    const w = world();
    await w.list.joinInvited({ ...invite, room: side });
    await w.list.joinRoom(testroom, { persistent: true });
    w.down();
    expect(w.seen.roomClosed).toEqual([
      { room: side, willRejoin: true },
      { room: testroom, willRejoin: true },
    ]);
    expect(w.list.rooms()).toEqual([]);
    expect(w.client.callsTo('leaveRoom')).toEqual([]);
    await w.timers.advance(600_000);
    expect(w.joins()).toBe(2);
    w.up();
    await settle();
    expect(w.seen.roomReady).toHaveLength(4);
    // persistent rooms come first
    expect(w.client.callsTo('joinRoom').slice(2)).toEqual([[testroom], [side]]);
  });

  it('counts no failure for a join that lost the session under it, and joins at the next sign-on', async () => {
    const w = world();
    w.client.script('joinRoom', 'hold');
    const join = expect(w.list.joinRoom(testroom, { persistent: true })).rejects.toMatchObject({ code: 'not-online' });
    await settle();
    w.down();
    w.client.held[0]?.reject(new RoomJoinError('unavailable'));
    await join;
    expect(w.timers.pending()).toEqual([]);
    w.up();
    await settle();
    expect(w.seen.roomReady).toHaveLength(1);
    w.drop(testroom);
    expect(w.timers.pending()).toEqual([2000]);
  });

  it('clears the retry timers when the session goes offline', async () => {
    const w = world();
    await w.list.joinRoom(testroom, { persistent: true });
    w.drop(testroom);
    expect(w.timers.pending()).toEqual([2000]);
    w.down();
    expect(w.timers.pending()).toEqual([]);
  });

  it('does not report a room twice when its socket closed just before BOS did', async () => {
    const w = world();
    await w.list.joinRoom(testroom);
    w.drop(testroom);
    w.down();
    await w.timers.advance(10_000);
    expect(w.seen.roomClosed).toHaveLength(1);
    expect(w.joins()).toBe(1);
  });

  it('fails waiting room sends as closed when the session goes offline', async () => {
    const w = world();
    await w.list.joinRoom(testroom);
    w.client.script('sendRoomMessage', 'hold');
    void w.list.sendRoom(testroom, 'one').catch(() => undefined);
    const waiting = expect(w.list.sendRoom(testroom, 'two')).rejects.toMatchObject({ code: 'closed' });
    await settle();
    w.down();
    await waiting;
    expect(w.client.callsTo('sendRoomMessage')).toHaveLength(1);
  });

  it('forgets session rooms on stop and keeps persistent ones', async () => {
    const w = world();
    await w.list.joinRoom(testroom, { persistent: true });
    await w.list.joinRoom(side);
    w.flags.online = false;
    w.list.stop();
    expect(w.seen.roomClosed).toEqual([
      { room: testroom, willRejoin: true },
      { room: side, willRejoin: false },
    ]);
    w.up();
    await settle();
    expect(w.list.rooms().map((r) => r.room.name)).toEqual(['testroom']);
  });
});

describe('leaving and sending', () => {
  it('leaves through the client and never rejoins', async () => {
    const w = world();
    await w.list.joinRoom(testroom, { persistent: true });
    await w.list.leaveRoom(testroom);
    expect(w.client.callsTo('leaveRoom')).toEqual([[idOf(testroom)]]);
    expect(w.seen.roomClosed).toEqual([{ room: testroom, willRejoin: false }]);
    expect(w.list.rooms()).toEqual([]);
    w.list.online();
    await w.timers.advance(600_000);
    expect(w.joins()).toBe(1);
  });

  it('sends nothing for a room that was left before its join started', async () => {
    const w = world();
    const join = w.list.joinRoom(testroom);
    await w.list.leaveRoom(testroom);
    await join;
    expect(w.joins()).toBe(0);
    expect(w.seen.roomReady).toEqual([]);
  });

  it('gives the seat back for a room that was left while its join was running', async () => {
    const w = world();
    w.client.script('joinRoom', 'hold');
    const join = w.list.joinRoom(testroom);
    await settle();
    await w.list.leaveRoom(testroom);
    w.client.held[0]?.resolve(status(testroom, 'joined'));
    await join;
    expect(w.list.rooms()).toEqual([]);
    expect(w.seen.roomReady).toEqual([]);
    expect(w.seen.roomClosed).toEqual([]);
    expect(w.client.callsTo('leaveRoom').at(-1)).toEqual([idOf(testroom)]);
  });

  it('settles quietly when the client ends the join of a room that was left', async () => {
    const w = world();
    w.client.script('joinRoom', 'hold');
    const join = w.list.joinRoom(testroom, { persistent: true });
    await settle();
    await w.list.leaveRoom(testroom);
    w.client.held[0]?.reject(new RoomJoinError('unavailable'));
    await expect(join).resolves.toBeUndefined();
    expect(w.timers.pending()).toEqual([]);
  });

  it('fails a send to a room it is not in', async () => {
    const w = world();
    await expect(w.list.sendRoom(testroom, 'hi')).rejects.toMatchObject({ code: 'room-not-joined' });
    expect(w.client.callsTo('sendRoomMessage')).toEqual([]);
  });

  it('sends a line as HTML and returns its id, never stored', async () => {
    const w = world();
    await w.list.joinRoom(testroom);
    w.client.script('sendRoomMessage', { resolve: { replacedBy: null, id: '00000000000000aa' } });
    expect(await w.list.sendRoom(testroom, '<b>hi</b>')).toEqual({ id: '00000000000000aa', storedOffline: false });
    await w.list.sendRoom({ exchange: 4, name: 'TestRoom' }, 'psst', { whisperTo: 'Alice' });
    expect(w.client.callsTo('sendRoomMessage')).toEqual([
      [idOf(testroom), { html: '<b>hi</b>' }],
      [idOf(testroom), { html: 'psst' }, { whisperTo: 'Alice' }],
    ]);
  });

  it('orders two lines of one room by priority and keeps rooms independent', async () => {
    const w = world();
    await w.list.joinRoom(testroom);
    await w.list.joinRoom(side);
    w.client.script('sendRoomMessage', 'hold');
    const first = w.list.sendRoom(testroom, 'first', { priority: 'notice' });
    const notice = w.list.sendRoom(testroom, 'notice', { priority: 'notice' });
    const reply = w.list.sendRoom(testroom, 'reply');
    const other = w.list.sendRoom(side, 'other', { priority: 'notice' });
    await settle();
    const sent = (): unknown[] => w.client.callsTo('sendRoomMessage').map((args) => (args[1] as { html: string }).html);
    expect(sent()).toEqual(['first', 'other']);
    await expect(other).resolves.toMatchObject({ storedOffline: false });
    w.client.held[0]?.resolve({ replacedBy: null, id: '0000000000000001' });
    await Promise.all([first, notice, reply]);
    expect(sent()).toEqual(['first', 'other', 'reply', 'notice']);
  });

  it.each([
    ['a whisper to someone who left', new OscarError({ kind: 'local', code: 'whisper-target-left' }), 'recipient-unavailable'],
    ['a room that closed under the line', new OscarError({ kind: 'local', code: 'not-in-room' }), 'closed'],
    ['a line with no echo', new OscarError({ kind: 'timeout', rateLimited: true }), 'rate-limited'],
    ['a line too long', new OscarError({ kind: 'local', code: 'message-too-long' }), 'too-long'],
  ])('maps a refused line to its send error code: %s', async (_name, error, code) => {
    const w = world();
    await w.list.joinRoom(testroom);
    w.client.script('sendRoomMessage', { reject: error });
    await expect(w.list.sendRoom(testroom, 'hi')).rejects.toMatchObject({ name: 'OscarSendError', code });
    await expect(w.list.sendRoom(testroom, 'again')).resolves.toMatchObject({ storedOffline: false });
  });

  it('passes room lines, joins and whispers up with the room attached', async () => {
    const w = world();
    await w.list.joinRoom(testroom);
    const roomId = idOf(testroom);
    w.client.emit('roomMessage', line(testroom, 'Alice', 'psst', { whisper: true, wire: { cookie: '1112131415161718', html: 'psst' } }));
    w.client.emit('roomOccupant', { roomId, screenName: 'Bob B', change: 'joined', occupants: ['botone', 'Bob B'] });
    expect(w.seen.roomMessage).toEqual([
      { room: testroom, from: 'alice', fromDisplay: 'Alice', text: 'psst', cookie: 0x1112131415161718n, whisper: true, serverGenerated: false },
    ]);
    expect(w.seen.roomJoin).toEqual([{ room: testroom, name: 'bobb', display: 'Bob B' }]);
    expect(w.list.rooms()[0]?.occupants).toEqual(['botone', 'bobb']);
    w.client.emit('roomOccupant', { roomId, screenName: 'Bob B', change: 'left', occupants: ['botone'] });
    expect(w.seen.roomLeave).toEqual([{ room: testroom, name: 'bobb', display: 'Bob B' }]);
    expect(w.list.rooms()[0]?.occupants).toEqual(['botone']);
  });

  it('gives a room line as text, with HTML removed', async () => {
    const w = world();
    await w.list.joinRoom(testroom);
    w.client.emit('roomMessage', line(testroom, 'Alice', '<B>hi</B>'));
    expect(w.seen.roomMessage).toEqual([
      { room: testroom, from: 'alice', fromDisplay: 'Alice', text: 'hi', cookie: 7n, whisper: false, serverGenerated: false },
    ]);
  });

  it('marks a line the server wrote as server generated', async () => {
    const w = world();
    await w.list.joinRoom(testroom);
    w.client.emit('roomMessage', line(testroom, 'OnlineHost', 'x', { fromServer: true }));
    expect(w.seen.roomMessage).toMatchObject([{ from: 'onlinehost', text: 'x', serverGenerated: true }]);
  });

  it('maps a room rate event to a rate event scoped to the room', async () => {
    const w = world();
    await w.list.joinRoom(testroom);
    w.client.emit('roomRate', { roomId: idOf(testroom), status: 'limited' });
    w.client.emit('roomRate', { roomId: idOf(testroom), status: 'clear' });
    expect(w.seen.rate).toEqual([
      { scope: testroom, status: 'limited' },
      { scope: testroom, status: 'clear' },
    ]);
  });

  it('drops events of a room it does not hold', async () => {
    const w = world();
    w.client.emit('roomRate', { roomId: idOf(side), status: 'limited' });
    w.client.emit('roomMessage', line(side, 'Alice', 'hi'));
    w.client.emit('roomOccupant', { roomId: idOf(side), screenName: 'Bob', change: 'joined', occupants: ['Bob'] });
    expect(w.seen).toEqual({ roomReady: [], roomJoin: [], roomLeave: [], roomMessage: [], roomClosed: [], rate: [] });
  });
});
