import type { ChannelStatusAdapter } from 'openclaw/plugin-sdk/channel-contract';
import { createComputedAccountStatusAdapter } from 'openclaw/plugin-sdk/status-helpers';
import type { ChannelStatusIssue } from 'openclaw/plugin-sdk/status-helpers';
import { chainIssues } from './chain/report.js';
import { CHANNEL_ID, PLUGIN_ID, TOOL_NAMES, configProblems, defaultAccountId, listAccountIds, readPolicy } from './config.js';
import type { ResolvedAccount } from './config.js';
import { roomIssues } from './inbound/issues.js';
import { normalizeName } from './names.js';
import type { SessionState, StateReason } from './oscar/index.js';
import { getRuntime, liveConfig } from './runtime.js';
import type { ProbeResult } from './runtime.js';

export type Severity = 'error' | 'warning' | 'info';
export type OscarIssue = { kind: ChannelStatusIssue['kind']; severity: Severity; message: string; fix: string };
export type IssueInput = {
  cfg: unknown; account: ResolvedAccount;
  state?: SessionState; halted?: { reason: StateReason; detail: string };
  probe?: ProbeResult; counters?: { droppedSends: number; eventGaps: number };
};

export const TOOLS_ALSO_ALLOW_LINE = `tools.alsoAllow: ["message", "oscar_delegate", "oscar_status", "oscar_room"]`;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export function isPrivateHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1' || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan')) return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  return /^f[cd][0-9a-f]{0,2}:/.test(h) || /^fe80:/.test(h);
}

export function hiddenTools(cfg: unknown, agentId: string | undefined): string[] {
  const globalTools = obj(obj(cfg)?.tools) ?? {};
  const agents = Array.isArray(obj(obj(cfg)?.agents)?.list) ? (obj(obj(cfg)?.agents)?.list as unknown[]) : [];
  const agentTools = obj(agents.map(obj).find((a) => a?.id === agentId)?.tools) ?? {};
  const profile = typeof agentTools.profile === 'string' ? agentTools.profile : typeof globalTools.profile === 'string' ? globalTools.profile : undefined;
  const allow = strings(agentTools.allow).length > 0 ? strings(agentTools.allow) : strings(globalTools.allow);
  const alsoAllow = [...strings(globalTools.alsoAllow), ...strings(agentTools.alsoAllow)];
  const listed = (entries: string[], name: string, plugin: boolean): boolean =>
    entries.includes(name) || (plugin ? entries.includes('group:plugins') || entries.includes(PLUGIN_ID) : entries.includes('group:messaging'));
  const visible = (name: string, plugin: boolean): boolean => {
    if (allow.length > 0) return listed(allow, name, plugin);
    if (!profile || profile === 'full') return true;
    if (profile === 'messaging' && !plugin) return true;
    return listed(alsoAllow, name, plugin);
  };
  return [['message', false] as const, ...TOOL_NAMES.map((n) => [n, true] as const)].filter(([n, p]) => !visible(n, p)).map(([n]) => n);
}

function oscarBindings(cfg: unknown): { agentId: string; accountId?: string }[] {
  const out: { agentId: string; accountId?: string }[] = [];
  const bindings = obj(cfg)?.bindings;
  for (const raw of Array.isArray(bindings) ? bindings : []) {
    const binding = obj(raw);
    const match = obj(binding?.match);
    if (!binding || !match || match.channel !== CHANNEL_ID || typeof binding.agentId !== 'string') continue;
    out.push({ agentId: binding.agentId, ...(typeof match.accountId === 'string' && match.accountId ? { accountId: match.accountId } : {}) });
  }
  return out;
}

export function boundAgentId(cfg: unknown, accountId: string): string | undefined {
  const bindings = oscarBindings(cfg);
  return (
    bindings.find((b) => b.accountId === accountId)
    ?? bindings.find((b) => b.accountId === '*')
    ?? (accountId === defaultAccountId(cfg) ? bindings.find((b) => b.accountId === undefined) : undefined)
  )?.agentId;
}

function hostOwnerList(cfg: unknown): string[] {
  const entries = obj(obj(cfg)?.commands)?.ownerAllowFrom;
  return Array.isArray(entries) ? entries.map((e) => String(e).trim()).filter((e) => e.length > 0) : [];
}

export function hostOwnerListHasStar(cfg: unknown): boolean {
  return hostOwnerList(cfg).includes('*');
}

