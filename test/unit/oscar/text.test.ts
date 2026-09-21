import { describe, expect, it } from 'vitest';
import {
  encodeImText,
  fromWireText,
  guardRoll,
  htmlToText,
  isAscii,
  normalizeScreenName,
  toAsciiEntities,
  toWireHtml,
} from '../../../src/oscar/text.js';

const utf8 = (s: string) => new Uint8Array(Buffer.from(s, 'utf8'));
const latin1 = (s: string) => new Uint8Array(Buffer.from(s, 'latin1'));
const utf16be = (s: string) => {
  const b = Buffer.from(s, 'utf16le');
  b.swap16();
  return new Uint8Array(b);
};

describe('fromWireText', () => {
  const rows: [string, Uint8Array, number | string | undefined, string][] = [
    ['plain ascii', utf8('hello'), 0, 'hello'],
    [
      'classic client wrapper',
      utf8('<HTML><BODY BGCOLOR="#ffffff"><FONT FACE="Arial" SIZE=2 COLOR="#000000">hello<BR>world</FONT></BODY></HTML>'),
      0,
      'hello\nworld',
    ],
    ['bold, italic and a link', utf8('<B>hi</B> <I>there</I> <A HREF="http://example.net/">link</A>'), 0, 'hi there link'],
    ['self-closing and lower-case br', utf8('a<br/>b<br />c<Br>d'), 0, 'a\nb\nc\nd'],
    ['typed comparison survives', utf8('if a &lt; b and c &gt; d'), 0, 'if a < b and c > d'],
    ['typed tag survives as text', utf8('use &lt;b&gt; for bold'), 0, 'use <b> for bold'],
    ['raw less-than with a space is not a tag', utf8('a < b and c > d'), 0, 'a < b and c > d'],
    ['double-escaped entity decodes once', utf8('&amp;lt;'), 0, '&lt;'],
    ['named entities', utf8('&quot;x&quot; &amp; &apos;y&apos;&nbsp;z'), 0, '"x" & \'y\' z'],
    ['numeric entities', utf8('&#233;&#xE9;&#128512;'), 0, 'éé😀'],
    ['bad numeric entity', utf8('&#0;&#1114112;&#xD800;'), 0, '���'],
    ['unknown entity is left alone', utf8('AT&T; &bogus; &'), 0, 'AT&T; &bogus; &'],
    ['html comment', utf8('a<!-- hidden -->b'), 0, 'ab'],
    ['charset 0 holding utf-8', utf8('café — ok'), 0, 'café — ok'],
    ['charset 0 holding latin-1', latin1('café'), 0, 'café'],
    ['charset 3', latin1('naïve'), 3, 'naïve'],
    ['charset 2', utf16be('héllo'), 2, 'héllo'],
    ['charset 2 surrogate pair', utf16be('ok 😀'), 2, 'ok 😀'],
    ['charset 2 odd trailing byte', new Uint8Array([0x00, 0x68, 0x00]), 2, 'h'],
    ['room us-ascii', utf8('hi'), 'us-ascii', 'hi'],
    ['room iso-8859-1', latin1('über'), 'ISO-8859-1', 'über'],
    ['room unicode-2-0', utf16be('über'), 'unicode-2-0', 'über'],
    ['room utf-8', utf8('über'), 'utf-8', 'über'],
    ['room with no encoding, utf-8 bytes', utf8('über'), undefined, 'über'],
    ['room with no encoding, latin-1 bytes', latin1('über'), undefined, 'über'],
    ['crlf', utf8('a\r\nb\rc'), 0, 'a\nb\nc'],
    ['empty', new Uint8Array(0), 0, ''],
  ];
  it.each(rows)('%s', (_name, bytes, charset, want) => {
    expect(fromWireText(bytes, charset)).toBe(want);
  });

  it('strips tags in one pass without looping', () => {
    expect(htmlToText('<<b>i>x')).toBe('<i>x');
  });
});

