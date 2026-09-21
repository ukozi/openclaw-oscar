import { describe, expect, it } from 'vitest';
import { candidateOrder, commandKey, endsWithQuestion, floorHolder, noteRoomLine, route } from '../../../src/chain/route.js';
import type { RouteInput } from '../../../src/chain/route.js';
import { chainConfig, policyFixture, roomFixture } from './fixtures.js';

const NOW = 1_000_000;

function input(over: Partial<RouteInput> & { from?: string; text?: string; whisper?: boolean; cookie?: bigint } = {}): RouteInput {
  const { from = 'alice', text = 'what is the status?', whisper = false, cookie = 77n, ...rest } = over;
  return {
    self: 'botone',
    now: NOW,
    policy: policyFixture(),
    room: roomFixture(),
    rosterMismatch: false,
    message: { from, text, whisper, cookie },
    asked: new Map(),
    openHandoffIds: new Set(),
    seenHandoffs: new Set(),
    ...rest,
  };
}

const HANDOFF = 'bottwo: tighten the intro [d:1-k7f3 h:1 o:alice]';

describe('route: people', () => {
  it('owner unnamed: the chair wakes, the rest stand by in rank order', () => {
    const order = ['botone', 'bottwo', 'botthree'];
    expect(route(input())).toEqual({ kind: 'wake', why: 'lead', origin: 'owner', key: 'alice:4d', order });
    expect(route(input({ self: 'bottwo' }))).toEqual({ kind: 'standby', position: 1, key: 'alice:4d', order });
    expect(route(input({ self: 'botthree' }))).toEqual({ kind: 'standby', position: 2, key: 'alice:4d', order });
  });

  it('a named bot wakes and everyone else records', () => {
    expect(route(input({ self: 'bottwo', text: 'bottwo: fix it' }))).toEqual({ kind: 'wake', why: 'named', origin: 'owner', key: 'alice:4d' });
    expect(route(input({ self: 'botone', text: 'bottwo: fix it' }))).toEqual({ kind: 'record' });
    expect(route(input({ self: 'bottwo', from: 'bob', text: 'writer, fix it' }))).toMatchObject({ kind: 'wake', why: 'named', origin: 'approved' });
  });

  it('a line to a human wakes nobody', () => {
    expect(route(input({ text: 'bob: lunch?' }))).toEqual({ kind: 'record' });
  });

  it('approved unnamed records', () => {
    expect(route(input({ from: 'bob' }))).toEqual({ kind: 'record' });
  });

  it('approved unnamed routes like an owner line in a room they invited this bot into', () => {
    const room = roomFixture({ invitedBy: 'bob' });
    expect(route(input({ from: 'bob', room }))).toMatchObject({ kind: 'wake', why: 'invited', origin: 'approved' });
    expect(route(input({ from: 'bob', room, self: 'bottwo' }))).toMatchObject({ kind: 'standby', position: 1 });
  });

  it('unlisted senders are counted whatever they type', () => {
    expect(route(input({ from: 'mallory' }))).toEqual({ kind: 'count' });
    expect(route(input({ from: 'mallory', text: 'botone: hi' }))).toEqual({ kind: 'count' });
    expect(route(input({ from: 'mallory', self: 'bottwo', text: HANDOFF }))).toEqual({ kind: 'count' });
  });

  it('an owner whisper wakes its recipient', () => {
    expect(route(input({ self: 'botthree', whisper: true }))).toEqual({ kind: 'wake', why: 'named', origin: 'owner', key: 'alice:4d' });
  });

  it('approved person pastes a hand-off: an ordinary named wake with their own limits', () => {
    const r = route(input({ self: 'bottwo', from: 'bob', text: HANDOFF }));
    expect(r).toEqual({ kind: 'wake', why: 'named', origin: 'approved', key: 'bob:4d' });
  });
});

