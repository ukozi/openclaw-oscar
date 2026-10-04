import type { RoomProfile, RootPolicy, RosterEntry } from '../config.js';
import { normalizeName } from '../names.js';
import { roleOf } from '../policy.js';
import type { Role } from '../policy.js';
import { addressFor } from './address.js';
import { parseTrailer } from './handoff.js';
import { SELF_ELIGIBLE_MS, commandKey, rosterNames } from './route.js';
import type { RouteInput, RouteResult } from './route.js';

export const LOUNGE_BOT_CAP = 4;

export function roomRank(policy: RootPolicy, profile: RoomProfile): string[] {
  if (profile.rank) return [...profile.rank];
  const roster = rosterNames(policy);
  if (roster.length > 0) return roster;
  return policy.teammates.length > 1 ? [...policy.teammates].sort() : [];
}

export function roomPolicy(policy: RootPolicy, profile: RoomProfile): RootPolicy {
  const global = new Map(policy.chain.roster.map((entry) => [normalizeName(entry.screenName), entry] as const));
  const roster: RosterEntry[] = roomRank(policy, profile).map((name) => global.get(name) ?? { screenName: name, role: '', aliases: [] });
  return { ...policy, chain: { ...policy.chain, roster } };
}

export class LoungeCounter {
  private readonly counts = new Map<string, number>();

  note(roomKey: string, role: Role): void {
    if (role === 'owner' || role === 'approved') this.counts.set(roomKey, 0);
    else if (role === 'bot') this.counts.set(roomKey, (this.counts.get(roomKey) ?? 0) + 1);
  }

  allowBot(roomKey: string): boolean {
    return (this.counts.get(roomKey) ?? 0) <= LOUNGE_BOT_CAP;
  }

  clear(roomKey: string): void {
    this.counts.delete(roomKey);
  }
}

function namedBots(input: RouteInput, role: Role): string[] {
  const { self, policy, room, message } = input;
  const text = role === 'bot' ? parseTrailer(message.text).body : message.text;
  return addressFor({ text, whisper: message.whisper }, role, {
    roster: policy.chain.roster, self, occupants: [...room.occupants], people: policy.allowFrom,
  }).bots;
}

export function routeLounge(input: RouteInput, cap: LoungeCounter, roomKey: string): RouteResult {
  const { self, now, policy, room, message } = input;
  if (message.from === self || message.from === 'onlinehost') return { kind: 'ignore' };
  const role = roleOf(message.from, policy);
  if (role === 'unlisted') return { kind: 'count' };
  if (role === 'bot' && message.whisper) return message.text.startsWith('#oc ') ? { kind: 'ignore' } : { kind: 'record' };
  cap.note(roomKey, role);
  const key = commandKey(message.from, message.cookie, message.text);
  const named = namedBots(input, role);
  if (named.length > 0 && !named.includes(self)) return { kind: 'record' };
  if (named.length === 0 && now - room.selfJoinedAt < SELF_ELIGIBLE_MS) return { kind: 'record' };
  if (role === 'bot') return cap.allowBot(roomKey) ? { kind: 'wake', why: 'lounge', origin: 'bot', key } : { kind: 'record' };
  if (named.length === 0 && role === 'approved' && room.invitedBy !== message.from) return { kind: 'record' };
  return { kind: 'wake', why: 'lounge', origin: role, key };
}

export function routeWatch(input: RouteInput): RouteResult {
  const { self, message } = input;
  if (message.from === self || message.from === 'onlinehost') return { kind: 'ignore' };
  const role = roleOf(message.from, input.policy);
  if (role === 'unlisted') return { kind: 'count' };
  if (role === 'bot' && message.whisper) return message.text.startsWith('#oc ') ? { kind: 'ignore' } : { kind: 'record' };
  if (!namedBots(input, role).includes(self)) return { kind: 'record' };
  return { kind: 'wake', why: 'named', origin: role, key: commandKey(message.from, message.cookie, message.text) };
}
