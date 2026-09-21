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

export type ToolPolicy = { allow?: string[]; alsoAllow?: string[]; deny?: string[] };

const TYPED_SENDER_KEY = /^(channel|id|e164|username|name):(.*)$/i;

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined;
}

function asToolPolicy(value: unknown): ToolPolicy | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const out: ToolPolicy = {};
  const allow = stringList(raw.allow);
  const alsoAllow = stringList(raw.alsoAllow);
  const deny = stringList(raw.deny);
  if (allow) out.allow = allow;
  if (alsoAllow) out.alsoAllow = alsoAllow;
  if (deny) out.deny = deny;
  return out;
}

function senderKeyRank(rawKey: string): { rank: number; subject: string } | null {
  const typed = TYPED_SENDER_KEY.exec(rawKey);
  if (!typed) return { rank: 1, subject: rawKey };
  const type = (typed[1] ?? '').toLowerCase();
  const rest = typed[2] ?? '';
  if (type === 'id') return { rank: 1, subject: rest };
  if (type === 'username') return { rank: 2, subject: rest };
  if (type === 'name') return { rank: 3, subject: rest };
  if (type !== 'channel') return null;
  const cut = rest.indexOf(':');
  if (cut <= 0 || rest.slice(0, cut).trim().toLowerCase() !== 'oscar') return null;
  return { rank: 0, subject: rest.slice(cut + 1) };
}

export function toolsBySenderEntry(map: Record<string, unknown> | undefined, sender: string): ToolPolicy | undefined {
  if (!map) return undefined;
  const who = normalizeName(sender);
  let best: { rank: number; policy: ToolPolicy } | undefined;
  let wildcard: ToolPolicy | undefined;
  for (const [rawKey, value] of Object.entries(map)) {
    const policy = asToolPolicy(value);
    if (!policy) continue;
    const key = rawKey.trim();
    if (key === '*') {
      wildcard ??= policy;
      continue;
    }
    const parsed = senderKeyRank(key);
    if (!parsed || normalizeName(parsed.subject.trim().replace(/^@/, '')) !== who) continue;
    if (!best || parsed.rank < best.rank) best = { rank: parsed.rank, policy };
  }
  return best?.policy ?? wildcard;
}

export function senderToolPolicy(sender: string, policy: RootPolicy, roomName: string | null): ToolPolicy | undefined {
  const who = normalizeName(sender);
  const role = roleOf(who, policy);
  const entry =
    roomName === null ? undefined : toolsBySenderEntry(policy.rooms[normalizeRoom(roomName)]?.toolsBySender, who);
  const builtin = role === 'owner' || role === 'bot' ? [] : policy.nonOwnerTools.deny;
  const deny = [...builtin, ...(entry?.deny ?? []).filter((tool) => !builtin.includes(tool))];
  const out: ToolPolicy = {};
  if (entry?.allow?.length) out.allow = entry.allow;
  if (entry?.alsoAllow?.length) out.alsoAllow = entry.alsoAllow;
  if (deny.length > 0) out.deny = deny;
  return Object.keys(out).length > 0 ? out : undefined;
}

export type TurnOrigin = { originator: string; delegator?: string };

function union(a: string[] | undefined, b: string[] | undefined): string[] {
  return [...new Set([...(a ?? []), ...(b ?? [])])];
}

export function intersectToolPolicy(
  a: ToolPolicy | undefined,
  b: ToolPolicy | undefined,
): ToolPolicy | undefined {
  if (!a) return b;
  if (!b) return a;
  const out: ToolPolicy = {};
  let deny = union(a.deny, b.deny);
  if (a.allow && b.allow) {
    const both = a.allow.filter((entry) => b.allow?.includes(entry));
    if (both.length > 0) {
      out.allow = both;
    } else {
      out.allow = [...a.allow];
      deny = union(deny, a.allow);
    }
  } else if (a.allow ?? b.allow) {
    out.allow = [...(a.allow ?? b.allow ?? [])];
  }
  const also = (a.alsoAllow ?? []).filter((entry) => b.alsoAllow?.includes(entry));
  if (also.length > 0) out.alsoAllow = also;
  if (deny.length > 0) out.deny = deny;
  return Object.keys(out).length > 0 ? out : undefined;
}

export function handoffToolPolicy(origin: TurnOrigin, policy: RootPolicy, roomName: string | null): ToolPolicy | undefined {
  const forOriginator = senderToolPolicy(origin.originator, policy, roomName);
  if (!origin.delegator) return forOriginator;
  return intersectToolPolicy(senderToolPolicy(origin.delegator, policy, roomName), forOriginator);
}
