import type { RosterEntry } from '../config.js';
import { normalizeName } from '../names.js';
import type { Role } from '../policy.js';

export type Addressed = { bots: string[]; human: boolean };
export type AddressNames = { roster: RosterEntry[]; self: string; occupants: string[]; people: string[] };

type Entry = { bot: string | null };

const TAGS = /<[^>]*>/g;
const JOINER = /^\s*(?:,|&|and\b)\s*/i;
const WORD = /[a-z0-9]/i;

function nameTable(names: AddressNames): Map<string, Entry> {
  const table = new Map<string, Entry>();
  for (const n of [...names.people, ...names.occupants]) {
    const key = normalizeName(n);
    if (key) table.set(key, { bot: null });
  }
  const self = normalizeName(names.self);
  if (self) table.set(self, { bot: self });
  for (const entry of names.roster) {
    const bot = normalizeName(entry.screenName);
    if (!bot) continue;
    table.set(bot, { bot });
    for (const alias of entry.aliases ?? []) {
      const key = normalizeName(alias);
      if (key) table.set(key, { bot });
    }
  }
  return table;
}

function matchAt(s: string, start: number, table: Map<string, Entry>, maxLen: number): { key: string; end: number } | null {
  let i = start;
  while (s[i] === ' ') i++;
  if (s[i] === '@') i++;
  let cand = '';
  let best: { key: string; end: number } | null = null;
  while (i < s.length && cand.length < maxLen) {
    const c = s[i] ?? '';
    if (c === ' ') {
      i++;
      continue;
    }
    if (!WORD.test(c)) break;
    cand += c.toLowerCase();
    i++;
    const next = s[i];
    const possessive = (next === "'" || next === '’') && WORD.test(s[i + 1] ?? '');
    const boundary = next === undefined || (!WORD.test(next) && !possessive);
    if (boundary && table.has(cand)) best = { key: cand, end: i };
  }
  return best;
}

export function address(text: string, names: AddressNames): Addressed {
  const table = nameTable(names);
  let maxLen = 0;
  for (const key of table.keys()) maxLen = Math.max(maxLen, key.length);
  const s = text.replace(TAGS, '').replace(/&nbsp;/gi, ' ');
  const bots: string[] = [];
  let human = false;
  let pos = 0;
  for (;;) {
    const hit = matchAt(s, pos, table, maxLen);
    if (!hit) break;
    const entry = table.get(hit.key);
    if (entry?.bot) {
      if (!bots.includes(entry.bot)) bots.push(entry.bot);
    } else {
      human = true;
    }
    const join = JOINER.exec(s.slice(hit.end));
    if (!join) break;
    const next = hit.end + join[0].length;
    if (!matchAt(s, next, table, maxLen)) break;
    pos = next;
  }
  return { bots, human };
}

export function addressFor(message: { text: string; whisper: boolean }, senderRole: Role, names: AddressNames): Addressed {
  if (message.whisper && senderRole === 'owner') return { bots: [normalizeName(names.self)], human: false };
  return address(message.text, names);
}
