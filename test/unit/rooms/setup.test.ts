import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RootPolicy } from '../../../src/config.js';
import { copy } from '../../../src/copy.js';
import type { RoomRef } from '../../../src/names.js';
import type { ImEvent, RoomMessageEvent } from '../../../src/oscar/index.js';
import type { LeaveResult } from '../../../src/rooms/leave.js';
import { attachProfileStore, ProfileStore, storeFileFor } from '../../../src/rooms/profiles.js';
import { HOLD_MAX, RoomSetup } from '../../../src/rooms/setup.js';
import type { RoomState } from '../../../src/runtime.js';
import { policyFixture, ROOM } from '../rooms-fixtures.js';

const DEN: RoomRef = { exchange: 4, name: 'den' };
const ATTIC: RoomRef = { exchange: 4, name: 'attic' };
const DEN_KEY = 'room:4:den';
const ATTIC_KEY = 'room:4:attic';
const TEAM = ['botone', 'bottwo', 'botthree'];
let seq = 0;

function roomState(ref: RoomRef): RoomState {
  return { ref, occupants: new Set(), joinSeenAt: new Map(), selfJoinedAt: 0, omittedCount: 0 };
}

function harness(over: Partial<RootPolicy> = {}) {
  seq += 1;
  const accountId = `setup${seq}`;
  const store = new ProfileStore({ file: storeFileFor(accountId), log: { debug() {}, info() {}, warn() {}, error() {} }, now: () => 5 });
  attachProfileStore(accountId, store);
  const policy = policyFixture({ teammates: TEAM, ...over });
  const rooms = new Map<string, RoomState>([['room:4:testroom', roomState(ROOM)]]);
  const invited = new Map<string, string>();
  const asks: { owner: string; text: string }[] = [];
  const recorded: string[] = [];
  const replayed: string[] = [];
  const leave = vi.fn(async (ref: RoomRef): Promise<LeaveResult> => (ref.name === 'testroom' ? 'home' : 'left'));
  const setup = new RoomSetup({
    accountId,
    self: () => 'botone',
    policy: () => policy,
    now: () => 5,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    rooms: () => rooms,
    invitedBy: (key) => invited.get(key),
    ask: async (owner, text) => {
      asks.push({ owner, text });
    },
    record: (ev) => recorded.push(`${ev.from}|${ev.text}`),
    replay: (ev) => replayed.push(`${ev.from}|${ev.text}`),
    leave,
  });
  const join = (ref: RoomRef, by?: string): void => {
    rooms.set(`room:4:${ref.name}`, roomState(ref));
    if (by) invited.set(`room:4:${ref.name}`, by);
    setup.onRoomReady(ref);
  };
  const say = (from: string, text: string, room: RoomRef = DEN, whisper = false): 'pass' | 'consumed' =>
    setup.onRoomLine({ room, from, fromDisplay: from, text, cookie: 1n, whisper, serverGenerated: false } as RoomMessageEvent);
  const im = (from: string, text: string): 'handled' | 'pass' =>
    setup.onIm({ from, fromDisplay: from, text, cookie: 2n } as ImEvent);
  return { accountId, store, setup, asks, recorded, replayed, leave, join, say, im, rooms };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

afterEach(() => {
  for (let i = 1; i <= seq; i++) attachProfileStore(`setup${i}`, null);
});

describe('asking', () => {
  it('asks the owner who invited it, with the teammates as the rank example', () => {
    const h = harness({ owners: ['alice', 'bob'] });
    h.join(DEN, 'alice');
    expect(h.asks).toEqual([{ owner: 'alice', text: copy.setupAskNew('den', TEAM, 'alice') }]);
    expect(h.asks[0]?.text).toBe(
      "I joined den (invited by alice). How should I act here? Reply team, lounge or watch, then private or public. Add a rank like 'team botone bottwo botthree'. Reply leave to send me away.",
    );
    expect(h.setup.pendingCount()).toBe(1);
  });

  it('asks every owner when nobody invited it', () => {
    const h = harness({ owners: ['alice', 'bob'] });
    h.join(DEN);
    expect(h.asks).toEqual([
      { owner: 'alice', text: copy.setupAskNew('den', TEAM) },
      { owner: 'bob', text: copy.setupAskNew('den', TEAM) },
    ]);
    expect(h.asks[0]?.text).toMatch(/^I joined den\. How should/);
  });

  it('asks every owner when the inviter is not an owner', () => {
    const h = harness({ owners: ['alice', 'mallory'] });
    h.join(DEN, 'bob');
    expect(h.asks.map((a) => a.owner)).toEqual(['alice', 'mallory']);
  });

  it('says it is back when the store has a profile', () => {
    const h = harness();
    h.store.setProfile(DEN_KEY, { mode: 'team', trust: 'private', rank: ['botone', 'bottwo'] });
    h.join(DEN, 'alice');
    expect(h.asks).toEqual([{ owner: 'alice', text: copy.setupAskBack('den', copy.profileSummary({ mode: 'team', trust: 'private', rank: ['botone', 'bottwo'] }, false)) }]);
    expect(h.asks[0]?.text).toBe("I'm back in den. Last time: team, private, botone bottwo. Reply same, new settings, or leave.");
  });

  it('asks nothing for the home room or a configured room', () => {
    const h = harness({ rooms: { den: { profile: { mode: 'watch' } } } });
    h.setup.onRoomReady(ROOM);
    h.join(DEN, 'alice');
    expect(h.asks).toEqual([]);
    expect(h.setup.pendingCount()).toBe(0);
    expect(h.say('alice', 'hi')).toBe('pass');
  });

  it('does not ask again when a settled room is ready again', () => {
    const h = harness();
    h.join(DEN, 'alice');
    h.im('alice', 'team private');
    h.asks.length = 0;
    h.setup.onRoomReady(DEN);
    expect(h.asks).toEqual([]);
    h.setup.forget(DEN_KEY);
    h.setup.onRoomReady(DEN);
    expect(h.asks).toHaveLength(1);
  });
});

describe('while pending', () => {
  it('holds owner lines without recording them and records everyone else', () => {
    const h = harness();
    h.join(DEN, 'alice');
    expect(h.say('alice', 'hello room')).toBe('consumed');
    expect(h.say('bob', 'hi all')).toBe('consumed');
    expect(h.recorded).toEqual(['bob|hi all']);
    expect(h.replayed).toEqual([]);
  });

  it('reminds the owner once', () => {
    const h = harness();
    h.join(DEN, 'alice');
    h.asks.length = 0;
    h.say('alice', 'one');
    h.say('alice', 'two');
    expect(h.asks).toEqual([{ owner: 'alice', text: copy.setupReminder('den') }]);
    expect(h.asks[0]?.text).toBe("I'm waiting for your settings for den before I talk there.");
  });

  it(`keeps the last ${HOLD_MAX} owner lines`, () => {
    const h = harness();
    h.join(DEN, 'alice');
    for (let i = 1; i <= 21; i++) h.say('alice', `line ${i}`);
    h.im('alice', 'team');
    expect(h.replayed).toHaveLength(20);
    expect(h.replayed[0]).toBe('alice|line 2');
    expect(h.replayed[19]).toBe('alice|line 21');
  });

  it('passes lines in rooms that are not pending', () => {
    const h = harness();
    h.join(DEN, 'alice');
    expect(h.say('alice', 'hi', ATTIC)).toBe('pass');
  });
});

describe('answers', () => {
  it('applies team private, repeats it back and replays held lines in order once each', () => {
    const h = harness();
    h.join(DEN, 'alice');
    h.say('alice', 'first');
    h.say('bob', 'aside');
    h.say('alice', 'second');
    h.asks.length = 0;
    expect(h.im('alice', 'team private')).toBe('handled');
    expect(h.store.get(DEN_KEY)?.profile).toEqual({ mode: 'team', trust: 'private' });
    expect(h.asks).toEqual([{ owner: 'alice', text: copy.setupApplied('den', copy.profileSummary({ mode: 'team', trust: 'private' }, true)) }]);
    expect(h.asks[0]?.text).toBe('den: team, private.');
    expect(h.replayed).toEqual(['alice|first', 'alice|second']);
    expect([...h.recorded, ...h.replayed].filter((l) => l === 'alice|first')).toHaveLength(1);
    expect(h.setup.pendingCount()).toBe(0);
    expect(h.say('alice', 'after')).toBe('pass');
  });

  it('repeats a rank back with the rank word', () => {
    const h = harness();
    h.join(DEN, 'alice');
    h.asks.length = 0;
    h.im('alice', 'team private botone bottwo');
    expect(h.asks[0]?.text).toBe('den: team, private, rank botone bottwo.');
  });

  it('makes a new room public when the answer gives no trust', () => {
    const h = harness();
    h.join(DEN, 'alice');
    h.im('alice', 'lounge');
    expect(h.store.get(DEN_KEY)?.profile).toEqual({ mode: 'lounge', trust: 'public' });
  });

  it('applies the stored profile on same', () => {
    const h = harness();
    h.store.setProfile(DEN_KEY, { mode: 'watch', trust: 'private' });
    h.join(DEN, 'alice');
    h.say('alice', 'held');
    expect(h.im('alice', 'same')).toBe('handled');
    expect(h.store.get(DEN_KEY)?.profile).toEqual({ mode: 'watch', trust: 'private' });
    expect(h.replayed).toEqual(['alice|held']);
  });

  it('refuses same without a stored profile and stays pending', () => {
    const h = harness();
    h.join(DEN, 'alice');
    h.asks.length = 0;
    expect(h.im('alice', 'same')).toBe('handled');
    expect(h.asks).toEqual([{ owner: 'alice', text: copy.setupNotUnderstood('same') }]);
    expect(h.setup.pendingCount()).toBe(1);
  });

  it('changes trust only when there is a profile, and refuses it otherwise', () => {
    const h = harness();
    h.join(DEN, 'alice');
    h.asks.length = 0;
    h.im('alice', 'private');
    expect(h.asks).toEqual([{ owner: 'alice', text: copy.setupNotUnderstood('private') }]);
    h.store.setProfile(DEN_KEY, { mode: 'lounge', trust: 'public' });
    h.im('alice', 'private');
    expect(h.store.get(DEN_KEY)?.profile).toEqual({ mode: 'lounge', trust: 'private' });
  });

  it('asks which room when two are waiting', () => {
    const h = harness();
    h.join(DEN, 'alice');
    h.join(ATTIC, 'alice');
    h.asks.length = 0;
    expect(h.im('alice', 'lounge')).toBe('handled');
    expect(h.asks).toEqual([{ owner: 'alice', text: copy.setupWhichRoom('den') }]);
    expect(h.asks[0]?.text).toBe("More than one room is waiting. Start with the room name, like 'den team private'.");
    h.im('alice', 'attic lounge');
    expect(h.store.get(ATTIC_KEY)?.profile).toEqual({ mode: 'lounge', trust: 'public' });
    expect(h.setup.pendingCount()).toBe(1);
  });

  it('names the word it did not understand', () => {
    const h = harness();
    h.join(DEN, 'alice');
    h.asks.length = 0;
    expect(h.im('alice', 'team bob')).toBe('handled');
    expect(h.asks).toEqual([{ owner: 'alice', text: copy.setupNotUnderstood('bob') }]);
    expect(h.asks[0]?.text).toBe("I didn't understand 'bob'. Reply team, lounge or watch, then private or public, or leave.");
    expect(h.setup.pendingCount()).toBe(1);
  });

  it('refuses a rank that leaves this bot out', () => {
    const h = harness();
    h.join(DEN, 'alice');
    h.asks.length = 0;
    h.im('alice', 'team bottwo botthree');
    expect(h.asks).toEqual([{ owner: 'alice', text: copy.setupNotUnderstood('bottwo botthree') }]);
    expect(h.store.get(DEN_KEY)).toBeUndefined();
  });

  it('refuses settings for a configured room', () => {
    const h = harness();
    h.join(DEN, 'alice');
    h.asks.length = 0;
    h.im('alice', 'testroom lounge');
    expect(h.asks).toEqual([{ owner: 'alice', text: copy.setupConfigRoom('testroom') }]);
    expect(h.asks[0]?.text).toBe('testroom is set in my config.');
  });

  it('leaves on leave and drops the held lines', async () => {
    const h = harness();
    h.join(DEN, 'alice');
    h.say('alice', 'held');
    h.asks.length = 0;
    expect(h.im('alice', 'leave')).toBe('handled');
    await flush();
    expect(h.asks).toEqual([{ owner: 'alice', text: copy.setupLeaving('den') }]);
    expect(h.asks[0]?.text).toBe('Leaving den.');
    expect(h.leave).toHaveBeenCalledWith(DEN);
    expect(h.replayed).toEqual([]);
    expect(h.setup.pendingCount()).toBe(0);
  });

  it('passes IMs from people who are not owners', () => {
    const h = harness();
    h.join(DEN, 'alice');
    expect(h.im('bob', 'team private')).toBe('pass');
    expect(h.setup.pendingCount()).toBe(1);
  });

  it('passes ordinary owner chat while a room is pending', () => {
    const h = harness();
    h.join(DEN, 'alice');
    expect(h.im('alice', 'hello there')).toBe('pass');
  });
});

describe('leave', () => {
  it('leaves on an owner /leave and consumes the line', () => {
    const h = harness();
    h.rooms.set(DEN_KEY, roomState(DEN));
    expect(h.say('alice', '/leave')).toBe('consumed');
    expect(h.leave).toHaveBeenCalledWith(DEN);
  });

  it('leaves when the owner names this bot', () => {
    const h = harness();
    expect(h.say('alice', '/leave bottwo BotOne')).toBe('consumed');
    expect(h.leave).toHaveBeenCalledWith(DEN);
  });

  it('stays, without waking anyone, when the owner names only others', () => {
    const h = harness();
    expect(h.say('alice', '/leave bottwo')).toBe('consumed');
    expect(h.leave).not.toHaveBeenCalled();
  });

  it('treats /leave from anyone but an owner as an ordinary line', () => {
    const h = harness();
    expect(h.say('bob', '/leave')).toBe('pass');
    expect(h.say('bottwo', '/leave botone')).toBe('pass');
    expect(h.leave).not.toHaveBeenCalled();
  });

  it('ignores a whispered /leave', () => {
    const h = harness();
    expect(h.say('alice', '/leave', DEN, true)).toBe('pass');
    expect(h.leave).not.toHaveBeenCalled();
  });

  it('drops the held lines of a pending room it leaves', async () => {
    const h = harness();
    h.join(DEN, 'alice');
    h.say('alice', 'held');
    h.asks.length = 0;
    expect(h.say('alice', '/leave')).toBe('consumed');
    await flush();
    expect(h.leave).toHaveBeenCalledWith(DEN);
    expect(h.setup.pendingCount()).toBe(0);
    expect(h.replayed).toEqual([]);
    expect(h.asks).toEqual([]);
  });

  it('tells the owner it will not leave the home room', async () => {
    const h = harness();
    expect(h.say('alice', '/leave', ROOM)).toBe('consumed');
    await flush();
    expect(h.asks).toEqual([{ owner: 'alice', text: copy.leaveHome('testroom') }]);
    expect(h.asks[0]?.text).toBe('testroom is my home room; change channels.oscar.room to move me.');
  });

  it('answers an IM leave for the home room and for a room it is not in', async () => {
    const h = harness();
    expect(h.im('alice', 'leave testroom')).toBe('handled');
    await flush();
    expect(h.asks).toEqual([{ owner: 'alice', text: copy.leaveHome('testroom') }]);
    h.asks.length = 0;
    h.rooms.set(DEN_KEY, roomState(DEN));
    h.leave.mockResolvedValueOnce('not-in');
    expect(h.im('alice', 'leave den')).toBe('handled');
    await flush();
    expect(h.asks).toEqual([{ owner: 'alice', text: copy.notInRoom('den') }]);
    expect(h.asks[0]?.text).toBe("I'm not in den.");
  });
});
