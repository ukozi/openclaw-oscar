import { describe, expect, it } from 'vitest';
import { parseSetupReply, type SetupReply } from '../../../src/rooms/grammar.js';

const teammates = ['botone', 'bottwo', 'botthree'];

function parse(text: string, pending: number, rooms: string[] = ['testroom']): SetupReply {
  return parseSetupReply(text, { rooms, pending, teammates });
}

describe('parseSetupReply', () => {
  it.each<[string, number, SetupReply]>([
    ['team private', 1, { kind: 'settings', mode: 'team', trust: 'private' }],
    ['team botone bottwo botthree', 1, { kind: 'settings', mode: 'team', rank: ['botone', 'bottwo', 'botthree'] }],
    ['team private bottwo botone', 1, { kind: 'settings', mode: 'team', trust: 'private', rank: ['bottwo', 'botone'] }],
    ['lounge', 1, { kind: 'settings', mode: 'lounge' }],
    ['watch public', 1, { kind: 'settings', mode: 'watch', trust: 'public' }],
    ['public', 1, { kind: 'settings', trust: 'public' }],
    ['testroom watch public', 0, { kind: 'settings', room: 'testroom', mode: 'watch', trust: 'public' }],
    ['testroom private', 0, { kind: 'settings', room: 'testroom', trust: 'private' }],
    ['testroom same', 0, { kind: 'same', room: 'testroom' }],
    ['testroom no', 0, { kind: 'leave', room: 'testroom' }],
    ['same', 1, { kind: 'same' }],
    ['leave', 1, { kind: 'leave' }],
    ['no', 1, { kind: 'leave' }],
    ['No.', 1, { kind: 'not-setup' }],
    ['no', 0, { kind: 'not-setup' }],
    ['same', 0, { kind: 'not-setup' }],
    ['no, I meant tomorrow', 1, { kind: 'not-setup' }],
    ['team meeting at 3', 0, { kind: 'not-setup' }],
    ['team meeting', 1, { kind: 'error', word: 'meeting' }],
    ['leave testroom', 0, { kind: 'leave', room: 'testroom' }],
    ['leave testroom', 2, { kind: 'leave', room: 'testroom' }],
    ['leave testroom now', 0, { kind: 'not-setup' }],
    ['leave now', 1, { kind: 'not-setup' }],
    ['TEAM, Private', 1, { kind: 'settings', mode: 'team', trust: 'private' }],
    ['  Team,,  BotOne  ', 1, { kind: 'settings', mode: 'team', rank: ['botone'] }],
    ['team botone private', 1, { kind: 'error', word: 'private' }],
    ['team botone botone', 1, { kind: 'error', word: 'botone' }],
    ['lounge botone', 1, { kind: 'error', word: 'botone' }],
    ['watch private bottwo', 1, { kind: 'error', word: 'bottwo' }],
    ['team private public', 1, { kind: 'error', word: 'public' }],
    ['team lounge', 1, { kind: 'error', word: 'lounge' }],
    ['public team', 1, { kind: 'error', word: 'team' }],
    ['same please', 1, { kind: 'not-setup' }],
    ['testroom same please', 0, { kind: 'error', word: 'please' }],
    ['testroom was fun', 0, { kind: 'not-setup' }],
    ['testroom', 0, { kind: 'not-setup' }],
    ['otherroom team', 0, { kind: 'not-setup' }],
    ['hello there', 1, { kind: 'not-setup' }],
    ['', 1, { kind: 'not-setup' }],
  ])('%j with %i pending', (text, pending, want) => {
    expect(parse(text, pending)).toEqual(want);
  });

  it('matches the room name case-insensitively', () => {
    expect(parse('TestRoom team', 0)).toEqual({ kind: 'settings', room: 'testroom', mode: 'team' });
    expect(parse('testroom team', 0, ['TestRoom'])).toEqual({ kind: 'settings', room: 'testroom', mode: 'team' });
  });

  it('reads a room named like a keyword as the room when a body follows', () => {
    expect(parse('lounge team private', 0, ['lounge'])).toEqual({
      kind: 'settings',
      room: 'lounge',
      mode: 'team',
      trust: 'private',
    });
  });
});