describe('route: eligibility', () => {
  it('lead inside its own 8 s records', () => {
    const room = roomFixture({ selfJoinedAt: NOW - 7000 });
    expect(route(input({ room }))).toEqual({ kind: 'record' });
  });

  it('peers see the lead after 5 s, lead still silent to itself', () => {
    const seen = roomFixture({ joinSeenAt: new Map([['botone', NOW - 6000]]) });
    expect(route(input({ self: 'bottwo', room: seen }))).toMatchObject({ kind: 'standby', position: 1 });
    const fresh = roomFixture({ joinSeenAt: new Map([['botone', NOW - 3000]]) });
    expect(route(input({ self: 'bottwo', room: fresh }))).toMatchObject({ kind: 'wake', why: 'lead', order: ['bottwo', 'botthree'] });
  });

  it('an absent lead is skipped', () => {
    const room = roomFixture({ occupants: new Set(['alice', 'bottwo', 'botthree']) });
    expect(route(input({ self: 'bottwo', room }))).toMatchObject({ kind: 'wake', why: 'lead' });
  });

  it('roster mismatch falls back to name order', () => {
    const policy = policyFixture({ chain: chainConfig({ roster: [
      { screenName: 'bottwo', role: '', aliases: [] },
      { screenName: 'botone', role: '', aliases: [] },
      { screenName: 'botthree', role: '', aliases: [] },
    ] }) });
    expect(route(input({ policy }))).toMatchObject({ kind: 'standby', position: 1 });
    expect(route(input({ policy, rosterMismatch: true }))).toMatchObject({ kind: 'wake', order: ['botone', 'botthree', 'bottwo'] });
  });

  it('a solo bot is always the lead', () => {
    const policy = policyFixture({ chain: chainConfig({ roster: [] }) });
    const room = roomFixture({ selfJoinedAt: NOW });
    expect(route(input({ policy, room }))).toMatchObject({ kind: 'wake', why: 'lead', order: ['botone'] });
  });

  it('a bot missing from its own roster answers only when named', () => {
    expect(route(input({ self: 'botnine' }))).toEqual({ kind: 'record' });
    expect(route(input({ self: 'botnine', text: 'botnine: hi' }))).toMatchObject({ kind: 'wake', why: 'named' });
  });

  it('exposes the order for the controller', () => {
    expect(candidateOrder('bottwo', NOW, policyFixture(), roomFixture(), false, new Map())).toEqual(['botone', 'bottwo', 'botthree']);
    expect(candidateOrder('bottwo', NOW, policyFixture(), roomFixture(), false, new Map([['botthree', NOW - 1000]])))
      .toEqual(['botthree', 'botone', 'bottwo']);
  });
});

describe('route: the floor', () => {
  it('a worker asked the owner a question, so the owner\'s next unnamed line is that worker\'s', () => {
    const asked = new Map([['bottwo', NOW - 30_000]]);
    const order = ['bottwo', 'botone', 'botthree'];
    expect(route(input({ self: 'bottwo', asked }))).toEqual({ kind: 'wake', why: 'floor', origin: 'owner', key: 'alice:4d', order });
    expect(route(input({ self: 'botone', asked }))).toMatchObject({ kind: 'standby', position: 1, order });
    expect(route(input({ self: 'botthree', asked }))).toMatchObject({ kind: 'standby', position: 2, order });
  });

  it('a worker reported done, so the next unnamed line goes to the chair', () => {
    // nothing is open: noteRoomLine closed bottwo's question when it spoke without asking one
    expect(route(input({ asked: new Map() }))).toMatchObject({ kind: 'wake', why: 'lead', order: ['botone', 'bottwo', 'botthree'] });
    expect(route(input({ self: 'bottwo', asked: new Map() }))).toMatchObject({ kind: 'standby', position: 1 });
  });

  it('a question older than floorSeconds falls back to the chair', () => {
    expect(route(input({ asked: new Map([['bottwo', NOW - 120_000]]) })))
      .toMatchObject({ kind: 'wake', why: 'lead', order: ['botone', 'bottwo', 'botthree'] });
    expect(route(input({ asked: new Map([['bottwo', NOW - 119_999]]) })))
      .toMatchObject({ kind: 'standby', position: 1, order: ['bottwo', 'botone', 'botthree'] });
  });

  it('two bots waiting on an answer: neither holds the floor', () => {
    const asked = new Map([['bottwo', NOW - 2000], ['botthree', NOW - 1000]]);
    expect(route(input({ asked }))).toMatchObject({ kind: 'wake', why: 'lead', order: ['botone', 'bottwo', 'botthree'] });
    expect(route(input({ self: 'botthree', asked }))).toMatchObject({ kind: 'standby', position: 2 });
  });

  it('a waiting bot that left the room falls back to the chair', () => {
    const room = roomFixture({ occupants: new Set(['alice', 'botone', 'botthree']) });
    expect(route(input({ room, asked: new Map([['bottwo', NOW - 1000]]) })))
      .toMatchObject({ kind: 'wake', why: 'lead', order: ['botone', 'botthree'] });
  });

  it('the chair holds the floor for its own question', () => {
    expect(route(input({ asked: new Map([['botone', NOW - 1000]]) })))
      .toMatchObject({ kind: 'wake', why: 'floor', order: ['botone', 'bottwo', 'botthree'] });
  });

  it('the floor only ever moves an unnamed owner line', () => {
    const asked = new Map([['bottwo', NOW - 1000]]);
    expect(route(input({ self: 'botthree', text: 'botthree: fix it', asked }))).toMatchObject({ kind: 'wake', why: 'named' });
    expect(route(input({ from: 'bob', asked }))).toEqual({ kind: 'record' });
    expect(route(input({ from: 'mallory', asked }))).toEqual({ kind: 'count' });
  });
});

