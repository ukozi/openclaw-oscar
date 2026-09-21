import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { copy } from '../src/copy.js';

const BANNED = [/\baim\b/i, /\baol\b/i, /oscar/i, /instant\s+messenger/i];
const ALLOWED_PATH = /channels\.oscar\.[A-Za-z]+/g;

function samples(): string[] {
  return [
    copy.noticeIm('mallory'), copy.noticeInvite('mallory'),
    copy.noticeApprove('mallory', true), copy.noticeApprove('mallory', false),
    copy.noticeOddName(), copy.noticeRollup(1), copy.noticeRollup(4),
    copy.unlistedJoin('mallory', 'testroom'), copy.inviteFull(),
    copy.ack(''), copy.busy(''), copy.closing(), copy.takeover('botone'), copy.mismatch('botone', 'bottwo'),
    copy.outcome('botone', '2-k7f3', 'done'), copy.outcome('botone', '2-k7f3', 'none'), copy.outcome('botone', '2-k7f3', 'failed'),
    copy.awayDefault(),
    copy.awayPhrase('shell'), copy.awayPhrase('files'), copy.awayPhrase('web'), copy.awayPhrase('handoff'), copy.awayPhrase('memory'),
    copy.awayAutoReply('Working in some files'), copy.awayAutoReply('   '),
  ];
}

describe('copy', () => {
  it('has no trademarked words in any string', () => {
    for (const text of samples()) {
      const checked = text.replace(ALLOWED_PATH, '');
      for (const re of BANNED) expect(checked, text).not.toMatch(re);
    }
  });

  it('has no trademarked words anywhere in the file', () => {
    const source = readFileSync(new URL('../src/copy.ts', import.meta.url), 'utf8').replace(ALLOWED_PATH, '');
    for (const re of BANNED) expect(source).not.toMatch(re);
  });

  it('matches the spec table', () => {
    expect(copy.noticeIm('mallory')).toBe('mallory tried to message me. I did not reply.');
    expect(copy.noticeInvite('mallory')).toBe('mallory invited me to a chat. I did not join.');
    expect(copy.noticeApprove('mallory', true)).toBe('To let them in, reply: /allowlist add dm mallory');
    expect(copy.noticeApprove('mallory', false)).toBe('To let them in, add mallory to channels.oscar.allowFrom.');
    expect(copy.noticeOddName()).toBe('That name contains unusual letters.');
    expect(copy.noticeRollup(4)).toBe('4 more people tried to reach me this hour. I did not reply to any of them.');
    expect(copy.unlistedJoin('mallory', 'testroom')).toBe('mallory joined testroom. They are not on my lists.');
    expect(copy.inviteFull()).toBe("I can't join right now, I'm in too many rooms.");
    expect(copy.closing()).toBe('nothing to add');
    expect(copy.takeover('botone')).toBe("botone is quiet, I'll take this.");
    expect(copy.mismatch('botone', 'bottwo')).toBe('botone and bottwo disagree about the chain of command. Using name order until their configs match.');
    expect(copy.outcome('botone', '2-k7f3', 'done')).toBe('botone: done [d:2-k7f3]');
    expect(copy.outcome('botone', '2-k7f3', 'none')).toBe('botone: nothing to report [d:2-k7f3]');
    expect(copy.outcome('botone', '2-k7f3', 'failed')).toBe('botone: that failed on my side [d:2-k7f3]');
    expect(copy.awayDefault()).toBe('Working on something. Back in a bit.');
    expect(copy.awayPhrase('shell')).toBe('Running some commands');
    expect(copy.awayPhrase('files')).toBe('Working in some files');
    expect(copy.awayPhrase('web')).toBe('Looking something up');
    expect(copy.awayPhrase('handoff')).toBe('Handing work to a teammate');
    expect(copy.awayPhrase('memory')).toBe('Checking my notes');
    expect(copy.awayAutoReply('Working in some files')).toBe('Working in some files');
    expect(copy.awayAutoReply('   ')).toBe('Working on something. Back in a bit.');
  });

  it('uses the singular for one', () => {
    expect(copy.noticeRollup(1)).toBe('1 more person tried to reach me this hour. I did not reply to them.');
  });

  it('falls back to the default ack and busy lines', () => {
    expect(copy.ack('')).toBe('on it');
    expect(copy.ack('  ')).toBe('on it');
    expect(copy.ack('working')).toBe('working');
    expect(copy.busy('')).toBe('busy, will pick this up next');
    expect(copy.busy('later')).toBe('later');
  });
});
