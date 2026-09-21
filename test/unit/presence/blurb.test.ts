import { describe, expect, it } from 'vitest';
import { capText, familyForTool, filterBlurb, foldAscii, forbiddenNames, phraseForTool } from '../../../src/presence/blurb.js';

const NAMES = ['alice', 'bob', 'Bot One', 'bottwo', 'al'];

describe('filterBlurb', () => {
  const pass: [string, string, string][] = [
    ['plain sentence', 'Tidying up a report', 'Tidying up a report'],
    ['html tags', '<b>Reading</b> the <i>docs</i>', 'Reading the docs'],
    ['html entities', 'Research &amp; notes', 'Research and notes'],
    ['markdown emphasis', '**Drafting** a `plan`', 'Drafting a plan'],
    ['curly quotes and dash', 'It\u2019s a long one \u2014 back soon', "It's a long one - back soon"],
    ['accents', 'Caf\u00E9 r\u00E9sum\u00E9 review', 'Cafe resume review'],
    ['emoji dropped', 'Building things \u{1F6E0}\uFE0F', 'Building things'],
    ['newlines and tabs', 'Line one\n\tline two', 'Line one line two'],
    ['four digits', 'Planning for 2026', 'Planning for 2026'],
    ['name inside a longer word', 'Sorting albums', 'Sorting albums'],
    ['underscore', 'Fixing a unit_test', 'Fixing a unit test'],
  ];
  it.each(pass)('keeps %s', (_label, input, want) => {
    expect(filterBlurb(input, NAMES, 100)).toBe(want);
  });

  const reject: [string, string][] = [
    ['unix path', 'Editing /etc/passwd'],
    ['relative path', 'Editing src/index.ts'],
    ['windows path', 'Editing C:\\Users\\me'],
    ['home path', 'Looking in ~ for files'],
    ['email', 'Writing to someone@example.net'],
    ['handle', 'Pinging @someone'],
    ['url', 'Reading https://example.net'],
    ['scheme only', 'Opening ftp://'],
    ['five digits', 'Order 12345 is next'],
    ['phone number', 'Calling 5551234567'],
    ['owner name', 'Helping alice with a draft'],
    ['owner name upper case', 'Helping ALICE with a draft'],
    ['owner name possessive', "Fixing alice's draft"],
    ['approved name', 'A favour for Bob'],
    ['roster name written apart', 'Waiting on bot one'],
    ['roster name written together', 'Waiting on BotOne'],
    ['roster name with punctuation', 'Ask bot-two'],
    ['short name as its own word', 'Al asked for this'],
    ['path inside link text', '<a href="x">a/b</a>'],
    ['only markup', '<b></b>'],
    ['only symbols', '*** ... ***'],
    ['only non-ASCII', '\u4F5C\u696D\u4E2D'],
    ['empty', '   '],
  ];
  it.each(reject)('rejects %s', (_label, input) => {
    expect(filterBlurb(input, NAMES, 100)).toBeNull();
  });

  it('caps at a word boundary', () => {
    const out = filterBlurb('Working through a very long list of chores today', [], 30);
    expect(out).toBe('Working through a very long');
    expect(out!.length).toBeLessThanOrEqual(30);
  });

  it('caps a single long word hard', () => {
    expect(filterBlurb('Supercalifragilisticexpialidocious', [], 10)).toBe('Supercalif');
  });

  it('never returns non-ASCII or markup characters', () => {
    const out = filterBlurb('<i>Na\u00EFve</i> \u201Cplan\u201D & <notes>', [], 100)!;
    expect(out).toBe('Naive plan and');
    expect(/^[\x20-\x7E]+$/.test(out)).toBe(true);
    expect(/[<>&"]/.test(out)).toBe(false);
  });

  it('ignores blank forbidden names', () => {
    expect(filterBlurb('Reading the docs', ['', '  '], 100)).toBe('Reading the docs');
  });
});

describe('foldAscii and capText', () => {
  it('folds to printable ASCII', () => {
    expect(foldAscii('\u00C5ngstr\u00F6m\u2026 ok\u00A0then')).toBe('Angstrom... ok then');
  });
  it('leaves short text alone', () => {
    expect(capText('Back soon', 100)).toBe('Back soon');
  });
  it('drops trailing punctuation left by the cut', () => {
    expect(capText('Sorting notes, then lunch', 14)).toBe('Sorting notes');
  });
});

describe('phraseForTool', () => {
  const rows: [string, string | null, string | null][] = [
    ['exec', 'shell', 'Running some commands'],
    ['bash', 'shell', 'Running some commands'],
    ['process', 'shell', 'Running some commands'],
    ['code_execution', 'shell', 'Running some commands'],
    ['read', 'files', 'Working in some files'],
    ['write', 'files', 'Working in some files'],
    ['edit', 'files', 'Working in some files'],
    ['apply_patch', 'files', 'Working in some files'],
    ['web_search', 'web', 'Looking something up'],
    ['x_search', 'web', 'Looking something up'],
    ['web_fetch', 'web', 'Looking something up'],
    ['browser', 'web', 'Looking something up'],
    ['oscar_delegate', 'handoff', 'Handing work to a teammate'],
    ['memory_search', 'memory', 'Checking my notes'],
    ['memory_get', 'memory', 'Checking my notes'],
    ['sessions_list', 'memory', 'Checking my notes'],
    ['sessions_history', 'memory', 'Checking my notes'],
    ['sessions_send', 'memory', 'Checking my notes'],
    ['sessions_spawn', 'memory', 'Checking my notes'],
    ['sessions_yield', 'memory', 'Checking my notes'],
    ['subagents', 'memory', 'Checking my notes'],
    ['session_status', 'memory', 'Checking my notes'],
    [' Exec ', 'shell', 'Running some commands'],
    ['message', null, null],
    ['oscar_status', null, null],
    ['oscar_room', null, null],
    ['cron', null, null],
    ['image_generate', null, null],
    ['', null, null],
  ];
  it.each(rows)('%s', (tool, family, phrase) => {
    expect(familyForTool(tool)).toBe(family);
    expect(phraseForTool(tool)).toBe(phrase);
  });
});

describe('forbiddenNames', () => {
  it('lists owners, approved people, roster names and aliases', () => {
    const names = forbiddenNames({
      owners: ['alice'],
      allowFrom: ['alice', 'bob'],
      chain: { roster: [{ screenName: 'botone', aliases: ['one'] }, { screenName: 'bottwo', aliases: [] }] },
    });
    expect(names).toEqual(['alice', 'alice', 'bob', 'botone', 'one', 'bottwo']);
  });
});