describe('the floor: what holds it', () => {
  const policy = policyFixture();

  function after(lines: [string, string][]): string[] {
    const asked = new Map<string, number>();
    lines.forEach(([from, text], i) => noteRoomLine(asked, { from, text, at: NOW + i }, policy));
    return [...asked.keys()].sort();
  }

  const rows: [string, [string, string][], string[]][] = [
    ['a worker asks the owner a question', [['bottwo', 'should the intro keep the quote?']], ['bottwo']],
    ['the owner answers it', [['bottwo', 'should the intro keep the quote?'], ['alice', 'yes, keep it']], []],
    ['a worker reports done', [['bottwo', 'done, the intro is tighter']], []],
    ['a worker asks, then answers itself', [['bottwo', 'which draft?'], ['bottwo', 'never mind, found it']], []],
    ['another bot speaks after the question', [['bottwo', 'which draft?'], ['botthree', 'the tests pass']], []],
    ['an approved person speaks after the question', [['bottwo', 'which draft?'], ['bob', 'morning all']], []],
    ['an ack never holds it', [['bottwo', 'on it']], []],
    ['a hand-off line that asks a question never holds it', [['botone', 'bottwo: can you tighten the intro? [d:1-k7f3 h:1 o:alice]']], []],
    ['a result line never holds it', [['bottwo', 'botone: done [d:1-k7f3]']], []],
    ['a stranger chattering does not take the question away', [['bottwo', 'which draft?'], ['mallory', 'anyone there?']], ['bottwo']],
    ['a person is never waiting on an answer', [['alice', 'are you there?']], []],
    ['the second question replaces the first', [['bottwo', 'which draft?'], ['botthree', 'which branch?']], ['botthree']],
  ];
  it.each(rows)('%s', (_label, lines, holders) => {
    expect(after(lines)).toEqual(holders);
  });

  it('keeps both when two bots ask in the same instant, and then nobody holds the floor', () => {
    const asked = new Map<string, number>();
    noteRoomLine(asked, { from: 'bottwo', text: 'which draft?', at: NOW }, policy);
    noteRoomLine(asked, { from: 'botthree', text: 'which branch?', at: NOW }, policy);
    expect([...asked.keys()]).toEqual(['bottwo', 'botthree']);
    expect(floorHolder(asked, NOW, policy, ['botone', 'bottwo', 'botthree'])).toBeNull();
  });

  it('floorHolder wants exactly one eligible, fresh question', () => {
    const all = ['botone', 'bottwo', 'botthree'];
    expect(floorHolder(new Map(), NOW, policy, all)).toBeNull();
    expect(floorHolder(new Map([['bottwo', NOW - 1000]]), NOW, policy, all)).toBe('bottwo');
    expect(floorHolder(new Map([['bottwo', NOW - 120_000]]), NOW, policy, all)).toBeNull();
    expect(floorHolder(new Map([['bottwo', NOW - 1000]]), NOW, policy, ['botone', 'botthree'])).toBeNull();
  });

  it.each([
    ['a plain question', 'which draft?', true],
    ['a question at the end of a longer line', 'I fixed the intro. Shall I push it?', true],
    ['trailing spaces', 'which draft?   ', true],
    ['a closing quote after the mark', 'did you mean "the intro"?', true],
    ['bold around the question', '**which draft?**', true],
    ['a trailer is stripped before the check', 'which draft? [d:1-k7f3]', true],
    ['a statement', 'the intro is tighter', false],
    ['an ack', 'on it', false],
    ['a question in the middle', 'who knows? I pushed it anyway', false],
    ['nothing at all', '', false],
  ] as const)('endsWithQuestion: %s', (_label, text, expected) => {
    expect(endsWithQuestion(text)).toBe(expected);
  });
});