export function ownerIssues(cfg: unknown): OscarIssue[] {
  const issues: OscarIssue[] = [];
  const owners = readPolicy(cfg).owners;
  const entries = hostOwnerList(cfg);
  const star = entries.includes('*');
  const unprefixed = entries.filter((e) => e !== '*' && !e.includes(':'));
  const ours = entries.filter((e) => /^oscar:/i.test(e)).map(normalizeName);
  if (star) {
    issues.push({ kind: 'permissions', severity: 'error', message: 'commands.ownerAllowFrom contains "*": every sender is an owner to OpenClaw, and hand-offs are refused', fix: 'Remove "*" from commands.ownerAllowFrom and list owners as "oscar:<name>".' });
  }
  if (unprefixed.length > 0) {
    issues.push({ kind: 'permissions', severity: 'warning', message: `commands.ownerAllowFrom has entries without a channel prefix (${unprefixed.join(', ')}); they count on every channel`, fix: 'Give each entry its channel, for example "oscar:<name>".' });
  }
  for (const name of ours) {
    if (!owners.includes(name)) {
      issues.push({ kind: 'permissions', severity: 'warning', message: `commands.ownerAllowFrom names oscar:${name}, who is not in channels.oscar.owners`, fix: `Add ${name} to channels.oscar.owners, or remove "oscar:${name}" from commands.ownerAllowFrom.` });
    }
  }
  const explicit = [...ours, ...unprefixed.map(normalizeName)];
  const commandLists = obj(obj(obj(cfg)?.commands)?.allowFrom);
  const widened = Boolean(commandLists && (Array.isArray(commandLists[CHANNEL_ID]) || Array.isArray(commandLists['*'])));
  if (!star && explicit.length === 0 && widened) {
    issues.push({
      kind: 'permissions', severity: 'error',
      message: 'commands.allowFrom is set while commands.ownerAllowFrom names no owner for this channel: approved people can run session commands',
      fix: `Add ${owners.length > 0 ? owners.map((o) => `"oscar:${o}"`).join(', ') : '"oscar:<owner>"'} to commands.ownerAllowFrom.`,
    });
  }
  if (!star && explicit.length > 0) {
    for (const owner of owners) {
      if (!explicit.includes(owner)) {
        issues.push({ kind: 'permissions', severity: 'error', message: `owner ${owner} is not an owner to OpenClaw on this host`, fix: `Add "oscar:${owner}" to commands.ownerAllowFrom.` });
      }
    }
  }
  return issues;
}

const REASONS: Record<StateReason, (account: ResolvedAccount, detail: string) => OscarIssue | null> = {
  'bad-password': () => ({ kind: 'auth', severity: 'error', message: 'the server rejected the password', fix: 'Update channels.oscar.password or passwordFile, then restart the gateway.' }),
  'unknown-name': (a) => ({ kind: 'auth', severity: 'error', message: `the server does not know the screen name "${a.display}"`, fix: 'Check channels.oscar.screenName, or create the account on the server.' }),
  suspended: () => ({ kind: 'auth', severity: 'error', message: 'the account is suspended on the server', fix: 'Ask the server operator to lift the suspension.' }),
  'login-rate-limited': () => ({ kind: 'runtime', severity: 'warning', message: 'rate limited at login; the server allows 10 logins a minute per address', fix: 'Wait a minute. Accounts on this gateway already stagger their logins.' }),
  'redirect-unroutable': (_a, d) => ({ kind: 'config', severity: 'error', message: `the server redirected to an address this host cannot reach${d}`, fix: 'Set channels.oscar.redirect to "pin", or ask the server operator to fix the advertised host.' }),
  'disconnected-by-server': (_a, d) => ({ kind: 'runtime', severity: 'warning', message: `disconnected by server (signed on elsewhere, rate limit or kick)${d}`, fix: 'Never sign into this screen name from another client. It reconnects on its own after a minute.' }),
  'md5-unavailable': () => ({ kind: 'runtime', severity: 'error', message: 'this Node build disables MD5, which the login needs', fix: 'Run the gateway on a Node build that is not restricted to FIPS-only hashes.' }),
  network: (a) => ({ kind: 'runtime', severity: 'warning', message: `cannot reach ${a.host}:${a.port}`, fix: 'Check the host, the port and the firewall.' }),
  tls: (_a, d) => ({ kind: 'config', severity: 'error', message: `TLS failed${d}`, fix: 'Check channels.oscar.tls, the port and caFile. Certificate checks are never skipped.' }),
  'unauthenticated-server': () => null,
};

