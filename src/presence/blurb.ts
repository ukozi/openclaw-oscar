import { copy, type AwayFamily } from '../copy.js';
import { normalizeName } from '../names.js';

const FAMILIES: Record<AwayFamily, readonly string[]> = {
  shell: ['exec', 'bash', 'process', 'code_execution'],
  files: ['read', 'write', 'edit', 'apply_patch'],
  web: ['web_search', 'x_search', 'web_fetch', 'browser'],
  handoff: ['oscar_delegate'],
  memory: [
    'memory_search', 'memory_get', 'sessions_list', 'sessions_history', 'sessions_send',
    'sessions_spawn', 'sessions_yield', 'subagents', 'session_status',
  ],
};

const FAMILY_BY_TOOL = new Map<string, AwayFamily>();
for (const family of Object.keys(FAMILIES) as AwayFamily[]) {
  for (const tool of FAMILIES[family]) FAMILY_BY_TOOL.set(tool, family);
}

export function familyForTool(toolName: string): AwayFamily | null {
  return FAMILY_BY_TOOL.get(toolName.trim().toLowerCase()) ?? null;
}

export function phraseForTool(toolName: string): string | null {
  const family = familyForTool(toolName);
  return family ? copy.awayPhrase(family) : null;
}

const PUNCTUATION: Record<string, string> = {
  '‘': "'", '’': "'", '‚': "'", '′': "'",
  '“': '"', '”': '"', '„': '"', '″': '"',
  '–': '-', '—': '-', '−': '-', '…': '...', '•': '-',
};

export function foldAscii(text: string): string {
  return text
    .replace(/[‘’‚′“”„″–—−…•]/g, (ch) => PUNCTUATION[ch] ?? '')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/\s+/g, ' ')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/ {2,}/g, ' ')
    .trim();
}

export function capText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  let cut = text.slice(0, Math.max(0, maxLength));
  const space = cut.lastIndexOf(' ');
  if (space >= Math.floor(maxLength * 0.6)) cut = cut.slice(0, space);
  return cut.replace(/[\s,;:-]+$/, '');
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function stripTags(text: string): string {
  return text
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, (_m, name: string) => ENTITIES[name.toLowerCase()] ?? ' ')
    .replace(/&#\d+;/g, ' ');
}

function namesIn(text: string, forbidden: Set<string>): boolean {
  if (forbidden.size === 0) return false;
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  for (let i = 0; i < tokens.length; i += 1) {
    let joined = '';
    for (let j = i; j < tokens.length && j < i + 4; j += 1) {
      joined += tokens[j];
      if (forbidden.has(joined)) return true;
    }
  }
  return false;
}

export function filterBlurb(text: string, forbiddenNames: string[], maxLength: number): string | null {
  const folded = foldAscii(stripTags(text));
  if (/[/\\~@]/.test(folded) || folded.includes('://') || /\d{5,}/.test(folded)) return null;
  const forbidden = new Set(
    forbiddenNames.map((n) => normalizeName(n).replace(/[^a-z0-9]/g, '')).filter((n) => n.length > 0),
  );
  if (namesIn(folded, forbidden)) return null;
  const plain = folded
    .replace(/&/g, ' and ')
    .replace(/_/g, ' ')
    .replace(/[*`#<>"]/g, '')
    .replace(/ {2,}/g, ' ')
    .trim();
  const capped = capText(plain, maxLength);
  return /[A-Za-z]/.test(capped) ? capped : null;
}

export type NamedPeople = {
  owners: string[];
  allowFrom: string[];
  chain: { roster: { screenName: string; aliases: string[] }[] };
};

export function forbiddenNames(policy: NamedPeople): string[] {
  return [
    ...policy.owners,
    ...policy.allowFrom,
    ...policy.chain.roster.flatMap((entry) => [entry.screenName, ...entry.aliases]),
  ];
}