describe('route: bots', () => {
  it('own lines, the server voice and control whispers are ignored', () => {
    expect(route(input({ from: 'botone' }))).toEqual({ kind: 'ignore' });
    expect(route(input({ from: 'onlinehost' }))).toEqual({ kind: 'ignore' });
    expect(route(input({ from: 'bottwo', whisper: true, text: '#oc took alice:4d' }))).toEqual({ kind: 'ignore' });
  });

  it('hand-off intake', () => {
    expect(route(input({ self: 'bottwo', from: 'botone', text: HANDOFF }))).toEqual({
      kind: 'wake', why: 'handoff', origin: 'bot', key: 'botone:1-k7f3',
      handoff: { delegator: 'botone', trailer: { id: '1-k7f3', hop: 1, originator: 'alice' }, task: 'tighten the intro' },
    });
  });

  const refused: [string, Partial<Parameters<typeof input>[0]>][] = [
    ['from a bot below me', { self: 'bottwo', from: 'botthree', text: HANDOFF }],
    ['names another bot', { self: 'botthree', from: 'botone', text: HANDOFF }],
    ['hop above maxHops', { self: 'bottwo', from: 'botone', text: 'bottwo: x [d:1-k7f3 h:3 o:alice]' }],
    ['originator not on my lists', { self: 'bottwo', from: 'botone', text: 'bottwo: x [d:1-k7f3 h:1 o:mallory]' }],
    ['originator is a roster bot', { self: 'bottwo', from: 'botone', text: 'bottwo: x [d:1-k7f3 h:1 o:botone]' }],
    ['same id twice', { self: 'bottwo', from: 'botone', text: HANDOFF, seenHandoffs: new Set(['botone:1-k7f3']) }],
    ['whispered hand-off', { self: 'bottwo', from: 'botone', text: HANDOFF, whisper: true }],
    ['no trailer', { self: 'bottwo', from: 'botone', text: 'bottwo: tighten the intro' }],
    ['plain chatter', { self: 'bottwo', from: 'botone', text: 'working on it' }],
  ];
  it.each(refused)('records: %s', (_label, over) => {
    expect(route(input(over))).toEqual({ kind: 'record' });
  });

  it('a result from the hand-off target closes it', () => {
    const open = new Set(['bottwo:1-k7f3']);
    const r = route(input({ from: 'bottwo', text: 'botone: done [d:1-k7f3]', openHandoffIds: open }));
    expect(r).toEqual({ kind: 'record', result: { id: '1-k7f3', known: true } });
  });

  it('a result wakes the delegator when reviewResults is on', () => {
    const policy = policyFixture({ chain: chainConfig({ reviewResults: true }) });
    const open = new Set(['bottwo:1-k7f3']);
    expect(route(input({ policy, from: 'bottwo', text: 'botone: done [d:1-k7f3]', openHandoffIds: open }))).toEqual({
      kind: 'wake', why: 'review', origin: 'bot', key: 'bottwo:1-k7f3', result: { id: '1-k7f3', known: true },
    });
  });

  it('a result from another bot, or a second copy, is not known', () => {
    const open = new Set(['bottwo:1-k7f3']);
    expect(route(input({ from: 'botthree', text: 'botone: done [d:1-k7f3]', openHandoffIds: open }))).toEqual({
      kind: 'record', result: { id: '1-k7f3', known: false },
    });
    expect(route(input({ from: 'bottwo', text: 'botone: done [d:1-k7f3]' }))).toEqual({
      kind: 'record', result: { id: '1-k7f3', known: false },
    });
  });

  it('an unknown id addressed to me by rank wakes me only under reviewResults', () => {
    const policy = policyFixture({ chain: chainConfig({ reviewResults: true }) });
    expect(route(input({ policy, from: 'bottwo', text: 'finished at last [d:1-zzzz]' }))).toMatchObject({
      kind: 'wake', why: 'review', result: { id: '1-zzzz', known: false },
    });
    expect(route(input({ policy, from: 'bottwo', text: 'finished at last [d:2-zzzz]' }))).toEqual({ kind: 'record' });
  });

  it('a result tag from a bot above me is chatter', () => {
    expect(route(input({ self: 'bottwo', from: 'botone', text: 'bottwo: done [d:2-k7f3]' }))).toEqual({ kind: 'record' });
  });
});

describe('commandKey', () => {
  it('uses the cookie when there is one', () => {
    expect(commandKey('alice', 77n, 'anything')).toBe('alice:4d');
  });
  it('hashes normalised text when the cookie is 0', () => {
    const a = commandKey('alice', 0n, 'What is  the status?');
    expect(a).toMatch(/^alice:t[0-9a-f]{8}$/);
    expect(commandKey('alice', 0n, '  what is the STATUS? ')).toBe(a);
    expect(commandKey('alice', 0n, 'something else')).not.toBe(a);
  });
});