export function collectOscarIssues(input: IssueInput): OscarIssue[] {
  const { cfg, account } = input;
  const issues: OscarIssue[] = [];
  for (const problem of configProblems(cfg)) {
    if (problem.startsWith(`channels.${CHANNEL_ID}.owners:`)) continue;
    issues.push({ kind: 'config', severity: 'error', message: problem, fix: 'Fix the named key in openclaw.json.' });
  }
  if (!account.configured) {
    issues.push({ kind: 'config', severity: 'error', message: 'not configured: a host, a screen name and a password are needed', fix: 'Run: openclaw channels add --channel oscar --url oscar://<screenName>@<host> --password <password>' });
    return issues;
  }

  const state = input.state;
  if (state && state.phase !== 'online' && state.reason) {
    const issue = REASONS[state.reason](account, state.detail ? `: ${state.detail}` : '');
    if (issue) issues.push(issue);
  }
  if (input.probe === 'does-not-check' || input.halted?.reason === 'unauthenticated-server' || state?.reason === 'unauthenticated-server') {
    issues.push({
      kind: 'auth', severity: account.dangerouslyAllowUnauthenticatedServer ? 'warning' : 'error',
      message: 'the server does not check passwords: anyone can sign on as an owner',
      fix: 'Ask the server operator to set DISABLE_AUTH=false. To run anyway, set channels.oscar.dangerouslyAllowUnauthenticatedServer: true.',
    });
  }
  if (!account.tls && !isPrivateHost(account.host)) {
    issues.push({ kind: 'config', severity: 'warning', message: `plaintext connection to ${account.host}: anyone on the network path can read messages and replay the login`, fix: 'Where the server offers TLS, set channels.oscar.tls: true and the TLS port.' });
  }

  const policy = readPolicy(cfg);
  if (!policy.room) {
    issues.push({ kind: 'config', severity: 'info', message: 'home room unset: the bot does IMs and invites only', fix: 'Optional: set channels.oscar.room.name.' });
  }
  issues.push(...roomIssues(getRuntime(account.accountId), policy, account.screenName));
  issues.push(...chainIssues(getRuntime(account.accountId)?.chain?.facts(), Date.now()));
  if (policy.owners.length === 0) {
    issues.push({
      kind: 'config', severity: 'error',
      message: 'no owners: the account does not run, because OpenClaw would treat every approved person as an owner',
      fix: 'Add at least one screen name to channels.oscar.owners, then restart the gateway.',
    });
  }
  issues.push(...ownerIssues(cfg));

  const ids = listAccountIds(cfg);
  const agentId = boundAgentId(cfg, account.accountId);
  const scoped = oscarBindings(cfg).some((b) => b.accountId === account.accountId);
  if (!scoped) {
    issues.push({
      kind: 'config', severity: ids.length > 1 ? 'warning' : 'info',
      message: `account ${account.accountId} has no agent binding of its own`,
      fix: `Add to bindings: { agentId: "<agent>", match: { channel: "oscar", accountId: "${account.accountId}" } }`,
    });
  }
  for (const other of ids) {
    if (other === account.accountId) continue;
    if ((boundAgentId(cfg, other) ?? '(default)') === (agentId ?? '(default)')) {
      const pair = [account.accountId, other].sort();
      issues.push({ kind: 'config', severity: 'warning', message: `accounts ${pair[0]} and ${pair[1]} both resolve to agent ${agentId ?? '(default)'}`, fix: 'Give each account its own agent in bindings.' });
    }
  }

  const hidden = hiddenTools(cfg, agentId);
  if (hidden.length > 0) {
    issues.push({ kind: 'permissions', severity: 'warning', message: `hidden by the tool profile: ${hidden.join(', ')}`, fix: TOOLS_ALSO_ALLOW_LINE });
  }
  const counters = input.counters;
  if (counters && (counters.droppedSends > 0 || counters.eventGaps > 0)) {
    issues.push({ kind: 'runtime', severity: 'warning', message: `${counters.droppedSends} sends were dropped and ${counters.eventGaps} event gaps were seen since start`, fix: 'Check the server rate limits. An operator-set bot flag lifts the IM limit.' });
  }
  return issues;
}

function toStatusIssue(accountId: string, issue: OscarIssue): ChannelStatusIssue {
  const prefix = issue.severity === 'error' ? '' : `${issue.severity}: `;
  return { channel: CHANNEL_ID, accountId, kind: issue.kind, message: `${prefix}${issue.message}`, fix: issue.fix };
}

export const oscarStatus: ChannelStatusAdapter<ResolvedAccount, { passwordCheck: ProbeResult }> = createComputedAccountStatusAdapter<ResolvedAccount, { passwordCheck: ProbeResult }>({
  probeAccount: async ({ account }) => {
    const session = getRuntime(account.accountId)?.session;
    return { passwordCheck: session && session.getState().phase === 'online' ? await session.probePasswordCheck() : 'unknown' };
  },
  resolveAccountSnapshot: ({ account, cfg, probe }) => {
    const live = liveConfig(cfg);
    const rt = getRuntime(account.accountId);
    const oscarIssues = collectOscarIssues({
      cfg: live, account, state: rt?.session.getState(), halted: rt?.halted,
      probe: probe?.passwordCheck ?? rt?.probe?.result, counters: rt?.counters,
    });
    const policy = readPolicy(live);
    return {
      accountId: account.accountId, name: account.display, enabled: account.enabled, configured: account.configured,
      extra: { oscarIssues, dmPolicy: policy.dmPolicy, allowFrom: policy.allowFrom },
    };
  },
  collectStatusIssues: (accounts) => accounts.flatMap((snapshot) => {
    const issues = (snapshot as unknown as { oscarIssues?: OscarIssue[] }).oscarIssues ?? [];
    return issues.map((issue) => toStatusIssue(snapshot.accountId, issue));
  }),
});
