import { describe, expect, it } from 'vitest';
import { address, addressFor } from '../../../src/chain/address.js';
import type { AddressNames } from '../../../src/chain/address.js';
import { chainConfig } from './fixtures.js';

const names: AddressNames = {
  roster: chainConfig().roster,
  self: 'botone',
  occupants: ['alice', 'bob', 'trudy', 'botone', 'bottwo', 'botthree'],
  people: ['alice', 'bob'],
};

const rows: [string, string, string[], boolean][] = [
  ['name and colon', 'bottwo: tighten the intro', ['bottwo'], false],
  ['spaces before colon', 'Bot Two: tighten the intro', ['bottwo'], false],
  ['spaces no colon', 'bot two tighten the intro', ['bottwo'], false],
  ['spaces before comma', 'Bot Two, can you check?', ['bottwo'], false],
  ['curly possessive', 'writer’s draft is late', [], false],
  ['leading @', '@bottwo tighten the intro', ['bottwo'], false],
  ['alias', 'writer: fix this', ['bottwo'], false],
  ['alias, upper case, comma', 'WRITER, fix this', ['bottwo'], false],
  ['two names with comma', 'bottwo, botthree: sync up', ['bottwo', 'botthree'], false],
  ['two names with &', 'bottwo & botthree: sync up', ['bottwo', 'botthree'], false],
  ['two names with and', 'bottwo and botthree sync up', ['bottwo', 'botthree'], false],
  ['three names no spaces', 'bottwo,botthree,botone: all of you', ['bottwo', 'botthree', 'botone'], false],
  ['and followed by a word', 'bottwo and then publish', ['bottwo'], false],
  ['leading human', 'bob: are you there', [], true],
  ['human and bot', 'bob and bottwo: sync', ['bottwo'], true],
  ['unlisted occupant', 'trudy, hello', [], true],
  ['name later in the line', 'ask bottwo to tighten the intro', [], false],
  ['note:', 'note: ship it friday', [], false],
  ['possessive', "writer's draft is late", [], false],
  ['alias as word inside a sentence', 'the writer should fix this', [], false],
  ['self', 'botone what is the status', ['botone'], false],
  ['html around the name', '<b>bottwo</b>: bold name', ['bottwo'], false],
  ['whole line is the name', 'bottwo', ['bottwo'], false],
  ['question mark ends a name', 'bottwo? are you there', ['bottwo'], false],
  ['longer word starting with a name', 'bottwofoo: hi', [], false],
  ['empty', '', [], false],
  ['leading spaces', '   bottwo: hi', ['bottwo'], false],
  ['interjection first', 'well, bottwo should do it', [], false],
  ['same bot twice', 'bottwo, writer: hi', ['bottwo'], false],
  ['unknown name', 'andy: hi', [], false],
];

describe('address', () => {
  it.each(rows)('%s', (_label, text, bots, human) => {
    expect(address(text, names)).toEqual({ bots, human });
  });

  it('knows self when the roster is empty', () => {
    const solo = { ...names, roster: [] };
    expect(address('botone: hi', solo)).toEqual({ bots: ['botone'], human: false });
    expect(address('bottwo: hi', solo)).toEqual({ bots: [], human: true });
  });

  it('matches a roster name written with spaces in config', () => {
    const spaced = { ...names, roster: [{ screenName: 'Bot Two', role: '', aliases: ['The Writer'] }] };
    expect(address('thewriter: hi', spaced).bots).toEqual(['bottwo']);
    expect(address('the writer, hi', spaced).bots).toEqual(['bottwo']);
  });
});

describe('addressFor', () => {
  it('addresses an owner whisper to its recipient', () => {
    expect(addressFor({ text: 'do the thing', whisper: true }, 'owner', names)).toEqual({ bots: ['botone'], human: false });
  });
  it('reads an approved whisper by the ordinary grammar', () => {
    expect(addressFor({ text: 'do the thing', whisper: true }, 'approved', names)).toEqual({ bots: [], human: false });
    expect(addressFor({ text: 'botone: do it', whisper: true }, 'approved', names).bots).toEqual(['botone']);
  });
  it('reads a public owner line by the ordinary grammar', () => {
    expect(addressFor({ text: 'do the thing', whisper: false }, 'owner', names)).toEqual({ bots: [], human: false });
  });
});
