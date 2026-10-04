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

const splitWords = (text: string): string[] => text.toLowerCase().split(/[\s,]+/).filter(Boolean);
const startsWith = (words: string[], prefix: string[]): boolean => prefix.every((w, i) => words[i] === w);
const sameWords = (a: string[], b: string[]): boolean => a.length === b.length && startsWith(a, b);

export function parseSetupReply(
  text: string,
  ctx: { rooms: string[]; pending: number; teammates: string[] },
): SetupReply {
  const words = splitWords(text);
  const [first] = words;
  if (first === undefined) return { kind: 'not-setup' };
  const rooms = ctx.rooms
    .map((r) => ({ name: normalizeRoom(r), words: splitWords(r) }))
    .filter((r) => r.words.length > 0)
    .sort((a, b) => b.words.length - a.words.length);
  const named = rooms.find((r) => startsWith(words, r.words) && startsBody(words[r.words.length]));
  if (named) return parseBody(words.slice(named.words.length), named.name, ctx.teammates);
  const leaving = first === 'leave' ? rooms.find((r) => sameWords(words.slice(1), r.words)) : undefined;
  if (leaving) return { kind: 'leave', room: leaving.name };
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