describe('toWireHtml', () => {
  const rows: [string, string, string][] = [
    ['plain', 'hello', 'hello'],
    ['escapes html', 'a < b & c > "d"', 'a &lt; b &amp; c &gt; &quot;d&quot;'],
    ['escapes a typed tag', '<script>x</script>', '&lt;script&gt;x&lt;/script&gt;'],
    ['bold', 'a **bold** word', 'a <B>bold</B> word'],
    ['italic star', 'an *italic* word', 'an <I>italic</I> word'],
    ['italic underscore', 'an _italic_ word', 'an <I>italic</I> word'],
    ['underline', 'an __underlined__ word', 'an <U>underlined</U> word'],
    ['snake case is left alone', 'call my_func_name now', 'call my_func_name now'],
    ['arithmetic is left alone', '2 * 3 * 4', '2 * 3 * 4'],
    ['link', 'see [the docs](https://example.net/a?b=1&c=2)', 'see <A HREF="https://example.net/a?b=1&amp;c=2">the docs</A>'],
    ['javascript link stays text', '[x](javascript:alert(1))', '[x](javascript:alert(1))'],
    ['newlines', 'a\nb\r\nc', 'a<BR>b<BR>c'],
    ['inline code is literal', 'run `a **b** <c>` now', 'run a **b** &lt;c&gt; now'],
    ['fenced code is literal', 'x\n```ts\nconst a = *p*;\n```\ny', 'x<BR>const a = *p*;<BR>y'],
    ['roll at the start', '//roll', ' //roll'],
    ['roll with arguments at the start', '//roll-dice4-sides8', ' //roll-dice4-sides8'],
    ['roll on a later line is left alone', 'ok\n//roll-dice4-sides8', 'ok<BR>//roll-dice4-sides8'],
    ['roll after a blank first line', '\n//roll', '<BR> //roll'],
    ['roll inside bold', '**//roll**', '<B> //roll</B>'],
    ['roll as link text', '[//roll](https://example.net/)', '<A HREF="https://example.net/"> //roll</A>'],
    ['roll that already has its space', ' //roll', ' //roll'],
    ['roll inside a line is left alone', 'type //roll to play', 'type //roll to play'],
    ['a URL that contains //roll is left alone', '[x](https://rolls.example.net/)', '<A HREF="https://rolls.example.net/">x</A>'],
    ['non-ascii passes through', 'café 😀', 'café 😀'],
    ['empty', '', ''],
  ];
  it.each(rows)('%s', (_name, markdown, want) => {
    expect(toWireHtml(markdown)).toBe(want);
  });

  it('round-trips through fromWireText', () => {
    const html = toWireHtml('**a** < b\nc');
    expect(fromWireText(new Uint8Array(Buffer.from(html, 'utf8')), 0)).toBe('a < b\nc');
    expect(htmlToText(toWireHtml('//roll'))).toBe(' //roll');
  });
});

describe('the dice command', () => {
  // The server's check: the first HTML text token, entity-decoded, against its anchored pattern.
  const SERVER_ROLL = /^\/\/roll(?:-(dice|sides)([0-9]{1,3}))?(?:-(dice|sides)([0-9]{1,3}))?\s*$/;
  const FIRST_TOKEN = /^(?:<!--[\s\S]*?-->|<[a-zA-Z\/!?][^>]*>)*((?:[^<]|<(?![a-zA-Z\/!?]))*)/;
  const serverSeesRoll = (html: string): boolean => SERVER_ROLL.test(htmlToText(FIRST_TOKEN.exec(html)?.[1] ?? ''));

  it('is what the server sees in the bare, wrapped and entity forms', () => {
    for (const html of ['//roll', '//roll-dice4-sides8 ', '<B>//roll</B>', '&#47;/roll', '&#x2F;&#47;roll', '<B></B>//roll', '//roll<BR>more']) {
      expect(serverSeesRoll(html), html).toBe(true);
    }
    for (const html of ['ok<BR>//roll', ' //roll', '<B> //roll</B>', ' &#47;/roll', 'type //roll to play', '//roll now']) {
      expect(serverSeesRoll(html), html).toBe(false);
    }
  });

  const rows = ['//roll', '//roll-dice4', '//roll-sides8-dice2 ', '**//roll**', '_//roll-sides8_', '__//roll__', '`//roll`', '[//roll](https://example.net/)', '\n//roll', '//roll\nand more'];
  it.each(rows)('is never what the server sees in %j', (markdown) => {
    expect(serverSeesRoll(toWireHtml(markdown))).toBe(false);
  });
});

