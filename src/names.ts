import { normalizeScreenName } from './oscar/index.js';
import type { RoomRef } from './oscar/index.js';
import type { Role } from './policy.js';

export type { RoomRef } from './oscar/index.js';

export type PeerRef =
  | { kind: 'im'; bot: string; peer: string }
  | { kind: 'room'; bot: string; room: RoomRef };

export type Target = { kind: 'im'; name: string } | { kind: 'room'; room: RoomRef };

const CHANNEL_PREFIX = /^oscar:/i;
const SAFE_CHAR = /[a-z0-9_.]/;
const utf8 = new TextEncoder();

export function normalizeName(raw: string): string {
  return normalizeScreenName(raw.trim().replace(CHANNEL_PREFIX, ''));
}

export function isAsciiName(raw: string): boolean {
  return /^[\x20-\x7e]+$/.test(raw);
}

export function normalizeRoom(raw: string): string {
  return raw.trim().toLowerCase();
}

export function roomNameProblem(raw: string): string | null {
  const name = normalizeRoom(raw);
  if (name.length === 0) return 'room name is empty';
  if (name.length > 50) return 'room name is longer than 50 characters';
  for (const ch of ['-', '/', ':']) {
    if (name.includes(ch)) return `room name contains "${ch}"`;
  }
  return null;
}

function encodePart(value: string): string {
  let out = '';
  for (const ch of value) {
    if (SAFE_CHAR.test(ch)) {
      out += ch;
      continue;
    }
    for (const byte of utf8.encode(ch)) out += `%${byte.toString(16).padStart(2, '0')}`;
  }
  return out;
}

function decodePart(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function encodePeerId(ref: PeerRef): string {
  const bot = normalizeName(ref.bot);
  if (ref.kind === 'im') return `${bot}/${encodePart(normalizeName(ref.peer))}`;
  return `${bot}#${ref.room.exchange}.${encodePart(normalizeRoom(ref.room.name))}`;
}

export function decodePeerId(id: string): PeerRef | null {
  const match = /^([^/#]+)([/#])(.*)$/s.exec(id.trim());
  if (!match) return null;
  const bot = normalizeName(match[1] ?? '');
  const sep = match[2];
  const rest = match[3] ?? '';
  if (!bot || !rest) return null;
  if (sep === '/') {
    const peer = decodePart(rest);
    if (!peer) return null;
    return { kind: 'im', bot, peer: normalizeName(peer) };
  }
  const dot = rest.indexOf('.');
  if (dot < 1) return null;
  const exchange = rest.slice(0, dot);
  if (exchange !== '4' && exchange !== '5') return null;
  const name = decodePart(rest.slice(dot + 1));
  if (!name) return null;
  return { kind: 'room', bot, room: { exchange: exchange === '4' ? 4 : 5, name: normalizeRoom(name) } };
}

export function parseTarget(raw: string, bot: string): Target | null {
  const text = raw.trim().replace(CHANNEL_PREFIX, '').trim();
  if (!text) return null;
  if (/^room:/i.test(text)) {
    const rest = text.slice(5);
    const explicit = /^([45]):(.+)$/s.exec(rest);
    const name = normalizeRoom(explicit ? (explicit[2] ?? '') : rest);
    if (!name) return null;
    return { kind: 'room', room: { exchange: explicit?.[1] === '5' ? 5 : 4, name } };
  }
  if (text.includes('/') || text.includes('#')) {
    const ref = decodePeerId(text);
    if (!ref) return null;
    if (bot && ref.bot !== normalizeName(bot)) return null;
    return ref.kind === 'im' ? { kind: 'im', name: ref.peer } : { kind: 'room', room: ref.room };
  }
  if (text.includes(':')) return null;
  const name = normalizeName(text);
  return name ? { kind: 'im', name } : null;
}

export function formatTarget(t: Target): string {
  return t.kind === 'im' ? t.name : `room:${t.room.exchange}:${t.room.name}`;
}

export function escapeNonAscii(s: string): string {
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    out += cp >= 0x20 && cp <= 0x7e ? ch : `\\u{${cp.toString(16)}}`;
  }
  return out;
}

export function senderLabel(name: string, role: Role): string {
  return `${escapeNonAscii(name)} (${role})`;
}
