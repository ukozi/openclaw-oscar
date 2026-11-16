import { describe, expect, it } from 'vitest';
import { baseName, sniff } from '../../../src/inbound/sniff.js';

const bytes = (...parts: (string | number[])[]): Uint8Array =>
  Uint8Array.from(parts.flatMap((p) => (typeof p === 'string' ? [...Buffer.from(p, 'latin1')] : p)));
const text = (s: string): Uint8Array => new TextEncoder().encode(s);
const bmp = (): Uint8Array => {
  const b = new Uint8Array(58);
  b.set([0x42, 0x4d, 58, 0, 0, 0, 0, 0, 0, 0, 54, 0, 0, 0, 40, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 24, 0]);
  return b;
};

describe('sniff', () => {
  it('reads PNG, JPEG, GIF, BMP and WebP from their signatures', () => {
    const png = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13], 'IHDR');
    const jpeg = bytes([0xff, 0xd8, 0xff, 0xe0, 0, 16], 'JFIF', [0]);
    const gif87 = bytes('GIF87a', [1, 0, 1, 0, 0x80, 0, 0]);
    const gif89 = bytes('GIF89a', [1, 0, 1, 0, 0x80, 0, 0]);
    const webp = bytes('RIFF', [26, 0, 0, 0], 'WEBPVP8 ', [0, 0, 0, 0]);
    expect(sniff(png, 'a.png')).toEqual({ kind: 'image', contentType: 'image/png' });
    expect(sniff(jpeg, 'a.jpg')).toEqual({ kind: 'image', contentType: 'image/jpeg' });
    expect(sniff(gif87, 'a.gif')).toEqual({ kind: 'image', contentType: 'image/gif' });
    expect(sniff(gif89, 'a.gif')).toEqual({ kind: 'image', contentType: 'image/gif' });
    expect(sniff(bmp(), 'a.bmp')).toEqual({ kind: 'image', contentType: 'image/bmp' });
    expect(sniff(webp, 'a.webp')).toEqual({ kind: 'image', contentType: 'image/webp' });
  });

  it('reads text that only starts like a BMP as text', () => {
    expect(sniff(text('BMW parts list\n'), 'cars')).toEqual({ kind: 'text', contentType: 'text/plain' });
    expect(sniff(text('RIFF notes, not WEBP\n'), 'riff')).toEqual({ kind: 'text', contentType: 'text/plain' });
  });

  it('reads a PDF from its header', () => {
    const pdf = bytes('%PDF-1.7\n', [0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a], '1 0 obj\n', [0], '%%EOF\n');
    expect(sniff(pdf, 'report.pdf')).toEqual({ kind: 'pdf', contentType: 'application/pdf' });
    expect(sniff(pdf, 'report')).toEqual({ kind: 'pdf', contentType: 'application/pdf' });
  });

  it('reads Markdown as text whatever the extension', () => {
    const md = text('# Plan\n\n- [ ] first\n- [x] second\n\n```ts\nconst a = 1;\n```\n');
    for (const name of ['plan.md', 'plan.MD', 'plan.markdown', 'plan.txt', 'plan.doc', 'plan.exe', 'plan']) {
      expect(sniff(md, name).kind).toBe('text');
    }
  });

  it('accepts text named .md, .markdown, .txt, .text, .log, .csv and .json, and text with no extension', () => {
    const body = text('line one\r\nline two\tand a tab\fpage\n');
    for (const name of ['a.md', 'a.markdown', 'a.txt', 'a.text', 'a.log', 'a.csv', 'a.json', 'README', '.profile', 'a.']) {
      expect(sniff(body, name).kind).toBe('text');
    }
  });

  it('gives text/markdown, text/csv and application/json from the extension, and text/plain otherwise', () => {
    const body = text('a,b\n1,2\n');
    expect(sniff(body, 'notes.md')).toEqual({ kind: 'text', contentType: 'text/markdown' });
    expect(sniff(body, 'notes.Markdown')).toEqual({ kind: 'text', contentType: 'text/markdown' });
    expect(sniff(body, 'table.csv')).toEqual({ kind: 'text', contentType: 'text/csv' });
    expect(sniff(body, 'data.JSON')).toEqual({ kind: 'text', contentType: 'application/json' });
    expect(sniff(body, 'notes.txt')).toEqual({ kind: 'text', contentType: 'text/plain' });
    expect(sniff(body, 'server.log')).toEqual({ kind: 'text', contentType: 'text/plain' });
    expect(sniff(body, 'README')).toEqual({ kind: 'text', contentType: 'text/plain' });
    expect(sniff(body, 'docs/notes.md.txt')).toEqual({ kind: 'text', contentType: 'text/plain' });
    expect(sniff(body, 'md')).toEqual({ kind: 'text', contentType: 'text/plain' });
  });

  it('accepts text with bytes above 0x7f', () => {
    expect(sniff(text('Café, naïve, 日本語, 🙂\n'), 'utf8.txt').kind).toBe('text');
    expect(sniff(bytes('Caf', [0xe9], ' na', [0xef], 've\r'), 'mac.txt').kind).toBe('text');
    expect(sniff(bytes('quote ', [0x93, 0x94, 0x80], '\r\n'), 'windows.txt').kind).toBe('text');
  });

  it('refuses a binary file named notes.txt', () => {
    expect(sniff(bytes([0x7f], 'ELF', [2, 1, 1, 0, 0, 0]), 'notes.txt')).toEqual({ kind: 'other' });
    expect(sniff(bytes('PK', [3, 4, 20, 0, 0, 0]), 'notes.txt')).toEqual({ kind: 'other' });
    expect(sniff(bytes('MZ', [0x90, 0, 3, 0]), 'notes.md')).toEqual({ kind: 'other' });
    expect(sniff(bytes('plain text', [0], 'more'), 'notes.txt')).toEqual({ kind: 'other' });
    expect(sniff(bytes('colour ', [0x1b], '[31mred'), 'notes.log')).toEqual({ kind: 'other' });
    expect(sniff(bytes('rub out', [0x7f]), 'notes.txt')).toEqual({ kind: 'other' });
  });

  it('refuses an empty file', () => {
    expect(sniff(new Uint8Array(0), 'empty.txt')).toEqual({ kind: 'other' });
    expect(sniff(new Uint8Array(0), 'empty.png')).toEqual({ kind: 'other' });
  });

  it('reads an image named report.txt as an image', () => {
    const png = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13], 'IHDR');
    expect(sniff(png, 'report.txt')).toEqual({ kind: 'image', contentType: 'image/png' });
    expect(sniff(bytes([0xff, 0xd8, 0xff, 0xdb]), 'report.md')).toEqual({ kind: 'image', contentType: 'image/jpeg' });
  });

  it('refuses a truncated signature', () => {
    expect(sniff(bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a]), 'a.png')).toEqual({ kind: 'other' });
    expect(sniff(bytes('RIFF', [4, 0, 0, 0], 'WAVE'), 'a.webp')).toEqual({ kind: 'other' });
    expect(sniff(bmp().slice(0, 20), 'a.bmp')).toEqual({ kind: 'other' });
  });
});

