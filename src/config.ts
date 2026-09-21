import { createHash } from 'node:crypto';
import { buildChannelConfigSchema } from 'openclaw/plugin-sdk/channel-config-schema';
import { buildOptionalSecretInputSchema, hasConfiguredSecretInput } from 'openclaw/plugin-sdk/secret-input';
import { z } from 'zod';
import { copy } from './copy.js';
import { isAsciiName, normalizeName, normalizeRoom, roomNameProblem } from './names.js';
import type { RoomRef } from './names.js';

export const CHANNEL_ID = 'oscar';
export const PLUGIN_ID = 'oscar';
export const DEFAULT_ACCOUNT_ID = 'default';
export const ROOM_CHUNK_MAX = 1024;
export const TOOL_NAMES = ['oscar_status', 'oscar_room', 'oscar_delegate'] as const;

const DEFAULT_DENY = ['group:runtime', 'group:fs', 'group:automation', 'group:nodes', 'sessions_spawn'];
const WILDCARD = '*';

export const ROOT_ONLY_KEYS = [
  'owners', 'allowFrom', 'dmPolicy', 'dangerouslyAllowOpenDm', 'contactNotice', 'nonOwnerTools', 'outbound',
  'room', 'invites', 'rooms', 'awareness', 'chain',
] as const;

export const RELOAD_NOOP_PREFIXES = [
  'owners', 'allowFrom', 'dmPolicy', 'dangerouslyAllowOpenDm', 'contactNotice', 'nonOwnerTools', 'outbound',
  'room.historyFrom', 'room.notifyOnUnlistedJoin', 'invites', 'rooms',
  'away', 'typing', 'blockStreaming', 'awareness', 'textChunkLimit', 'roomTextChunkLimit',
  'chain.floorSeconds', 'chain.takeoverMs', 'chain.ackAfterMs', 'chain.ackText', 'chain.busyText',
  'chain.maxHops', 'chain.resultTimeoutMinutes', 'chain.reviewResults',
].map((key) => `channels.${CHANNEL_ID}.${key}`);

export const UI_HINTS = {
  host: { label: 'Server host', placeholder: 'oscar.example.net' },
  port: { label: 'Server port', placeholder: '5190' },
  tls: { label: 'Use TLS' },
  screenName: { label: 'Screen name' },
  password: { label: 'Password', sensitive: true },
  passwordFile: { label: 'Password file', help: 'Wins over password when both are set.' },
  owners: { label: 'Owners', help: 'People who command the bot and get notices.' },
  allowFrom: { label: 'Approved people' },
  dangerouslyAllowUnauthenticatedServer: { label: 'Run on a server that does not check passwords', advanced: true },
  dangerouslyAllowOpenDm: { label: 'Allow dmPolicy open', advanced: true },
};

export type AwayConfig = { enabled: boolean; message: string; blurb: 'agent' | 'phrases' | 'summarize'; graceMs: number; maxLength: number };
export type ResolvedAccount = {
  accountId: string; enabled: boolean; configured: boolean;
  screenName: string; display: string;
  host: string; port: number; tls: boolean; caFile?: string; redirect: 'auto' | 'follow' | 'pin';
  password?: unknown; passwordFile?: string;
  dangerouslyAllowUnauthenticatedServer: boolean;
  away: AwayConfig; typing: boolean; blockStreaming?: boolean; textChunkLimit: number; roomTextChunkLimit: number;
};
export type RosterEntry = { screenName: string; role: string; aliases: string[] };
export type ChainConfig = {
  roster: RosterEntry[]; floorSeconds: number; takeoverMs: number; ackAfterMs: number;
  ackText: string; busyText: string; maxHops: number; resultTimeoutMinutes: number; reviewResults: boolean;
};
export type RootPolicy = {
  owners: string[]; allowFrom: string[];
  dmPolicy: 'allowlist' | 'disabled' | 'open';
  contactNotice: { cooldownHours: number; maxPerHour: number };
  nonOwnerTools: { deny: string[] };
  outbound: { allowUnlisted: boolean };
  room?: { ref: RoomRef; historyFrom: 'listed' | 'all'; notifyOnUnlistedJoin: boolean };
  invites: { accept: 'approved' | 'owners' | 'off'; maxRooms: number; leaveWhenAloneMinutes: number };
  rooms: Record<string, { toolsBySender?: Record<string, unknown>; systemPrompt?: string }>;
  awareness: { lines: number };
  chain: ChainConfig;
};

