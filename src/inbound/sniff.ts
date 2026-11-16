export type Sniffed = { kind: 'image' | 'pdf' | 'text'; contentType: string } | { kind: 'other' };

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const BMP_HEADER_SIZES = new Set([12, 40, 52, 56, 64, 108, 124]);
const TEXT_TYPES: Record<string, string> = {
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
};

function startsWith(bytes: Uint8Array, sig: readonly number[] | string, at = 0): boolean {
  const want = typeof sig === 'string' ? [...sig].map((c) => c.charCodeAt(0)) : sig;
  if (bytes.length < at + want.length) return false;
  return want.every((b, i) => bytes[at + i] === b);
}

function isBmp(bytes: Uint8Array): boolean {
  if (bytes.length < 26 || !startsWith(bytes, 'BM') || !startsWith(bytes, [0, 0, 0, 0], 6)) return false;
  const header = (bytes[14] ?? 0) | ((bytes[15] ?? 0) << 8) | ((bytes[16] ?? 0) << 16) | ((bytes[17] ?? 0) << 24);
  return BMP_HEADER_SIZES.has(header);
}

function imageType(bytes: Uint8Array): string | undefined {
  if (startsWith(bytes, PNG)) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, 'GIF87a') || startsWith(bytes, 'GIF89a')) return 'image/gif';
  if (isBmp(bytes)) return 'image/bmp';
  if (startsWith(bytes, 'RIFF') && startsWith(bytes, 'WEBP', 8)) return 'image/webp';
  return undefined;
}

// Tab, line feed, form feed and carriage return are the only control bytes text may hold.
function isText(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  for (const b of bytes) {
    if (b === 0x7f || (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0c && b !== 0x0d)) return false;
  }
  return true;
}

function textType(name: string): string {
  const base = baseName(name);
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
  return TEXT_TYPES[ext] ?? 'text/plain';
}

export function sniff(bytes: Uint8Array, name: string): Sniffed {
  const image = imageType(bytes);
  if (image !== undefined) return { kind: 'image', contentType: image };
  if (startsWith(bytes, '%PDF-')) return { kind: 'pdf', contentType: 'application/pdf' };
  if (isText(bytes)) return { kind: 'text', contentType: textType(name) };
  return { kind: 'other' };
}

export function baseName(name: string): string {
  const last = name.split(/[/\\:\u0001]/).pop() ?? '';
  const clean = Array.from(last.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim())
    .slice(0, 100)
    .join('');
  return clean === '' || clean === '.' || clean === '..' ? 'file' : clean;
}
