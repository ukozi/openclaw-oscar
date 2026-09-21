import { createHash } from 'node:crypto';
import type { RootPolicy } from '../config.js';
import { normalizeName } from '../names.js';
import { roleOf } from '../policy.js';
import type { OriginClass } from '../policy.js';
import type { RoomState } from '../runtime.js';
import { addressFor } from './address.js';
import { parseTrailer, stripTrailers, taskOf } from './handoff.js';
import type { Trailer } from './handoff.js';

export const PEER_ELIGIBLE_MS = 5000;
export const SELF_ELIGIBLE_MS = 8000;

export type Asked = Map<string, number>;

export type RouteInput = {
  self: string;
  now: number;
  policy: RootPolicy;
  room: RoomState;
  rosterMismatch: boolean;
  message: { from: string; text: string; whisper: boolean; cookie: bigint };
  asked: Asked;
  openHandoffIds: Set<string>;
  seenHandoffs: Set<string>;
};

export type RouteResult =
  | {
      kind: 'wake';
      why: 'named' | 'lead' | 'floor' | 'invited' | 'handoff' | 'review';
      origin: OriginClass;
      key: string;
      order?: string[];
      handoff?: { delegator: string; trailer: Trailer; task: string };
      result?: { id: string; known: boolean };
    }
  | { kind: 'standby'; position: number; key: string; order: string[] }
  | { kind: 'record'; result?: { id: string; known: boolean } }
  | { kind: 'count' }
  | { kind: 'ignore' };

export function commandKey(from: string, cookie: bigint, text: string): string {
  if (cookie !== 0n) return `${from}:${cookie.toString(16)}`;
  const norm = text.trim().replace(/\s+/g, ' ').toLowerCase();
  return `${from}:t${createHash('sha1').update(norm).digest('hex').slice(0, 8)}`;
}

export function rosterNames(policy: RootPolicy): string[] {
  return policy.chain.roster.map((entry) => normalizeName(entry.screenName));
}

export function eligibleBots(self: string, now: number, policy: RootPolicy, room: RoomState, rosterMismatch: boolean): string[] {
  const roster = rosterNames(policy);
  if (roster.length === 0) return [self];
  const present = roster.filter((name) => {
    if (name === self) return now - room.selfJoinedAt >= SELF_ELIGIBLE_MS;
    if (!room.occupants.has(name)) return false;
    return now - (room.joinSeenAt.get(name) ?? room.selfJoinedAt) >= PEER_ELIGIBLE_MS;
  });
  return rosterMismatch ? [...present].sort() : present;
}

const QUESTION_TAIL = /\?["'\u2019\u201d)\]*_\s]*$/;

export function endsWithQuestion(text: string): boolean {
  return QUESTION_TAIL.test(stripTrailers(text));
}

export function noteRoomLine(asked: Asked, line: { from: string; text: string; at: number }, policy: RootPolicy): void {
  const role = roleOf(line.from, policy);
  if (role === 'unlisted') return;
  for (const [name, at] of asked) if (name !== line.from && at < line.at) asked.delete(name);
  if (role !== 'bot') return;
  const parsed = parseTrailer(line.text);
  if (parsed.trailer || parsed.resultId || !endsWithQuestion(parsed.body)) {
    asked.delete(line.from);
    return;
  }
  asked.set(line.from, line.at);
}

export function floorHolder(asked: Asked, now: number, policy: RootPolicy, eligible: string[]): string | null {
  const window = policy.chain.floorSeconds * 1000;
  const held = [...asked].filter(([name, at]) => now - at < window && eligible.includes(name));
  return held.length === 1 ? (held[0]?.[0] ?? null) : null;
}

export function candidateOrder(
  self: string, now: number, policy: RootPolicy, room: RoomState, rosterMismatch: boolean, asked: Asked,
): string[] {
  const eligible = eligibleBots(self, now, policy, room, rosterMismatch);
  const holder = floorHolder(asked, now, policy, eligible);
  if (!holder) return eligible;
  return [holder, ...eligible.filter((name) => name !== holder)];
}

function routeBot(input: RouteInput): RouteResult {
  const { self, policy, message } = input;
  if (message.whisper) return message.text.startsWith('#oc ') ? { kind: 'ignore' } : { kind: 'record' };
  const roster = rosterNames(policy);
  const myIdx = roster.indexOf(self);
  const fromIdx = roster.indexOf(message.from);
  if (myIdx < 0 || fromIdx < 0) return { kind: 'record' };
  const parsed = parseTrailer(message.text);
  const named = addressFor(
    { text: parsed.body, whisper: false },
    'bot',
    { roster: policy.chain.roster, self, occupants: [...input.room.occupants], people: policy.allowFrom },
  ).bots.includes(self);

  if (parsed.trailer && fromIdx < myIdx && named) {
    const t = parsed.trailer;
    const originatorRole = roleOf(t.originator, policy);
    const fresh = !input.seenHandoffs.has(`${message.from}:${t.id}`);
    if (t.hop >= 1 && t.hop <= policy.chain.maxHops && (originatorRole === 'owner' || originatorRole === 'approved') && fresh) {
      return {
        kind: 'wake', why: 'handoff', origin: 'bot', key: `${message.from}:${t.id}`,
        handoff: { delegator: message.from, trailer: t, task: taskOf(parsed.body) },
      };
    }
    return { kind: 'record' };
  }

  if (parsed.resultId && fromIdx > myIdx) {
    const id = parsed.resultId;
    const known = input.openHandoffIds.has(`${message.from}:${id}`);
    if (known || named || id.startsWith(`${myIdx + 1}-`)) {
      const result = { id, known };
      if (policy.chain.reviewResults) return { kind: 'wake', why: 'review', origin: 'bot', key: `${message.from}:${id}`, result };
      return { kind: 'record', result };
    }
  }
  return { kind: 'record' };
}

export function route(input: RouteInput): RouteResult {
  const { self, now, policy, room, message } = input;
  if (message.from === self || message.from === 'onlinehost') return { kind: 'ignore' };
  const role = roleOf(message.from, policy);
  if (role === 'unlisted') return { kind: 'count' };
  if (role === 'bot') return routeBot(input);

  const origin: OriginClass = role;
  const key = commandKey(message.from, message.cookie, message.text);
  const addressed = addressFor(message, role, {
    roster: policy.chain.roster, self, occupants: [...room.occupants], people: policy.allowFrom,
  });
  if (addressed.bots.length > 0) {
    return addressed.bots.includes(self) ? { kind: 'wake', why: 'named', origin, key } : { kind: 'record' };
  }
  if (addressed.human) return { kind: 'record' };

  const invited = role === 'approved' && room.invitedBy === message.from;
  if (role !== 'owner' && !invited) return { kind: 'record' };

  const order = candidateOrder(self, now, policy, room, input.rosterMismatch, input.asked);
  const position = order.indexOf(self);
  if (position < 0) return { kind: 'record' };
  if (position > 0) return { kind: 'standby', position, key, order };
  const floor = floorHolder(input.asked, now, policy, order) === self;
  return { kind: 'wake', why: floor ? 'floor' : invited ? 'invited' : 'lead', origin, key, order };
}
