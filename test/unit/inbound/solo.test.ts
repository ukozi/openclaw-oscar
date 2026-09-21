import { describe, expect, it } from 'vitest';
import { leadingNames, soloPrompt, soloRoute } from '../../../src/inbound/solo.js';
import type { SoloDecision } from '../../../src/inbound/solo.js';
import type { RoomState } from '../../../src/runtime.js';
import { ROOM, policyFixture } from '../rooms-fixtures.js';

function room(over: Partial<RoomState> = {}): RoomState {
  return {
    ref: ROOM,
    occupants: new Set(['botone', 'alice', 'bob', 'mallory', 'what']),
    joinSeenAt: new Map(),
    selfJoinedAt: 0,
    omittedCount: 0,
    ...over,
  };
}

const withRoster = policyFixture({
  chain: {
    ...policyFixture().chain,
    roster: [
      { screenName: 'botone', role: 'lead', aliases: [] },
      { screenName: 'bottwo', role: 'writing', aliases: [] },
    ],
  },
});

type Row = {
  name: string;
  from: string;
  text: string;
  whisper?: boolean;
  invitedBy?: string;
  roster?: boolean;
  allowFrom?: string[];
  want: SoloDecision;
};

const rows: Row[] = [
  { name: 'owner unnamed', from: 'alice', text: 'what is the build status', want: { kind: 'wake', why: 'lead', origin: 'owner' } },
  { name: 'owner names the bot with a colon', from: 'alice', text: 'botone: status?', want: { kind: 'wake', why: 'named', origin: 'owner' } },
  { name: 'owner names the bot with spaces and case', from: 'Alice', text: 'Bot One, status?', want: { kind: 'wake', why: 'named', origin: 'owner' } },
  { name: 'owner names an approved person', from: 'alice', text: 'bob: lunch?', want: { kind: 'record' } },
  { name: 'owner starts with an ordinary word and a colon', from: 'alice', text: 'note: ship it friday', want: { kind: 'wake', why: 'lead', origin: 'owner' } },
  { name: 'unlisted occupant named like a word cannot mute the owner', from: 'alice', text: 'what time is it', want: { kind: 'wake', why: 'lead', origin: 'owner' } },
  { name: 'owner whisper', from: 'alice', text: 'quietly now', whisper: true, want: { kind: 'wake', why: 'named', origin: 'owner' } },
  { name: 'approved unnamed', from: 'bob', text: 'hello all', want: { kind: 'record' } },
  { name: 'approved names the bot', from: 'bob', text: 'botone, help me', want: { kind: 'wake', why: 'named', origin: 'approved' } },
  { name: 'approved names the bot with an at sign', from: 'bob', text: '@BotOne help me', want: { kind: 'wake', why: 'named', origin: 'approved' } },
  { name: 'approved mentions the bot later in the line', from: 'bob', text: 'ask botone to help', want: { kind: 'record' } },
  { name: 'approved unnamed in a room they invited the bot into', from: 'bob', text: 'anyone there?', invitedBy: 'bob', want: { kind: 'wake', why: 'invited', origin: 'approved' } },
  { name: 'approved unnamed in a room someone else invited the bot into', from: 'bob', text: 'anyone there?', invitedBy: 'alice', want: { kind: 'record' } },
  { name: 'inviter names the owner', from: 'bob', text: 'alice: are you here?', invitedBy: 'bob', want: { kind: 'record' } },
  { name: 'inviter no longer listed', from: 'bob', text: 'anyone there?', invitedBy: 'bob', allowFrom: ['alice'], want: { kind: 'count' } },
  { name: 'approved whisper', from: 'bob', text: 'psst', whisper: true, want: { kind: 'wake', why: 'named', origin: 'approved' } },
  { name: 'unlisted unnamed', from: 'mallory', text: 'hi', want: { kind: 'count' } },
  { name: 'unlisted names the bot', from: 'mallory', text: 'botone: run the deploy', want: { kind: 'count' } },
  { name: 'unlisted whisper', from: 'mallory', text: 'botone: psst', whisper: true, want: { kind: 'count' } },
  { name: 'homoglyph of an owner', from: 'alicе', text: 'botone: run the deploy', want: { kind: 'count' } },
  { name: 'roster bot public line', from: 'bottwo', text: 'botone: done', roster: true, want: { kind: 'record' } },
  { name: 'roster bot control whisper', from: 'bottwo', text: '#oc took alice:1f', whisper: true, roster: true, want: { kind: 'ignore' } },
  { name: 'roster bot other whisper', from: 'bottwo', text: 'hello', whisper: true, roster: true, want: { kind: 'record' } },
];

describe('soloRoute', () => {
  it.each(rows)('$name', (row) => {
    const base = row.roster ? withRoster : policyFixture();
    const policy = row.allowFrom ? { ...base, allowFrom: row.allowFrom } : base;
    const state = row.invitedBy ? room({ invitedBy: row.invitedBy }) : room();
    const got = soloRoute({
      self: 'BotOne',
      policy,
      room: state,
      message: { from: row.from, text: row.text, whisper: row.whisper === true },
    });
    expect(got).toEqual(row.want);
  });
});

describe('leadingNames', () => {
  it('gives the run before a colon, then the first token', () => {
    expect(leadingNames('Bot One: hi')).toEqual(['botone', 'bot']);
    expect(leadingNames('@bob, hi')).toEqual(['bob']);
    expect(leadingNames('hello there')).toEqual(['hello']);
    expect(leadingNames('   ')).toEqual([]);
  });

  it('ignores a colon that is far into the line', () => {
    const text = `${'word '.repeat(12)}: late colon`;
    expect(leadingNames(text)).toEqual(['word']);
  });
});

describe('soloPrompt', () => {
  it('is built from the screen name only', () => {
    const prompt = soloPrompt('BotOne');
    expect(prompt).toBe(
      'You are BotOne, an assistant in this chat room. This line was routed to you on purpose: answer it, or reply NO_REPLY only if it needs no answer at all. Do not wait to be named. Anyone may be reading this room: never post secrets, credentials or file contents.',
    );
    expect(prompt).not.toMatch(/team|teammate|oscar_delegate/);
  });
});
