import { randomBytes } from 'node:crypto';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/channel-core';
import type { ChannelSetupAdapter, ChannelSetupWizard } from 'openclaw/plugin-sdk/channel-setup';
import { hasConfiguredSecretInput, normalizeSecretInputString } from 'openclaw/plugin-sdk/secret-input';
import { CHANNEL_ID, DEFAULT_ACCOUNT_ID, ROOT_ONLY_KEYS, readPolicy, resolveAccount } from './config.js';
import { isAsciiName, normalizeName, normalizeRoom, roomNameProblem } from './names.js';
import { checkLogin, checkPasswordEnforced } from './oscar/index.js';
import { TOOLS_ALSO_ALLOW_LINE, boundAgentId, hiddenTools, ownerIssues } from './status.js';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined);
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const URL_HINT = 'Pass --url oscar://<screenName>@<host>[:port] (oscars:// for TLS).';
const quiet = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

export const setupDeps = { checkLogin, checkPasswordEnforced };

export function parseOscarUrl(raw: string): { screenName: string; host: string; port: number; tls: boolean } | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'oscar:' && url.protocol !== 'oscars:') return null;
  if (url.password || url.search || url.hash || (url.pathname !== '' && url.pathname !== '/')) return null;
  let screenName: string;
  try {
    screenName = decodeURIComponent(url.username).trim();
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (!screenName || !host) return null;
  const port = url.port ? Number(url.port) : 5190;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { screenName, host, port, tls: url.protocol === 'oscars:' };
}