describe('baseName', () => {
  it('keeps only the last part of a name with folders or separators', () => {
    expect(baseName('docs/plan.md')).toBe('plan.md');
    expect(baseName('C:\\Users\\bob\\plan.md')).toBe('plan.md');
    expect(baseName('Macintosh HD:Documents:plan.md')).toBe('plan.md');
    expect(baseName('folder\u0001sub\u0001plan.md')).toBe('plan.md');
    expect(baseName('../../etc/passwd')).toBe('passwd');
    expect(baseName('plan.md')).toBe('plan.md');
  });

  it('removes control bytes', () => {
    expect(baseName('pl\u0000an\r\n.md')).toBe('plan.md');
    expect(baseName('pl\u001b[31man.md')).toBe('pl[31man.md');
    expect(baseName('a\u007fb\u0085c.txt')).toBe('abc.txt');
  });

  it('keeps at most 100 characters', () => {
    expect(baseName('a'.repeat(300))).toBe('a'.repeat(100));
    expect(Array.from(baseName('🙂'.repeat(150)))).toHaveLength(100);
    expect(baseName('x' + '🙂'.repeat(150)).endsWith('\ud83d')).toBe(false);
  });

  it('gives file when nothing is left', () => {
    expect(baseName('')).toBe('file');
    expect(baseName('docs/')).toBe('file');
    expect(baseName('\u0000\u0001')).toBe('file');
    expect(baseName('  ')).toBe('file');
    expect(baseName('..')).toBe('file');
    expect(baseName('a/.')).toBe('file');
  });
});