type Obj = Record<string, unknown>;
type Problem = { path: (string | number)[]; message: string };

const obj = (v: unknown): Obj | undefined => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined);
const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
function oneOf<T extends string>(v: unknown, options: readonly T[], fallback: T): T {
  return typeof v === 'string' && (options as readonly string[]).includes(v) ? (v as T) : fallback;
}

// The host bundles its own zod; the cast keeps our types independent of which copy built the secret schema.
const secretInputSchema = buildOptionalSecretInputSchema() as unknown as z.ZodType<unknown>;

const awaySchema = z.object({
  enabled: z.boolean().optional(),
  message: z.string().max(200).optional(),
  blurb: z.enum(['agent', 'phrases', 'summarize']).optional(),
  graceMs: z.number().int().min(0).max(60000).optional(),
  maxLength: z.number().int().min(20).max(200).optional(),
}).strict();

const transportShape = {
  enabled: z.boolean().optional(),
  name: z.string().optional(),
  host: z.string().min(1).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  tls: z.boolean().optional(),
  caFile: z.string().min(1).optional(),
  redirect: z.enum(['auto', 'follow', 'pin']).optional(),
  screenName: z.string().min(1).optional(),
  password: secretInputSchema,
  passwordFile: z.string().min(1).optional(),
  dangerouslyAllowUnauthenticatedServer: z.boolean().optional(),
  away: awaySchema.optional(),
  typing: z.boolean().optional(),
  blockStreaming: z.boolean().optional(),
  textChunkLimit: z.number().int().min(200).max(4000).optional(),
  roomTextChunkLimit: z.number().int().min(100).max(2000).optional(),
};

const names = z.array(z.string().min(1));
const toolPolicy = z.object({ allow: z.array(z.string()).optional(), alsoAllow: z.array(z.string()).optional(), deny: z.array(z.string()).optional() }).strict();

const rootShape = {
  ...transportShape,
  owners: names.optional(),
  allowFrom: names.optional(),
  dmPolicy: z.enum(['allowlist', 'disabled', 'open']).optional(),
  dangerouslyAllowOpenDm: z.boolean().optional(),
  contactNotice: z.object({ cooldownHours: z.number().min(0).max(720).optional(), maxPerHour: z.number().int().min(1).max(60).optional() }).strict().optional(),
  nonOwnerTools: z.object({ deny: z.array(z.string()).optional() }).strict().optional(),
  outbound: z.object({ allowUnlisted: z.boolean().optional() }).strict().optional(),
  room: z.object({
    name: z.string().min(1),
    exchange: z.union([z.literal(4), z.literal(5)]).optional(),
    historyFrom: z.enum(['listed', 'all']).optional(),
    notifyOnUnlistedJoin: z.boolean().optional(),
  }).strict().optional(),
  invites: z.object({
    accept: z.enum(['approved', 'owners', 'off']).optional(),
    maxRooms: z.number().int().min(0).max(20).optional(),
    leaveWhenAloneMinutes: z.number().min(0).max(1440).optional(),
  }).strict().optional(),
  rooms: z.record(z.string(), z.object({ toolsBySender: z.record(z.string(), toolPolicy).optional(), systemPrompt: z.string().optional() }).strict()).optional(),
  awareness: z.object({ lines: z.number().int().min(0).max(20).optional() }).strict().optional(),
  chain: z.object({
    roster: z.array(z.object({ screenName: z.string().min(1), role: z.string().optional(), aliases: names.optional() }).strict()).optional(),
    floorSeconds: z.number().min(0).max(3600).optional(),
    takeoverMs: z.number().int().min(1000).max(120000).optional(),
    ackAfterMs: z.number().int().min(1000).max(120000).optional(),
    ackText: z.string().max(100).optional(),
    busyText: z.string().max(100).optional(),
    maxHops: z.number().int().min(0).max(5).optional(),
    resultTimeoutMinutes: z.number().min(1).max(1440).optional(),
    reviewResults: z.boolean().optional(),
  }).strict().optional(),
  accounts: z.record(z.string(), z.object(transportShape).strict()).optional(),
  defaultAccount: z.string().optional(),
};

function passwordConfigured(merged: Obj): boolean {
  return Boolean(str(merged.passwordFile)) || hasConfiguredSecretInput(merged.password);
}

