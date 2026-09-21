import { describe, expect, it } from 'vitest';
import {
  decodePeerId, encodePeerId, formatTarget, isAsciiName, normalizeName, normalizeRoom, parseTarget, roomNameProblem,
} from '../../src/names.js';

describe('normalizeName', () => {
  it.each([
    ['Alice B', 'aliceb'],
    ['  Bot One ', 'botone'],
    ['oscar:Alice B', 'aliceb'],
    ['OSCAR:alice', 'alice'],
    ['a  b   c', 'abc'],
    ['', ''],
    ['Ünï', 'ünï'],
  ])('one normaliser: %j -> %j', (raw, want) => {
    expect(normalizeName(raw)).toBe(want);
  });

  it('keeps tabs, because the server only strips U+0020', () => {
    expect(normalizeName('a\tb')).toBe('a\tb');
  });
});

describe('isAsciiName', () => {
  it.each([
    ['alice', true], ['Bot One', true], ['', false], ['аlice', false], ['bob​', false], ['x\n', false],
  ])('%j -> %s', (raw, want) => {
    expect(isAsciiName(raw)).toBe(want);
  });
});

describe('room names', () => {
  it('lowercases and trims', () => {
    expect(normalizeRoom('  TestRoom ')).toBe('testroom');
  });
  it.each([
    ['testroom', null],
    ['', 'room name is empty'],
    ['a'.repeat(51), 'room name is longer than 50 characters'],
    ['my-room', 'room name contains "-"'],
    ['a/b', 'room name contains "/"'],
    ['a:b', 'room name contains ":"'],
  ])('%j -> %j', (raw, want) => {
    expect(roomNameProblem(raw)).toBe(want);
  });
});

describe('peer ids', () => {
  it.each([
    [{ kind: 'im', bot: 'botone', peer: 'alice' }, 'botone/alice'],
    [{ kind: 'im', bot: 'Bot One', peer: 'Alice B' }, 'botone/aliceb'],
    [{ kind: 'im', bot: 'botone', peer: 'a:b' }, 'botone/a%3ab'],
    [{ kind: 'room', bot: 'botone', room: { exchange: 4, name: 'testroom' } }, 'botone#4.testroom'],
    [{ kind: 'room', bot: 'botone', room: { exchange: 5, name: 'My Room:1' } }, 'botone#5.my%20room%3a1'],
    [{ kind: 'room', bot: 'botone', room: { exchange: 4, name: 'a.b_c' } }, 'botone#4.a.b_c'],
    [{ kind: 'room', bot: 'botone', room: { exchange: 4, name: 'café' } }, 'botone#4.caf%c3%a9'],
  ] as const)('encodes %j', (ref, want) => {
    expect(encodePeerId(ref)).toBe(want);
  });

  it('never emits a colon', () => {
    expect(encodePeerId({ kind: 'room', bot: 'botone', room: { exchange: 4, name: 'a:b/c#d%e' } })).not.toMatch(/:/);
  });

  it('round-trips', () => {
    for (const id of ['botone/alice', 'botone/a%3ab', 'botone#4.testroom', 'botone#5.my%20room%3a1', 'botone#4.a.b_c']) {
      const ref = decodePeerId(id);
      expect(ref).not.toBeNull();
      expect(encodePeerId(ref!)).toBe(id);
    }
  });

  it('decodes what core hands back in upper-case hex', () => {
    expect(decodePeerId('botone#4.my%20Room%3A1')).toEqual({ kind: 'room', bot: 'botone', room: { exchange: 4, name: 'my room:1' } });
  });

  it.each(['', 'alice', 'botone/', '/alice', 'botone#4', 'botone#6.room', 'botone#4.', 'botone/%zz'])('rejects %j', (id) => {
    expect(decodePeerId(id)).toBeNull();
  });
});

describe('targets', () => {
  it.each([
    ['alice', { kind: 'im', name: 'alice' }],
    ['Alice B', { kind: 'im', name: 'aliceb' }],
    ['oscar:Alice B', { kind: 'im', name: 'aliceb' }],
    ['room:TestRoom', { kind: 'room', room: { exchange: 4, name: 'testroom' } }],
    ['room:5:lobby', { kind: 'room', room: { exchange: 5, name: 'lobby' } }],
    ['room:4:a:b', { kind: 'room', room: { exchange: 4, name: 'a:b' } }],
    ['oscar:room:4:testroom', { kind: 'room', room: { exchange: 4, name: 'testroom' } }],
    ['botone/alice', { kind: 'im', name: 'alice' }],
    ['BotOne/Alice', { kind: 'im', name: 'alice' }],
    ['botone#4.testroom', { kind: 'room', room: { exchange: 4, name: 'testroom' } }],
  ] as const)('parses %j', (raw, want) => {
    expect(parseTarget(raw, 'botone')).toEqual(want);
  });

  it.each(['', '   ', 'room:', 'user:alice', 'bottwo/alice', 'bottwo#4.testroom', 'botone/'])('rejects %j for botone', (raw) => {
    expect(parseTarget(raw, 'botone')).toBeNull();
  });

  it('skips the bot check when no bot is given', () => {
    expect(parseTarget('bottwo/alice', '')).toEqual({ kind: 'im', name: 'alice' });
  });

  it('formats canonically', () => {
    expect(formatTarget({ kind: 'im', name: 'alice' })).toBe('alice');
    expect(formatTarget({ kind: 'room', room: { exchange: 4, name: 'testroom' } })).toBe('room:4:testroom');
    expect(parseTarget(formatTarget({ kind: 'room', room: { exchange: 5, name: 'a:b' } }), 'botone'))
      .toEqual({ kind: 'room', room: { exchange: 5, name: 'a:b' } });
  });
});
