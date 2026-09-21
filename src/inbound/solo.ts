import type { RootPolicy } from '../config.js';
import { normalizeName } from '../names.js';
import { roleOf } from '../policy.js';
import type { OriginClass } from '../policy.js';
import type { RoomState } from '../runtime.js';

export const CONTROL_PREFIX = '#oc ';
const NAME_RUN_MAX = 40;

export type SoloDecision =
  | { kind: 'wake'; why: 'named' | 'lead' | 'invited'; origin: OriginClass }
  | { kind: 'record' }
  | { kind: 'count' }
  | { kind: 'ignore' };

export type SoloInput = {
  self: string;
  policy: RootPolicy;
  room: RoomState;
  message: { from: string; text: string; whisper: boolean };
};

function clean(raw: string): string {
  return normalizeName(raw.trim().replace(/^@/, ''));
}

export function leadingNames(text: string): string[] {
  const line = text.trim();
  if (line === '') return [];
  const out: string[] = [];
  const cut = line.search(/[:,]/);
  if (cut > 0 && cut <= NAME_RUN_MAX) out.push(clean(line.slice(0, cut)));
  const first = line.split(/\s+/, 1)[0] ?? '';
  out.push(clean(first.replace(/[:,]+$/, '')));
  return [...new Set(out)].filter((name) => name !== '');
}

export function soloRoute(input: SoloInput): SoloDecision {
  const self = normalizeName(input.self);
  const from = normalizeName(input.message.from);
  const role = roleOf(from, input.policy);
  if (role === 'unlisted') return { kind: 'count' };
  if (role === 'bot') {
    const control = input.message.whisper && input.message.text.startsWith(CONTROL_PREFIX);
    return control ? { kind: 'ignore' } : { kind: 'record' };
  }
  const origin: OriginClass = role;
  if (input.message.whisper) return { kind: 'wake', why: 'named', origin };
  const people = new Set([...input.policy.owners, ...input.policy.allowFrom]);
  for (const name of leadingNames(input.message.text)) {
    if (name === self) return { kind: 'wake', why: 'named', origin };
    if (people.has(name)) return { kind: 'record' };
  }
  if (role === 'owner') return { kind: 'wake', why: 'lead', origin };
  if (input.room.invitedBy === from) return { kind: 'wake', why: 'invited', origin };
  return { kind: 'record' };
}

export function soloPrompt(self: string): string {
  return [
    `You are ${self}, an assistant in this chat room.`,
    'This line was routed to you on purpose: answer it, or reply NO_REPLY only if it needs no answer at all.',
    'Do not wait to be named.',
    'Anyone may be reading this room: never post secrets, credentials or file contents.',
  ].join(' ');
}