function crossFieldProblems(sec: Obj): Problem[] {
  const problems: Problem[] = [];
  const owners = list(sec.owners);
  const approved = list(sec.allowFrom);
  const checkPerson = (key: 'owners' | 'allowFrom') => (v: unknown, i: number): void => {
    if (typeof v !== 'string') return;
    if (!isAsciiName(v)) problems.push({ path: [key, i], message: 'names must be ASCII' });
    else if (normalizeName(v) === WILDCARD) problems.push({ path: [key, i], message: '"*" is not a screen name; list people one by one' });
  };
  owners.forEach(checkPerson('owners'));
  approved.forEach(checkPerson('allowFrom'));
  if (sec.dmPolicy === 'open' && sec.dangerouslyAllowOpenDm !== true) {
    problems.push({ path: ['dangerouslyAllowOpenDm'], message: 'dmPolicy "open" needs dangerouslyAllowOpenDm: true' });
  }
  const room = obj(sec.room);
  if (room && typeof room.name === 'string') {
    const problem = roomNameProblem(room.name);
    if (problem) problems.push({ path: ['room', 'name'], message: problem });
  }

  const people = new Set([...owners, ...approved].filter((v): v is string => typeof v === 'string').map(normalizeName));
  const roster = list(obj(sec.chain)?.roster).map(obj);
  const taken = new Map<string, string>();
  roster.forEach((entry, i) => {
    const name = typeof entry?.screenName === 'string' ? entry.screenName : '';
    const key = normalizeName(name);
    if (!isAsciiName(name)) problems.push({ path: ['chain', 'roster', i, 'screenName'], message: 'names must be ASCII' });
    if (people.has(key)) problems.push({ path: ['chain', 'roster', i, 'screenName'], message: `"${key}" is also in owners or allowFrom; a bot is never on those lists` });
    if (taken.has(key)) problems.push({ path: ['chain', 'roster', i, 'screenName'], message: `"${key}" is already used by ${taken.get(key)}` });
    taken.set(key, `chain.roster.${i}.screenName`);
  });
  roster.forEach((entry, i) => {
    list(entry?.aliases).forEach((alias, j) => {
      if (typeof alias !== 'string') return;
      const key = normalizeName(alias);
      if (!isAsciiName(alias)) problems.push({ path: ['chain', 'roster', i, 'aliases', j], message: 'names must be ASCII' });
      if (people.has(key)) problems.push({ path: ['chain', 'roster', i, 'aliases', j], message: `"${key}" is also in owners or allowFrom` });
      if (taken.has(key)) problems.push({ path: ['chain', 'roster', i, 'aliases', j], message: `"${key}" is already used by ${taken.get(key)}` });
      else taken.set(key, `chain.roster.${i}.aliases.${j}`);
    });
  });

  const accounts = obj(sec.accounts);
  const ids = accounts ? Object.keys(accounts) : [];
  let wouldRun = false;
  const seen = new Map<string, string>();
  const rosterNames = new Set(roster.map((e) => normalizeName(typeof e?.screenName === 'string' ? e.screenName : '')));
  const check = (id: string | null, own: Obj): void => {
    const merged = { ...sec, ...own };
    if (sec.enabled === false || own.enabled === false) return;
    const screenName = typeof merged.screenName === 'string' ? normalizeName(merged.screenName) : '';
    const at = (key: string): (string | number)[] => (id === null ? [key] : ['accounts', id, key]);
    if (!screenName) return;
    wouldRun = true;
    if (typeof merged.screenName === 'string' && !isAsciiName(merged.screenName)) problems.push({ path: at('screenName'), message: 'names must be ASCII' });
    if (id !== null) {
      const other = seen.get(screenName);
      if (other !== undefined) problems.push({ path: at('screenName'), message: `"${screenName}" is also the screen name of account "${other}"` });
      else seen.set(screenName, id);
    }
    if (!passwordConfigured(merged)) problems.push({ path: at('password'), message: 'an enabled account needs password or passwordFile' });
    if (rosterNames.size > 0 && !rosterNames.has(screenName)) problems.push({ path: ['chain', 'roster'], message: `"${screenName}" runs here but is missing from the roster` });
  };
  if (ids.length === 0) check(null, {});
  else for (const id of ids) check(id, obj(accounts?.[id]) ?? {});
  if (wouldRun && nameList(sec.owners).length === 0) {
    problems.push({ path: ['owners'], message: 'list at least one owner; with none, OpenClaw treats every approved person as an owner' });
  }
  return problems;
}

