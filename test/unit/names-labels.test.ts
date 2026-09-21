import { describe, expect, it } from 'vitest';
import { escapeNonAscii, senderLabel } from '../../src/names.js';

describe('sender labels', () => {
  it('leaves ASCII names alone', () => {
    expect(escapeNonAscii('alice_99')).toBe('alice_99');
    expect(senderLabel('alice', 'owner')).toBe('alice (owner)');
  });

  it('escapes non-ASCII letters', () => {
    expect(escapeNonAscii('alicе')).toBe('alic\\u{435}');
    expect(senderLabel('lucаs', 'unlisted')).toBe('luc\\u{430}s (unlisted)');
  });

  it('escapes astral code points and control characters whole', () => {
    expect(escapeNonAscii('a\u{1F600}b')).toBe('a\\u{1f600}b');
    expect(escapeNonAscii('a\nb')).toBe('a\\u{a}b');
  });
});