describe('guardRoll', () => {
  const rows: [string, string, string][] = [
    ['bare', '//roll', ' //roll'],
    ['with arguments', '//roll-dice4-sides8', ' //roll-dice4-sides8'],
    ['inside a tag', '<B>//roll</B>', '<B> //roll</B>'],
    ['inside nested tags', '<A HREF="http://example.net/"><B>//roll</B></A>', '<A HREF="http://example.net/"><B> //roll</B></A>'],
    ['after a tag whose attribute holds a greater-than', '<A HREF="http://example.net/?a>b">//roll</A>', '<A HREF="http://example.net/?a>b"> //roll</A>'],
    ['after an empty tag pair', '<B></B>//roll', '<B></B> //roll'],
    ['after a comment', '<!-- x > y -->//roll', '<!-- x > y --> //roll'],
    ['decimal entity', '&#47;/roll', ' &#47;/roll'],
    ['hex entities', '&#x2F;&#X2f;roll', ' &#x2F;&#X2f;roll'],
    ['entities without semicolons', '&#47&#47roll', ' &#47&#47roll'],
    ['zero-padded entity', '&#0000000047;/roll', ' &#0000000047;/roll'],
    ['named slash', '&sol;&sol;roll', ' &sol;&sol;roll'],
    ['a letter as an entity', '//&#114;oll', ' //&#114;oll'],
    ['anything that starts with it', '//rolling along', ' //rolling along'],
    ['already guarded', ' //roll', ' //roll'],
    ['a later line', 'ok<BR>//roll', 'ok<BR>//roll'],
    ['a whitespace token comes first', '<B> </B>//roll', '<B> </B>//roll'],
    ['inside a line', 'type //roll to play', 'type //roll to play'],
    ['an escaped ampersand is not an entity', '&amp;#47;/roll', '&amp;#47;/roll'],
    ['a less-than that opens no tag is text', '< //roll', '< //roll'],
    ['no text at all', '<BR>', '<BR>'],
    ['an unclosed tag', '<B', '<B'],
    ['empty', '', ''],
  ];
  it.each(rows)('%s', (_name, html, want) => {
    expect(guardRoll(html)).toBe(want);
    expect(guardRoll(want)).toBe(want);
  });
});

describe('toAsciiEntities', () => {
  const rows: [string, string, string][] = [
    ['ascii is untouched', '<B>hi</B> &amp;', '<B>hi</B> &amp;'],
    ['latin', 'café', 'caf&#233;'],
    ['curly quotes and dash', '“ok” — yes', '&#8220;ok&#8221; &#8212; yes'],
    ['surrogate pair becomes one entity', 'go 😀', 'go &#128512;'],
    ['lone high surrogate', 'a\ud83db', 'a&#65533;b'],
    ['lone low surrogate', 'a\ude00b', 'a&#65533;b'],
  ];
  it.each(rows)('%s', (_name, html, want) => {
    const got = toAsciiEntities(html);
    expect(got).toBe(want);
    expect(isAscii(got)).toBe(true);
  });
});

describe('encodeImText', () => {
  it('uses charset 0 for ascii', () => {
    expect(encodeImText('<B>hi</B>')).toEqual({ charset: 0, bytes: utf8('<B>hi</B>') });
  });

  it('uses charset 2 for anything else and keeps surrogate pairs', () => {
    const got = encodeImText('hé 😀');
    expect(got.charset).toBe(2);
    expect(Buffer.from(got.bytes).toString('hex')).toBe('006800e90020d83dde00');
    expect(fromWireText(got.bytes, 2)).toBe('hé 😀');
  });
});

describe('normalizeScreenName', () => {
  const rows: [string, string][] = [
    ['Bot One', 'botone'],
    [' A l i c e ', 'alice'],
    ['BOB', 'bob'],
    ['', ''],
  ];
  it.each(rows)('%j -> %j', (raw, want) => {
    expect(normalizeScreenName(raw)).toBe(want);
  });
});