export const OscarConfigSchema: z.ZodType = z.object(rootShape).strict().superRefine((value, ctx) => {
  for (const problem of crossFieldProblems(value as Obj)) ctx.addIssue({ code: 'custom', path: problem.path, message: problem.message });
});

export const oscarChannelConfigSchema = buildChannelConfigSchema(
  OscarConfigSchema as unknown as Parameters<typeof buildChannelConfigSchema>[0],
  { uiHints: UI_HINTS },
) as { schema: Record<string, unknown>; uiHints?: unknown; runtime?: unknown };

export function section(cfg: unknown): Obj | undefined {
  return obj(obj(obj(cfg)?.channels)?.[CHANNEL_ID]);
}

export function listAccountIds(cfg: unknown): string[] {
  const sec = section(cfg);
  if (!sec) return [];
  const ids = Object.keys(obj(sec.accounts) ?? {});
  if (ids.length > 0) return ids;
  return str(sec.screenName) ? [DEFAULT_ACCOUNT_ID] : [];
}

export function defaultAccountId(cfg: unknown): string {
  const ids = listAccountIds(cfg);
  const wanted = str(section(cfg)?.defaultAccount);
  if (wanted && ids.includes(wanted)) return wanted;
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

export function resolveAccount(cfg: unknown, accountId?: string | null): ResolvedAccount {
  const sec = section(cfg) ?? {};
  const id = accountId && accountId.length > 0 ? accountId : defaultAccountId(cfg);
  const own = obj(obj(sec.accounts)?.[id]) ?? {};
  const merged: Obj = { ...sec, ...own };
  const away = { ...obj(sec.away), ...obj(own.away) };
  const display = str(merged.screenName) ?? '';
  const host = str(merged.host) ?? '';
  const caFile = str(merged.caFile);
  const passwordFile = str(merged.passwordFile);
  return {
    accountId: id,
    enabled: sec.enabled !== false && own.enabled !== false,
    configured: Boolean(host && display && passwordConfigured(merged)),
    screenName: normalizeName(display),
    display,
    host,
    port: num(merged.port, 5190),
    tls: bool(merged.tls, false),
    ...(caFile ? { caFile } : {}),
    redirect: oneOf(merged.redirect, ['auto', 'follow', 'pin'] as const, 'auto'),
    password: merged.password,
    ...(passwordFile ? { passwordFile } : {}),
    dangerouslyAllowUnauthenticatedServer: bool(merged.dangerouslyAllowUnauthenticatedServer, false),
    away: {
      enabled: bool(away.enabled, true),
      message: str(away.message) ?? copy.awayDefault(),
      blurb: oneOf(away.blurb, ['agent', 'phrases', 'summarize'] as const, 'agent'),
      graceMs: num(away.graceMs, 2000),
      maxLength: num(away.maxLength, 100),
    },
    typing: bool(merged.typing, true),
    ...(typeof merged.blockStreaming === 'boolean' ? { blockStreaming: merged.blockStreaming } : {}),
    textChunkLimit: num(merged.textChunkLimit, 1800),
    roomTextChunkLimit: Math.min(num(merged.roomTextChunkLimit, 900), ROOM_CHUNK_MAX),
  };
}

function nameList(v: unknown): string[] {
  const out: string[] = [];
  for (const entry of list(v)) {
    if (typeof entry !== 'string' || !isAsciiName(entry)) continue;
    const name = normalizeName(entry);
    // The host's ingress gate and its owner check both read "*" as everyone.
    if (name && name !== WILDCARD && !out.includes(name)) out.push(name);
  }
  return out;
}

export function readPolicy(cfg: unknown): RootPolicy {
  const sec = section(cfg) ?? {};
  const owners = nameList(sec.owners);
  // With no owner the host takes the channel's allowFrom as its owner list, so nobody may be approved.
  const owned = owners.length > 0;
  const allowFrom = [...owners];
  for (const name of owned ? nameList(sec.allowFrom) : []) if (!allowFrom.includes(name)) allowFrom.push(name);
  const wanted = owned ? oneOf(sec.dmPolicy, ['allowlist', 'disabled', 'open'] as const, 'allowlist') : 'disabled';
  const notice = obj(sec.contactNotice) ?? {};
  const invites = obj(sec.invites) ?? {};
  const chain = obj(sec.chain) ?? {};
  const room = obj(sec.room);
  const roomName = room ? normalizeRoom(typeof room.name === 'string' ? room.name : '') : '';
  const deny = obj(sec.nonOwnerTools)?.deny;
  const rooms: RootPolicy['rooms'] = {};
  for (const [key, value] of Object.entries(obj(sec.rooms) ?? {})) {
    const entry = obj(value);
    if (!entry) continue;
    const toolsBySender = obj(entry.toolsBySender);
    const systemPrompt = str(entry.systemPrompt);
    rooms[normalizeRoom(key)] = { ...(toolsBySender ? { toolsBySender } : {}), ...(systemPrompt ? { systemPrompt } : {}) };
  }
  return {
    owners,
    allowFrom,
    dmPolicy: wanted === 'open' && sec.dangerouslyAllowOpenDm !== true ? 'allowlist' : wanted,
    contactNotice: { cooldownHours: num(notice.cooldownHours, 6), maxPerHour: num(notice.maxPerHour, 5) },
    nonOwnerTools: { deny: Array.isArray(deny) ? deny.filter((v): v is string => typeof v === 'string') : [...DEFAULT_DENY] },
    outbound: { allowUnlisted: owned && bool(obj(sec.outbound)?.allowUnlisted, false) },
    ...(roomName
      ? { room: { ref: { exchange: room?.exchange === 5 ? 5 : 4, name: roomName }, historyFrom: oneOf(room?.historyFrom, ['listed', 'all'] as const, 'listed'), notifyOnUnlistedJoin: bool(room?.notifyOnUnlistedJoin, true) } }
      : {}),
    invites: {
      accept: oneOf(invites.accept, ['approved', 'owners', 'off'] as const, 'approved'),
      maxRooms: num(invites.maxRooms, 5),
      leaveWhenAloneMinutes: num(invites.leaveWhenAloneMinutes, 10),
    },
    rooms,
    awareness: { lines: num(obj(sec.awareness)?.lines, 5) },
    chain: {
      roster: list(chain.roster).map(obj).filter((e): e is Obj => Boolean(e && typeof e.screenName === 'string')).map((e) => ({
        screenName: normalizeName(e.screenName as string),
        role: str(e.role) ?? '',
        aliases: nameList(e.aliases),
      })),
      floorSeconds: num(chain.floorSeconds, 120),
      takeoverMs: num(chain.takeoverMs, 10000),
      ackAfterMs: num(chain.ackAfterMs, 8000),
      ackText: copy.ack(typeof chain.ackText === 'string' ? chain.ackText : ''),
      busyText: copy.busy(typeof chain.busyText === 'string' ? chain.busyText : ''),
      maxHops: num(chain.maxHops, 2),
      resultTimeoutMinutes: num(chain.resultTimeoutMinutes, 20),
      reviewResults: bool(chain.reviewResults, false),
    },
  };
}

export function configProblems(cfg: unknown): string[] {
  const sec = section(cfg);
  if (!sec) return [];
  const parsed = OscarConfigSchema.safeParse(sec);
  if (parsed.success) return [];
  const out: string[] = [];
  for (const issue of parsed.error.issues) {
    const base = [`channels.${CHANNEL_ID}`, ...issue.path.map(String)].join('.');
    const keys = (issue as { keys?: unknown }).keys;
    if (issue.code === 'unrecognized_keys' && Array.isArray(keys)) {
      for (const key of keys) {
        const rootOnly = issue.path[0] === 'accounts' && (ROOT_ONLY_KEYS as readonly string[]).includes(String(key));
        out.push(`${base}.${String(key)}: ${rootOnly ? `root-only key, move it to channels.${CHANNEL_ID}.${String(key)}` : 'unknown key'}`);
      }
    } else {
      out.push(`${base}: ${issue.message}`);
    }
  }
  return out;
}

export function rosterHash(chain: ChainConfig): string {
  const material = chain.roster.map((e) => [normalizeName(e.screenName), [...e.aliases].map(normalizeName).sort()]);
  return createHash('sha1').update(JSON.stringify(material)).digest('hex').slice(0, 8);
}

export function buddyList(policy: RootPolicy, self: string): string[] {
  const me = normalizeName(self);
  const out: string[] = [];
  for (const name of [...policy.allowFrom, ...policy.chain.roster.map((e) => e.screenName)]) {
    if (name !== me && !out.includes(name)) out.push(name);
  }
  return out;
}
