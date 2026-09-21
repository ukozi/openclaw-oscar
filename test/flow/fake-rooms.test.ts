import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeOscarServer } from '../fake/oscar-server.js';

const testroom = { exchange: 4 as const, name: 'testroom' };

describe('fake server rooms, driven by scripted peers', () => {
  let server: FakeOscarServer;

  beforeEach(async () => {
    server = await FakeOscarServer.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it('lets peers create a private room by joining it', () => {
    server.peer('Alice').joinRoom(testroom);
    server.peer('bob').joinRoom(testroom);
    expect(server.occupants(testroom)).toEqual(['alice', 'bob']);
  });

  it('keeps public rooms for the operator to create', () => {
    const lobby = { exchange: 5 as const, name: 'lobby' };
    expect(() => server.peer('alice').joinRoom(lobby)).toThrow('does not exist');
    server.addRoom(lobby);
    server.peer('alice').joinRoom(lobby);
    expect(server.occupants(lobby)).toEqual(['alice']);
  });

  it('shows a peer what the others said, and whispers only to their target', () => {
    const alice = server.peer('alice');
    const bob = server.peer('bob');
    const mallory = server.peer('mallory');
    for (const peer of [alice, bob, mallory]) peer.joinRoom(testroom);
    alice.say(testroom, 'to all');
    alice.say(testroom, 'to bob', { whisperTo: 'bob' });
    expect(bob.roomLines(testroom)).toEqual([
      { from: 'alice', text: 'to all', whisper: false },
      { from: 'alice', text: 'to bob', whisper: true },
    ]);
    expect(mallory.roomLines(testroom)).toEqual([{ from: 'alice', text: 'to all', whisper: false }]);
    expect(alice.roomLines(testroom)).toEqual([]);
  });

  it('refuses a line from a peer who is not in the room', () => {
    expect(() => server.peer('alice').say(testroom, 'hello?')).toThrow('is not in');
  });

  it('empties a room when a peer leaves or signs off, and on restart, but keeps the room', async () => {
    const alice = server.peer('alice');
    const bob = server.peer('bob');
    alice.joinRoom(testroom);
    bob.joinRoom(testroom);
    alice.leaveRoom(testroom);
    expect(server.occupants(testroom)).toEqual(['bob']);
    bob.signOff();
    expect(server.occupants(testroom)).toEqual([]);
    server.peer('mallory').joinRoom(testroom);
    await server.restart();
    expect(server.occupants(testroom)).toEqual([]);
  });

  it('cannot invite someone who is not signed on', () => {
    expect(() => server.peer('alice').invite('botone', testroom)).toThrow('is not signed on');
  });
});
