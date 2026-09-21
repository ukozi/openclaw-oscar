import { ICBM_CHARSET_ASCII, ICBM_CHARSET_LATIN1, ICBM_CHARSET_UNICODE } from './constants.js';

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

// The server's own rule for comparing screen names.
export function normalizeScreenName(raw: string): string {
  return raw.replace(/ /g, '').toLowerCase();
}

export function isAscii(s: string): boolean {
  return /^[\x00-\x7f]*$/.test(s);
}

function decodeUtf16be(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    out += String.fromCharCode(((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0));
  }
  return out;
}

function decodeLatin1(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('latin1');
}

// TOC and web clients label UTF-8 bytes as charset 0, and TOC room text has no
// encoding at all, so "ASCII" means UTF-8 when it parses and Latin-1 when it does not.
function decodeLoose(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return decodeLatin1(bytes);
  }
}

function decodeBytes(bytes: Uint8Array, charset: number | string | undefined): string {
  if (typeof charset === 'number') {
    if (charset === ICBM_CHARSET_UNICODE) return decodeUtf16be(bytes);
    if (charset === ICBM_CHARSET_LATIN1) return decodeLatin1(bytes);
    return decodeLoose(bytes);
  }
  const label = (charset ?? '').trim().toLowerCase();
  if (label === 'unicode-2-0' || label === 'utf-16be' || label === 'utf-16') return decodeUtf16be(bytes);
  if (label === 'iso-8859-1') return decodeLatin1(bytes);
  return decodeLoose(bytes);
}

function decodeEntity(match: string, body: string): string {
  if (body.startsWith('#')) {
    const hex = body[1] === 'x' || body[1] === 'X';
    const cp = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
    if (!Number.isInteger(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '�';
    return String.fromCodePoint(cp);
  }
  return NAMED_ENTITIES[body.toLowerCase()] ?? match;
}

function decodeEntities(s: string): string {
  return s.replace(/&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{2,8});/g, decodeEntity);
}

const ANCHOR_SCHEMES = new Set(['http', 'https', 'ftp', 'mailto', 'aim']);

// The attributes are walked rather than searched for "href", because another attribute's value may
// hold that word and the agent would then be told an address the link does not go to.
function hrefValue(tag: string): string {
  const attribute = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]*)))?/g;
  attribute.lastIndex = /^<\/?[a-zA-Z][a-zA-Z0-9]*/.exec(tag)?.[0].length ?? 1;
  for (let m = attribute.exec(tag); m; m = attribute.exec(tag)) {
    if ((m[1] ?? '').toLowerCase() === 'href') return m[2] ?? m[3] ?? m[4] ?? '';
  }
  return '';
}

// An address reaches an agent as text, so it is read as one opaque token: entities are decoded here
// and never again, and whitespace, control characters and angle brackets are dropped, so it can
// neither open a tag nor start a line of its own. A scheme the outbound side would not write is
// dropped with the address; a bare host like "www.example.net" has no scheme and is kept.
function anchorAddress(tag: string): string {
  const address = decodeEntities(hrefValue(tag)).replace(/[\s<>\u0000-\u001f\u007f-\u009f]+/g, '');
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(address);
  if (scheme && !ANCHOR_SCHEMES.has((scheme[1] ?? '').toLowerCase())) return '';
  return address;
}

// "www.example.net" as the words of <A HREF="http://www.example.net/"> is the address again, not a
// label for it, and so is an address that came back in from a bracket this decoder wrote.
function isAddressItself(words: string, address: string): boolean {
  const bare = (s: string) => s.trim().toLowerCase().replace(/^(?:https?:\/\/|mailto:)/, '').replace(/\/+$/, '');
  return bare(words) !== '' && bare(words) === bare(address);
}

// Tags go before entities: the other order turns a typed "&lt;b&gt;" into a tag and eats it. One
// walk does both, so an anchor's address is decoded once, on its own, and the text around it cannot
// be decoded twice.
export function htmlToText(html: string): string {
  const src = html.replace(/\r\n?/g, '\n');
  let out = '';
  let anchor: { address: string; at: number } | null = null;
  const closeAnchor = (): void => {
    if (!anchor) return;
    const { address, at } = anchor;
    anchor = null;
    const body = out.slice(at);
    const words = body.trim();
    if (address === '' || isAddressItself(words, address)) return;
    // The words are empty: the anchor is its address alone, spacing and all.
    if (words === '') out = `${out.slice(0, at)}${address}`;
    else {
      const trail = /\s*$/.exec(body)?.[0] ?? '';
      out = `${out.slice(0, at)}${body.slice(0, body.length - trail.length)} (${address})${trail}`;
    }
  };
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      out += decodeEntities(src.slice(i));
      break;
    }
    if (!/[a-zA-Z/!?]/.test(src[lt + 1] ?? '')) {
      out += decodeEntities(src.slice(i, lt + 1));
      i = lt + 1;
      continue;
    }
    out += decodeEntities(src.slice(i, lt));
    const end = tagEnd(src, lt);
    if (end < 0) {
      out += decodeEntities(src.slice(lt));
      break;
    }
    const tag = src.slice(lt, end + 1);
    const name = /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)/.exec(tag);
    const closing = name?.[1] === '/';
    const lower = (name?.[2] ?? '').toLowerCase();
    if (lower === 'br' && !closing) out += '\n';
    else if (lower === 'a') {
      closeAnchor();
      if (!closing) anchor = { address: anchorAddress(tag), at: out.length };
    }
    i = end + 1;
  }
  closeAnchor();
  return out;
}