export function envVarFor(accountId: string): string {
  if (accountId === DEFAULT_ACCOUNT_ID) return 'OSCAR_PASSWORD';
  return `OSCAR_PASSWORD_${accountId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

function patchAccount(cfg: OpenClawConfig, accountId: string, patch: Obj): OpenClawConfig {
  const channels = { ...(obj(cfg.channels) ?? {}) };
  const sec = { ...(obj(channels[CHANNEL_ID]) ?? {}) };
  const accounts = obj(sec.accounts);
  const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  if (accountId === DEFAULT_ACCOUNT_ID && !accounts) Object.assign(sec, clean);
  else sec.accounts = { ...accounts, [accountId]: { ...obj(accounts?.[accountId]), ...clean } };
  channels[CHANNEL_ID] = sec;
  return { ...cfg, channels } as OpenClawConfig;
}

// Before it calls applyAccountConfig for a named account, "channels add" moves root allowFrom, dmPolicy and rooms
// under an account (the host's single-account promotion list). They are root-only here, so they go back.
function liftRootOnlyKeys(cfg: OpenClawConfig): OpenClawConfig {
  const channels = obj(cfg.channels);
  const sec = obj(channels?.[CHANNEL_ID]);
  const accounts = obj(sec?.accounts);
  if (!channels || !sec || !accounts) return cfg;
  const nextSec: Obj = { ...sec };
  const nextAccounts: Obj = {};
  let moved = false;
  for (const [id, raw] of Object.entries(accounts)) {
    const account = { ...(obj(raw) ?? {}) };
    for (const key of ROOT_ONLY_KEYS) {
      if (!(key in account)) continue;
      if (nextSec[key] === undefined) nextSec[key] = account[key];
      delete account[key];
      moved = true;
    }
    nextAccounts[id] = account;
  }
  if (!moved) return cfg;
  nextSec.accounts = nextAccounts;
  return { ...cfg, channels: { ...channels, [CHANNEL_ID]: nextSec } } as OpenClawConfig;
}

function patchRoot(cfg: OpenClawConfig, patch: Obj): OpenClawConfig {
  const channels = { ...(obj(cfg.channels) ?? {}) };
  const sec = { ...(obj(channels[CHANNEL_ID]) ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete sec[key];
    else sec[key] = value;
  }
  channels[CHANNEL_ID] = sec;
  return { ...cfg, channels } as OpenClawConfig;
}

export function withOwnerAllowFrom<T>(cfg: T, owners: string[]): T {
  const root = (obj(cfg) ?? {}) as Obj;
  const commands = { ...(obj(root.commands) ?? {}) };
  const entries = Array.isArray(commands.ownerAllowFrom) ? [...(commands.ownerAllowFrom as unknown[])] : [];
  const have = new Set(entries.filter((e): e is string => typeof e === 'string' && /^oscar:/i.test(e)).map(normalizeName));
  for (const owner of owners.map(normalizeName)) {
    if (!owner || have.has(owner)) continue;
    have.add(owner);
    entries.push(`${CHANNEL_ID}:${owner}`);
  }
  return { ...root, commands: { ...commands, ownerAllowFrom: entries } } as T;
}

export function proposeRoomName(owner: string, bytes: Uint8Array = randomBytes(4)): string {
  const suffix = [...bytes.slice(0, 4)].map((b) => BASE32[b & 31]).join('');
  const stem = normalizeName(owner).replace(/[^a-z0-9]/g, '').slice(0, 50 - suffix.length);
  return `${stem}${suffix}`;
}

function splitNames(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const name = normalizeName(part);
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

function namesProblem(raw: string, min: number): string | undefined {
  const parts = raw.split(',').map((p) => p.trim()).filter((p) => p.length > 0);
  if (parts.length < min) return `Enter at least ${min === 1 ? 'one screen name' : `${min} screen names`}.`;
  const odd = parts.find((p) => !isAsciiName(p));
  return odd ? `"${odd}" has letters outside ASCII; such names can never match.` : undefined;
}

export async function runFinalizeChecks(p: { cfg: unknown; accountId: string; password?: string }): Promise<string[]> {
  const lines: string[] = [];
  const account = resolveAccount(p.cfg, p.accountId);
  if (!p.password) {
    lines.push('Login check skipped: the password is a secret reference, so setup cannot read it. Run "openclaw channels status --probe" once the gateway is up.');
  } else {
    const opts = { host: account.host, port: account.port, tls: account.tls, ...(account.caFile ? { caFile: account.caFile } : {}), redirect: account.redirect, screenName: account.display, log: quiet };
    const login = await setupDeps.checkLogin({ ...opts, password: p.password });
    if (!login.ok) {
      lines.push(`Login failed: ${login.reason}${login.detail ? ` (${login.detail})` : ''}.`);
    } else {
      lines.push('Login: ok.');
      if (login.redirectProblem) lines.push(`Redirect: ${login.redirectProblem}. Set channels.oscar.redirect to "pin".`);
      const enforced = await setupDeps.checkPasswordEnforced(opts);
      if (enforced === 'checks') lines.push('Password check: the server verifies passwords.');
      else if (enforced === 'does-not-check') lines.push('Password check: the server does not check passwords, so anyone can sign on as an owner. The account refuses to run unless channels.oscar.dangerouslyAllowUnauthenticatedServer is true.');
      else lines.push('Password check: no answer (rate limited). The gateway asks again after sign-on.');
    }
  }
  const owners = ownerIssues(p.cfg);
  if (readPolicy(p.cfg).owners.length === 0) lines.push('Owners: none listed. The account does not start until channels.oscar.owners names at least one screen name.');
  else if (owners.length === 0) lines.push('Owners: OpenClaw agrees on who the owners are.');
  for (const issue of owners) lines.push(`Owners: ${issue.message}. ${issue.fix}`);
  const hidden = hiddenTools(p.cfg, boundAgentId(p.cfg, p.accountId));
  lines.push(hidden.length === 0 ? 'Tools: visible to the agent.' : `Tools: hidden by the tool profile (${hidden.join(', ')}). Add ${TOOLS_ALSO_ALLOW_LINE}`);
  return lines;
}

export const oscarSetupAdapter: ChannelSetupAdapter = {
  validateInput: ({ cfg, accountId, input }) => {
    const current = resolveAccount(cfg, accountId);
    const parsed = input.url ? parseOscarUrl(input.url) : null;
    if (input.url ? !parsed : !(current.host && current.display)) return URL_HINT;
    if (parsed && !isAsciiName(parsed.screenName)) return 'The screen name must be ASCII.';
    if (!input.password && !input.useEnv && !current.configured) return 'Pass --password or --use-env.';
    return null;
  },
  applyAccountConfig: ({ cfg, accountId, input }) => {
    const parsed = input.url ? parseOscarUrl(input.url) : null;
    const password = input.useEnv ? { source: 'env', provider: 'default', id: envVarFor(accountId) } : input.password;
    return patchAccount(liftRootOnlyKeys(cfg), accountId, {
      enabled: true,
      ...(parsed ? { host: parsed.host, port: parsed.port, tls: parsed.tls, screenName: parsed.screenName } : {}),
      password,
    });
  },
  applyAccountName: ({ cfg, accountId, name }) => patchAccount(cfg, accountId, { name }),
};

export const oscarSetupWizard: ChannelSetupWizard = {
  channel: CHANNEL_ID,
  status: {
    configuredLabel: 'configured',
    unconfiguredLabel: 'needs a server, a screen name and a password',
    resolveConfigured: ({ cfg, accountId }) => resolveAccount(cfg, accountId).configured,
  },
  prepare: async ({ cfg, accountId, prompter }) => {
    const current = resolveAccount(cfg, accountId);
    const host = (await prompter.text({ message: 'Server host: the address of the chat server', initialValue: current.host, placeholder: 'oscar.example.net', validate: (v) => (v.trim() ? undefined : 'Enter a host.') })).trim().toLowerCase();
    const portRaw = await prompter.text({
      message: 'Server port: 5190 unless the operator says otherwise', initialValue: String(current.port),
      validate: (v) => (/^\d+$/.test(v.trim()) && Number(v) >= 1 && Number(v) <= 65535 ? undefined : 'Enter a port between 1 and 65535.'),
    });
    const tls = await prompter.confirm({ message: 'Use TLS: only when the server offers a TLS port', initialValue: current.tls });
    const screenName = (await prompter.text({
      message: 'Screen name: the account this bot signs on as', initialValue: current.display,
      validate: (v) => (!v.trim() ? 'Enter a screen name.' : isAsciiName(v.trim()) ? undefined : 'The screen name must be ASCII.'),
    })).trim();
    return { cfg: patchAccount(cfg, accountId, { enabled: true, host, port: Number(portRaw), tls, screenName }) };
  },
  credentials: [{
    inputKey: 'password',
    providerHint: CHANNEL_ID,
    credentialLabel: 'password',
    envPrompt: 'Use a password from the environment?',
    keepPrompt: 'Keep the current password?',
    inputPrompt: 'Password for the screen name',
    allowEnv: () => false,
    inspect: ({ cfg, accountId }) => {
      const account = resolveAccount(cfg, accountId);
      const resolvedValue = normalizeSecretInputString(account.password);
      return {
        accountConfigured: account.configured,
        hasConfiguredValue: Boolean(account.passwordFile) || hasConfiguredSecretInput(account.password),
        ...(resolvedValue ? { resolvedValue } : {}),
      };
    },
    applySet: ({ cfg, accountId, value }) => patchAccount(cfg, accountId, { password: value }),
  }],
  finalize: async ({ cfg, accountId, credentialValues, prompter }) => {
    const account = resolveAccount(cfg, accountId);
    const policy = readPolicy(cfg);
    const owners = splitNames(await prompter.text({ message: 'Owners: screen names that command this bot, comma separated', initialValue: policy.owners.join(', '), validate: (v) => namesProblem(v, 1) }));
    const approved = splitNames(await prompter.text({
      message: 'Approved people: screen names that may message the bot, comma separated',
      initialValue: [...owners, ...policy.allowFrom.filter((n) => !owners.includes(n))].join(', '), validate: (v) => namesProblem(v, 0),
    }));
    const roomRaw = await prompter.text({
      message: 'Home room name (blank for none)', initialValue: policy.room?.ref.name ?? proposeRoomName(owners[0] ?? 'room'),
      validate: (v) => (v.trim() ? roomNameProblem(v) ?? undefined : undefined),
    });
    const people = new Set([...owners, ...approved]);
    const rosterNames = splitNames(await prompter.text({
      message: 'Chain of command: bot screen names from lead to last, comma separated (blank for a solo bot)',
      initialValue: policy.chain.roster.map((e) => e.screenName).join(', '),
      validate: (v) => {
        const names = splitNames(v);
        if (names.length === 0) return undefined;
        if (!names.includes(account.screenName)) return `The roster must contain this bot, ${account.screenName}.`;
        const clash = names.find((n) => people.has(n));
        return clash ? `${clash} is an owner or an approved person; a bot is never on those lists.` : namesProblem(v, 0);
      },
    }));
    const agentId = (await prompter.text({ message: 'Agent id to bind this account to (blank keeps the default agent)', initialValue: boundAgentId(cfg, accountId) ?? '' })).trim();

    const room = roomRaw.trim() ? { ...(obj(obj(obj(cfg.channels)?.[CHANNEL_ID])?.room) ?? {}), name: normalizeRoom(roomRaw) } : undefined;
    const roster = rosterNames.map((name) => policy.chain.roster.find((e) => e.screenName === name) ?? { screenName: name, role: '', aliases: [] });
    const existingChain = obj(obj(obj(cfg.channels)?.[CHANNEL_ID])?.chain);
    const chain = rosterNames.length > 0 || existingChain ? { ...existingChain, roster } : undefined;
    let next = patchRoot(cfg, { owners, allowFrom: approved, room, chain });
    if (agentId) {
      const bindings = Array.isArray((next as { bindings?: unknown }).bindings) ? [...((next as { bindings: unknown[] }).bindings)] : [];
      const exists = bindings.some((b) => obj(obj(b)?.match)?.channel === CHANNEL_ID && obj(obj(b)?.match)?.accountId === accountId);
      if (!exists) bindings.push({ agentId, match: { channel: CHANNEL_ID, accountId } });
      next = { ...next, bindings } as OpenClawConfig;
    }
    next = withOwnerAllowFrom(next, owners);
    const lines = await runFinalizeChecks({ cfg: next, accountId, password: credentialValues.password });
    await prompter.note(lines.join('\n'), 'Checks');
    return { cfg: next };
  },
};
