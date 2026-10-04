import type { RoomMode, RoomTrust } from '../config.js';
import { normalizeName, normalizeRoom } from '../names.js';

export type SetupReply =
  | { kind: 'not-setup' }
  | { kind: 'same'; room?: string }
  | { kind: 'leave'; room?: string }
  | { kind: 'settings'; room?: string; mode?: RoomMode; trust?: RoomTrust; rank?: string[] }
  | { kind: 'error'; word: string };

const MODES: readonly string[] = ['team', 'lounge', 'watch'];
const TRUSTS: readonly string[] = ['private', 'public'];
const ALONE: readonly string[] = ['same', 'leave', 'no'];

const isMode = (w: string): w is RoomMode => MODES.includes(w);
const isTrust = (w: string): w is RoomTrust => TRUSTS.includes(w);
const startsBody = (w: string | undefined): boolean =>
  w !== undefined && (isMode(w) || isTrust(w) || ALONE.includes(w));

export function parseSetupReply(
  text: string,
  ctx: { rooms: string[]; pending: number; teammates: string[] },
): SetupReply {
  const words = text.toLowerCase().split(/[\s,]+/).filter(Boolean);
  const rooms = new Set(ctx.rooms.map(normalizeRoom));
  const [first, second] = words;
  if (first === undefined) return { kind: 'not-setup' };
  if (rooms.has(first) && startsBody(second)) return parseBody(words.slice(1), first, ctx.teammates);
  if (first === 'leave' && second !== undefined && words.length === 2 && rooms.has(second)) {
    return { kind: 'leave', room: second };
  }
  if (ctx.pending === 0) return { kind: 'not-setup' };
  if (isMode(first) || isTrust(first)) return parseBody(words, undefined, ctx.teammates);
  if (words.length === 1 && ALONE.includes(first)) return parseBody(words, undefined, ctx.teammates);
  return { kind: 'not-setup' };
}

function parseBody(words: string[], room: string | undefined, teammates: string[]): SetupReply {
  const at = room === undefined ? {} : { room };
  const [head, ...rest] = words as [string, ...string[]];
  if (ALONE.includes(head)) {
    if (rest[0] !== undefined) return { kind: 'error', word: rest[0] };
    return head === 'same' ? { kind: 'same', ...at } : { kind: 'leave', ...at };
  }
  if (isTrust(head)) {
    if (rest[0] !== undefined) return { kind: 'error', word: rest[0] };
    return { kind: 'settings', ...at, trust: head };
  }
  const mode = head as RoomMode;
  const known = new Set(teammates.map(normalizeName));
  let trust: RoomTrust | undefined;
  const rank: string[] = [];
  for (const word of rest) {
    if (isTrust(word) && trust === undefined && rank.length === 0) {
      trust = word;
      continue;
    }
    const name = normalizeName(word);
    if (mode !== 'team' || !known.has(name) || rank.includes(name)) return { kind: 'error', word };
    rank.push(name);
  }
  return {
    kind: 'settings',
    ...at,
    mode,
    ...(trust ? { trust } : {}),
    ...(rank.length ? { rank } : {}),
  };
}
