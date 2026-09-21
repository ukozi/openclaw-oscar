import type { RootPolicy } from './config.js';
import { normalizeName, normalizeRoom } from './names.js';
import type { RoomRef, Target } from './names.js';

export type Role = 'owner' | 'approved' | 'bot' | 'unlisted';
export type OriginClass = 'owner' | 'approved' | 'bot';

const DIRECTIVE = /(^|\s)\/(elevated|elev|exec)(?=$|\s|:)/gi;

export function roleOf(name: string, policy: RootPolicy): Role {
  const key = normalizeName(name);
  if (!key) return 'unlisted';
  if (policy.owners.includes(key)) return 'owner';
  if (policy.chain.roster.some((entry) => entry.screenName === key)) return 'bot';
  if (policy.allowFrom.includes(key)) return 'approved';
  return 'unlisted';
}

export function isOwner(name: string, policy: RootPolicy): boolean {
  return roleOf(name, policy) === 'owner';
}

export function toolDeny(originator: Role, policy: RootPolicy): string[] {
  return originator === 'owner' ? [] : [...policy.nonOwnerTools.deny];
}

export function outboundProblem(t: Target, policy: RootPolicy, joined: RoomRef[]): string | null {
  if (t.kind === 'room') {
    const name = normalizeRoom(t.room.name);
    const present = joined.some((r) => r.exchange === t.room.exchange && normalizeRoom(r.name) === name);
    return present ? null : `not in room ${name}`;
  }
  const role = roleOf(t.name, policy);
  if (role === 'bot') return `${t.name} is a bot in the chain; agents do not message bots`;
  if (role === 'unlisted' && !policy.outbound.allowUnlisted) return `${t.name} is not in owners or allowFrom`;
  return null;
}

export function neutralizeDirectives(text: string): string {
  return text.replace(DIRECTIVE, '$1∕$2');
}

export function roomRequiresMention(bot: string, policy: RootPolicy): boolean {
  const lead = policy.chain.roster[0]?.screenName;
  return lead !== undefined && lead !== normalizeName(bot);
}
