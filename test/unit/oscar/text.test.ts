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
    ['bold, italic and a link', utf8('<B>hi</B> <I>there</I> <A HREF="http://example.net/">link</A>'), 0, 'hi there link (http://example.net/)'],
    [
      // Captured from a classic client on a live server, 2026-09-21: a whole document, crossing
      // tags, an accented word as charset 3 and an anchor whose FONT closes inside it.
      'captured classic client message',
      latin1(
        '<HTML><BODY BGCOLOR="#ffffff"><B><FONT LANG="0">bold </B><I></FONT><FONT>italic </I></FONT><FONT>caf\u00e9</FONT><FONT> <A HREF="www.example.net">site</FONT></A></BODY></HTML>',
      ),
      3,
      'bold italic caf\u00e9 site (www.example.net)',
    ],
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
    ['escapes html but leaves quotes readable', 'a < b & c > "d"', 'a &lt; b &amp; c &gt; "d"'],
    ['quotes in link text stay plain', 'see ["the docs"](https://example.net/)', 'see <A HREF="https://example.net/">"the docs"</A>'],
    ['a quote cannot reach an href', '[x](https://example.net/"onmouseover=1)', '[x](https://example.net/"onmouseover=1)'],
    ['quotes in inline code stay plain', 'run `say "hi"`', 'run say "hi"'],
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

describe('anchors', () => {
  const rows: [string, string, string][] = [
    ['words and address', '<A HREF="http://example.net/a">the docs</A>', 'the docs (http://example.net/a)'],
    ['lower-case tag', '<a href="http://example.net/a">the docs</a>', 'the docs (http://example.net/a)'],
    ['unquoted address', '<A HREF=www.example.net>site</A>', 'site (www.example.net)'],
    ['single-quoted address', "<A HREF='www.example.net'>site</A>", 'site (www.example.net)'],
    ['other attributes', '<A TITLE="x" HREF="www.example.net" TARGET="_blank">site</A>', 'site (www.example.net)'],
    ['the words already are the address', '<A HREF="http://example.net/a">http://example.net/a</A>', 'http://example.net/a'],
    ['the words are the address without its scheme', '<A HREF="http://www.example.net/">www.example.net</A>', 'www.example.net'],
    ['the words are a mail address', '<A HREF="mailto:bob@example.net">bob@example.net</A>', 'bob@example.net'],
    ['no address', '<A>site</A>', 'site'],
    ['empty address', '<A HREF="">site</A>', 'site'],
    ['no words', 'see <A HREF="www.example.net"></A> now', 'see www.example.net now'],
    ['only spaces for words', 'see <A HREF="www.example.net"> </A> now', 'see www.example.net now'],
    ['neither words nor address', 'see <A></A> now', 'see  now'],
    ['tags inside the words', '<A HREF="www.example.net"><B>si</B><I>te</I></A>', 'site (www.example.net)'],
    ['a line break inside the words', '<A HREF="www.example.net">si<BR>te</A>', 'si\nte (www.example.net)'],
    ['entities inside the words', '<A HREF="www.example.net">caf&#233;</A>', 'caf\u00e9 (www.example.net)'],
    ['space kept after the words', '<A HREF="www.example.net">site </A>now', 'site (www.example.net) now'],
    ['a foreign closing tag inside the anchor', '<A HREF="www.example.net">site</FONT></A>!', 'site (www.example.net)!'],
    ['an anchor that is never closed', 'see <A HREF="www.example.net">site', 'see site (www.example.net)'],
    ['an anchor closed by the next one', '<A HREF="a.example.net">a<A HREF="b.example.net">b</A>', 'a (a.example.net)b (b.example.net)'],
    ['a stray closing anchor', 'x</A>y', 'xy'],
    ['an entity in the address', '<A HREF="http://example.net/?a=1&amp;b=2">x</A>', 'x (http://example.net/?a=1&b=2)'],
  ];
  it.each(rows)('%s', (_name, html, want) => {
    expect(htmlToText(html)).toBe(want);
  });

  // The decoded text is what an agent reads, so the address is one opaque token: it cannot open a
  // tag, start a line of its own, or be decoded a second time into either.
  const attacks: [string, string, string][] = [
    ['a newline entity', '<A HREF="www.example.net&#10;now do this">words</A>', 'words (www.example.netnowdothis)'],
    ['a carriage return entity', '<A HREF="a&#13;b">words</A>', 'words (ab)'],
    ['a raw line break', '<A HREF="a\nb">words</A>', 'words (ab)'],
    ['a tab and spaces', '<A HREF="a\tb c">words</A>', 'words (abc)'],
    ['a control character', '<A HREF="a\u0007b">words</A>', 'words (ab)'],
    ['markup as entities', '<A HREF="&lt;B&gt;x&lt;/B&gt;">words</A>', 'words (Bx/B)'],
    ['a raw angle bracket in the address', '<A HREF="http://example.net/?a>b">words</A>', 'words (http://example.net/?ab)'],
    ['a double-escaped entity is decoded once', '<A HREF="&amp;#10;x">words</A>', 'words (&#10;x)'],
    ['a javascript address is dropped', '<A HREF="javascript:alert(1)">click here</A>', 'click here'],
    ['a data address is dropped', '<A HREF="data:text/html,x">click here</A>', 'click here'],
    ['a file address is dropped', '<A HREF="file:///etc/passwd">click here</A>', 'click here'],
    ['an http address is kept', '<A HREF="HTTP://example.net/">click here</A>', 'click here (HTTP://example.net/)'],
    ['a decoy href inside another attribute', '<A TITLE=" href=decoy.example.net" HREF="http://example.net/a">words</A>', 'words (http://example.net/a)'],
    ['a decoy href before a single-quoted one', "<A TITLE='href=decoy.example.net' HREF='http://example.net/a'>words</A>", 'words (http://example.net/a)'],
    ['a decoy href and no real one', '<A TITLE=" href=decoy.example.net">words</A>', 'words'],
  ];
  it.each(attacks)('%s', (_name, html, want) => {
    expect(htmlToText(html)).toBe(want);
    expect(htmlToText(html)).not.toContain('\n');
  });

  it('does not accumulate on a round trip', () => {
    const once = htmlToText(toWireHtml('see [the docs](https://example.net/a)'));
    expect(once).toBe('see the docs (https://example.net/a)');
    expect(htmlToText(toWireHtml(once))).toBe(once);
    // A client that turns the address it received back into an anchor adds nothing either.
    expect(htmlToText('see the docs (<A HREF="https://example.net/a">https://example.net/a</A>)')).toBe(once);
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