export function fromWireText(bytes: Uint8Array, charset: number | string | undefined): string {
  return htmlToText(decodeBytes(bytes, charset));
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatInline(escaped: string): string {
  return escaped
    .replace(/\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:)[^\s()"<>]+)\)/g, '<A HREF="$2">$1</A>')
    .replace(/\*\*(?!\s)([^\n]+?)(?<!\s)\*\*/g, '<B>$1</B>')
    .replace(/(?<![A-Za-z0-9_])__(?!\s)([^\n]+?)(?<!\s)__(?![A-Za-z0-9_])/g, '<U>$1</U>')
    .replace(/(?<![*\w])\*(?![\s*])([^\n*]+?)(?<![\s*])\*(?![*\w])/g, '<I>$1</I>')
    .replace(/(?<![A-Za-z0-9_])_(?![\s_])([^\n_]+?)(?<![\s_])_(?![A-Za-z0-9_])/g, '<I>$1</I>');
}

export function toWireHtml(markdown: string): string {
  const parts = markdown.replace(/\r\n?/g, '\n').split(/(```[^\n]*\n[\s\S]*?\n```|`[^`\n]+`)/g);
  const html = parts
    .map((part, i) => {
      if (i % 2 === 0) return formatInline(escapeHtml(part));
      if (part.startsWith('```')) return escapeHtml(part.replace(/^```[^\n]*\n/, '').replace(/\n```$/, ''));
      return escapeHtml(part.slice(1, -1));
    })
    .join('');
  return guardRoll(html.split('\n').join('<BR>'));
}

function tagEnd(html: string, from: number): number {
  if (html.startsWith('<!--', from)) {
    const close = html.indexOf('-->', from + 4);
    return close < 0 ? -1 : close + 2;
  }
  const quotes = /[a-zA-Z]/.test(html[from + 1] ?? '');
  let quote = '';
  for (let i = from + 1; i < html.length; i++) {
    const ch = html[i] ?? '';
    if (quote !== '') {
      if (ch === quote) quote = '';
    } else if (quotes && (ch === '"' || ch === "'")) quote = ch;
    else if (ch === '>') return i;
  }
  return -1;
}

// Where the first text token starts for the tokenizer the server uses: tags, comments and <!...>
// declarations are skipped, a "<" that opens none of them is text, and a run of spaces is a token.
function firstTextTokenStart(html: string): number {
  let i = 0;
  while (i < html.length) {
    if (html[i] !== '<' || !/[a-zA-Z\/!?]/.test(html[i + 1] ?? '')) return i;
    const end = tagEnd(html, i);
    if (end < 0) return -1;
    i = end + 1;
  }
  return -1;
}

// The server's tokenizer takes numeric entities with or without the semicolon and any number of digits.
function decodeForRollCheck(token: string): string {
  return token.replace(/&(?:#([0-9]+)|#[xX]([0-9a-fA-F]+)|sol);?/g, (_match, dec?: string, hex?: string) => {
    if (dec === undefined && hex === undefined) return '/';
    const cp = dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex ?? '', 16);
    return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : '�';
  });
}

// The server turns a room message whose first text token is a //roll command into a dice result from
// OnlineHost (foodgroup/chat.go:34,130,195-215). It entity-decodes the token first, so neither &#47;
// nor a tag around the command is a defence. Its pattern is anchored at the start of the token, so
// one space in front of the token is.
export function guardRoll(html: string): string {
  const start = firstTextTokenStart(html);
  if (start < 0) return html;
  const next = html.indexOf('<', start);
  const token = html.slice(start, next < 0 ? html.length : next);
  if (!decodeForRollCheck(token).startsWith('//roll')) return html;
  return `${html.slice(0, start)} ${html.slice(start)}`;
}

export function toAsciiEntities(html: string): string {
  let out = '';
  for (const ch of html) {
    const cp = ch.codePointAt(0) ?? 0xfffd;
    if (cp <= 0x7f) out += ch;
    else if (cp >= 0xd800 && cp <= 0xdfff) out += '&#65533;';
    else out += `&#${cp};`;
  }
  return out;
}

export function encodeImText(html: string): { charset: number; bytes: Uint8Array } {
  if (isAscii(html)) return { charset: ICBM_CHARSET_ASCII, bytes: new Uint8Array(Buffer.from(html, 'latin1')) };
  const bytes = new Uint8Array(html.length * 2);
  for (let i = 0; i < html.length; i++) {
    const unit = html.charCodeAt(i);
    bytes[i * 2] = unit >>> 8;
    bytes[i * 2 + 1] = unit & 0xff;
  }
  return { charset: ICBM_CHARSET_UNICODE, bytes };
}
