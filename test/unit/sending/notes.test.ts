import { describe, expect, it } from 'vitest';
import { copy } from '../../../src/copy.js';
import { FILES_LIMITS } from '../../../src/inbound/media-gate.js';
import { createSendNotes } from '../../../src/sending/notes.js';
import type { SendProblem } from '../../../src/sending/notes.js';

const cfg = { channels: { oscar: { owners: ['alice'], allowFrom: ['bob'], files: { sendFile: true, maxMb: 5 } } } };
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function harness(send?: (to: string, text: string) => Promise<void>) {
  const clock = { at: 1_000_000 };
  const sent: { to: string; text: string }[] = [];
  const warnings: { msg: string; fields?: Record<string, unknown> }[] = [];
  const note = createSendNotes({
    getCfg: () => cfg,
    now: () => clock.at,
    log: { debug() {}, info() {}, warn: (msg, fields) => void warnings.push({ msg, ...(fields ? { fields } : {}) }), error() {} },
    send: send ?? (async (to, text) => void sent.push({ to, text })),
  });
  return { clock, sent, warnings, note };
}

describe('copy.fileNotSent', () => {
  it('has a line for each reason, with the number from the setting', () => {
    const reasons: SendProblem[] = ['off', 'failed', 'too-large', 'too-many'];
    for (const why of reasons) expect(copy.fileNotSent(why, { maxMb: 7 }).length).toBeGreaterThan(0);
    expect(new Set(reasons.map((why) => copy.fileNotSent(why, { maxMb: 7 }))).size).toBe(4);
    expect(copy.fileNotSent('too-large', { maxMb: 7 })).toContain('7 MB');
    expect(copy.fileNotSent('too-large', { maxMb: 12 })).not.toContain('7 MB');
    expect(copy.fileNotSent('too-many', { maxMb: 7 })).toContain('3');
  });

  it('adds the link to the failure line', () => {
    const link = 'https://example.com/a.pdf';
    expect(copy.fileNotSent('failed', { maxMb: 5, link })).toContain(link);
    expect(copy.fileNotSent('failed', { maxMb: 5 })).not.toContain('http');
  });
});

describe('createSendNotes', () => {
  it('sends one IM with the number from the setting', async () => {
    const h = harness();
    h.note('Bob', 'too-large');
    await settle();
    expect(h.sent).toEqual([{ to: 'bob', text: copy.fileNotSent('too-large', { maxMb: 5 }) }]);
  });

  it('sends a reason to one person once a minute', async () => {
    const h = harness();
    h.note('bob', 'failed');
    h.clock.at += FILES_LIMITS.refusalCooldownMs - 1;
    h.note('Bob', 'failed');
    h.note('bob', 'off');
    h.note('alice', 'failed');
    await settle();
    expect(h.sent.map((m) => m.to)).toEqual(['bob', 'bob', 'alice']);
    h.clock.at += 1;
    h.note('bob', 'failed');
    await settle();
    expect(h.sent).toHaveLength(4);
  });

  it('does not hold back a line that carries a link', async () => {
    const h = harness();
    h.note('bob', 'failed');
    h.note('bob', 'failed', 'https://example.com/a.pdf');
    await settle();
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]?.text).toContain('https://example.com/a.pdf');
  });

  it('gives each different link once a minute', async () => {
    const h = harness();
    h.note('bob', 'failed', 'https://example.com/a.pdf');
    h.note('bob', 'failed', 'https://example.com/b.pdf');
    h.note('bob', 'failed', 'https://example.com/a.pdf');
    await settle();
    expect(h.sent).toHaveLength(2);
    expect(h.sent[0]?.text).toContain('a.pdf');
    expect(h.sent[1]?.text).toContain('b.pdf');
  });

  it('does not send for an empty name', async () => {
    const h = harness();
    h.note('  ', 'off');
    await settle();
    expect(h.sent).toEqual([]);
  });

  it('logs a line that was not delivered and does not throw', async () => {
    const h = harness(async () => { throw new Error('rate limited'); });
    expect(() => h.note('bob', 'off')).not.toThrow();
    await settle();
    expect(h.warnings).toEqual([{ msg: 'file note was not delivered', fields: { to: 'bob', why: 'off', error: 'rate limited' } }]);
  });
});
