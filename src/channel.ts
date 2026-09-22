import { buildChannelOutboundSessionRoute, createChatChannelPlugin, tryReadSecretFileSync } from 'openclaw/plugin-sdk/channel-core';
import type { ChannelPlugin, OpenClawConfig } from 'openclaw/plugin-sdk/channel-core';
import { createAccountStatusSink, createRunStateMachine } from 'openclaw/plugin-sdk/channel-lifecycle';
import { createChannelMessageAdapterFromOutbound } from 'openclaw/plugin-sdk/channel-outbound';
import type { ChannelGatewayContext } from 'openclaw/plugin-sdk/channel-contract';
import { normalizeSecretInputString } from 'openclaw/plugin-sdk/secret-input';
import { chainToolPolicy, installChain, uninstallChain } from './chain/wiring.js';
import {
  CHANNEL_ID, RELOAD_NOOP_PREFIXES, buddyList, defaultAccountId, listAccountIds, oscarChannelConfigSchema, readPolicy, resolveAccount,
} from './config.js';
import type { ResolvedAccount } from './config.js';
import { attachRooms } from './inbound/home.js';
import { admitSender, createImHandler } from './inbound/im.js';
import { recordRoomLine } from './inbound/room.js';
import { dispatchImTurn, dispatchRoomTurn } from './inbound/turn.js';
import { decodePeerId, encodePeerId, formatTarget, isAsciiName, normalizeName, parseTarget } from './names.js';
import type { PeerRef } from './names.js';
import { createNotices, sendNotice } from './notice.js';
import { createOscarSession } from './oscar/index.js';
import type { Logger, SessionState } from './oscar/index.js';
import { outboundBase, sendAdapterText } from './outbound.js';
import { roleOf, roomRequiresMention, senderToolPolicy, toolDeny } from './policy.js';
import { presenceActions, presenceToolHints, startPresence } from './presence/register.js';
import { getRunTracker } from './presence/runs.js';
import {
  clearRuntime, createPasswordGuard, currentGeneration, getRuntime, liveConfig, nextGeneration, setRuntime, sharedLoginBudget,
} from './runtime.js';
import type { AccountRuntime, ProbeResult, Timers } from './runtime.js';
import { channelSecrets } from './secret-contract-api.js';
import { oscarSetupAdapter, oscarSetupWizard } from './setup.js';
import { oscarStatus } from './status.js';

export { CHANNEL_ID } from './config.js';

type Obj = Record<string, unknown>;
type ToolPolicy = { allow?: string[]; alsoAllow?: string[]; deny?: string[] };

export const gatewayDeps: { createSession: typeof createOscarSession; now: () => number; timers: Timers } = {
  createSession: createOscarSession,
  now: () => Date.now(),
  timers: { setTimeout, clearTimeout },
};

const stoppers = new Map<string, () => Promise<void>>();

const obj = (v: unknown): Obj | undefined => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

function botName(cfg: unknown, accountId?: string | null): string {
  const id = accountId && accountId.length > 0 ? accountId : defaultAccountId(cfg);
  return normalizeName(getRuntime(id)?.session.selfInfo()?.screenName ?? resolveAccount(cfg, id).screenName);
}

function toLogger(sink: ChannelGatewayContext<ResolvedAccount>['log'], accountId: string): Logger {
  const line = (msg: string, fields?: Record<string, unknown>): string =>
    `${CHANNEL_ID}[${accountId}] ${msg}${fields && Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : ''}`;
  return {
    debug: (msg, fields) => sink?.debug?.(line(msg, fields)),
    info: (msg, fields) => sink?.info(line(msg, fields)),
    warn: (msg, fields) => sink?.warn(line(msg, fields)),
    error: (msg, fields) => sink?.error(line(msg, fields)),
  };
}

function readPassword(account: ResolvedAccount): string {
  if (account.passwordFile) {
    const fromFile = tryReadSecretFileSync(account.passwordFile, 'oscar password file')?.trim();
    if (!fromFile) throw new Error('the password file is missing, unreadable or empty');
    return fromFile;
  }
  const value = normalizeSecretInputString(account.password);
  if (!value) throw new Error('the password is not available: the secret reference was not resolved');
  return value;
}

function resolveToolPolicy(params: { cfg: unknown; groupId?: string | null; accountId?: string | null; senderId?: string | null }): ToolPolicy | undefined {
  const chain = chainToolPolicy(params);
  if (chain.handled) return chain.policy;
  const ref = decodePeerId(params.groupId ?? '');
  if (!ref) return undefined;
  const policy = readPolicy(liveConfig(params.cfg));
  const sender = params.senderId ? normalizeName(params.senderId) : '';
  if (ref.kind === 'room') return senderToolPolicy(sender, policy, ref.room.name);
  // The peer id names the originator; a missing sender id falls back to it, a different one can only narrow.
  const deny = toolDeny(sender && sender !== ref.peer ? 'unlisted' : roleOf(ref.peer, policy), policy);
  return deny.length > 0 ? { deny } : undefined;
}

function ensure(parent: Obj, key: string): Obj {
  const existing = obj(parent[key]);
  if (existing) return existing;
  const created: Obj = {};
  parent[key] = created;
  return created;
}

async function teardown(accountId: string): Promise<void> {
  const stop = stoppers.get(accountId);
  stoppers.delete(accountId);
  await stop?.();
}

function untilAborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

export async function startAccount(ctx: ChannelGatewayContext<ResolvedAccount>): Promise<void> {
  const { accountId } = ctx;
  const generation = nextGeneration(accountId);
  const log = toLogger(ctx.log, accountId);
  const { now, timers } = gatewayDeps;
  const getCfg = (): unknown => liveConfig(ctx.cfg);
  await teardown(accountId);

  const account = resolveAccount(getCfg(), accountId);
  if (!account.enabled || !account.configured) {
    ctx.setStatus({ ...ctx.getStatus(), accountId, running: false, connected: false, lastError: account.enabled ? 'not configured' : 'disabled' });
    return;
  }
  // With no owner the host takes allowFrom as its owner list, so the account does not run at all.
  if (readPolicy(getCfg()).owners.length === 0) {
    log.error('not starting: channels.oscar.owners names nobody');
    ctx.setStatus({ ...ctx.getStatus(), accountId, running: false, connected: false, lastError: 'no owners' });
    return;
  }

  const self = (): string => botName(getCfg(), accountId);
  const session = gatewayDeps.createSession({
    host: account.host, port: account.port, tls: account.tls, ...(account.caFile ? { caFile: account.caFile } : {}), redirect: account.redirect,
    screenName: account.display,
    getPassword: async () => readPassword(resolveAccount(getCfg(), accountId)),
    buddies: () => buddyList(readPolicy(getCfg()), account.screenName),
    log, loginBudget: sharedLoginBudget(),
    now, timers,
  });
  const presence = startPresence({
    accountId,
    session,
    getCfg,
    machine: createRunStateMachine({
      setStatus: createAccountStatusSink({ accountId: ctx.accountId, setStatus: ctx.setStatus }),
      abortSignal: ctx.abortSignal,
    }),
    log,
  });
  const rt: AccountRuntime = {
    accountId, session, rooms: new Map(), sessionKeys: new Map(), lastReplyAt: new Map(), counters: { droppedSends: 0, eventGaps: 0 },
    away: presence.away,
    stopPresence: presence.stop,
  };
  setRuntime(rt);

  const publish = (state: SessionState): void => {
    const online = state.phase === 'online' && !rt.halted;
    const reason = rt.halted ? `${rt.halted.reason}: ${rt.halted.detail}` : state.reason ? `${state.reason}${state.detail ? `: ${state.detail}` : ''}` : null;
    ctx.setStatus({
      ...ctx.getStatus(), accountId,
      running: !rt.halted && state.phase !== 'stopped' && state.phase !== 'fatal',
      connected: online,
      reconnectAttempts: state.attempts,
      lastError: online ? null : reason,
      ...(online ? { lastConnectedAt: now() } : {}),
      ...(rt.halted || state.phase === 'fatal' ? { terminalDisconnect: true } : {}),
    });
  };

  const notices = createNotices({
    self, getCfg, now, timers, log,
    presenceOf: (name) => session.presenceOf(name),
    send: (p) => sendNotice({ cfg: getCfg(), accountId, bot: self(), owner: p.owner, text: p.text }),
  });
  const im = createImHandler({
    accountId, self, getCfg, now, timers, log,
    admit: (from, policy) => admitSender(accountId, from, policy),
    dispatch: (turn) => dispatchImTurn(turn, { accountId, self, getCfg, now, log, ring: () => notices.ring() }),
    contact: (a) => notices.contact(a),
    replayed: (list) => notices.replayed(list),
    lastReplyAt: (peer) => rt.lastReplyAt.get(peer),
    updateBuddies: () => session.updateBuddies(),
  });
  const detachRooms = attachRooms(rt, {
    policy: () => readPolicy(getCfg()),
    self: () => session.selfInfo()?.screenName ?? account.display,
    now,
    timers,
    log,
    runTurn: (req) => dispatchRoomTurn(req, { accountId, getCfg, log }),
    record: (line) => recordRoomLine(line),
    noticeStranger: (name, display) => notices.contact({ name, display, kind: 'invite', at: now() }),
    tellOwners: async (text) => {
      for (const owner of readPolicy(getCfg()).owners) {
        // The server stores at most 10 offline messages per sender and recipient; a note must not use a slot a reply needs.
        if (owner === self() || session.presenceOf(owner)?.online !== true) continue;
        await sendNotice({ cfg: getCfg(), accountId, bot: self(), owner, text }).catch((err: unknown) => {
          log.warn('owner note was not delivered', { owner, error: err instanceof Error ? err.message : String(err) });
        });
      }
    },
    contacts: () => notices.ring().map((entry) => ({ name: entry.name, kind: entry.kind, at: entry.lastAt })),
  });
  installChain({ rt, getCfg, tracker: getRunTracker(), log });
  const guard = createPasswordGuard({
    cacheKey: `${account.host}:${account.port}:${account.screenName}`,
    allowUnauthenticated: account.dangerouslyAllowUnauthenticatedServer,
    probe: () => session.probePasswordCheck(),
    now, timers, log,
    onResult: (r) => { rt.probe = r; },
    halt: async (detail) => {
      rt.halted = { reason: 'unauthenticated-server', detail };
      log.error('stopping: the server does not check passwords');
      publish(session.getState());
      await rt.stopPresence?.();
      await session.stop();
    },
  });

  let wasOnline = false;
  const offs = [
    session.on('im', (ev) => im.onIm(ev)),
    session.on('presence', (p) => notices.ownerPresence(p.name, p.online)),
    session.on('state', (state) => {
      if (wasOnline && state.phase !== 'online' && state.phase !== 'stopped') rt.counters.eventGaps += 1;
      wasOnline = state.phase === 'online';
      if (state.reason === 'unauthenticated-server' && !rt.halted) {
        rt.halted = { reason: 'unauthenticated-server', detail: state.detail ?? 'the server does not check passwords' };
      }
      publish(state);
      if (state.phase === 'online') guard.onOnline();
    }),
  ];
  stoppers.set(accountId, async () => {
    await rt.stopPresence?.();
    uninstallChain(rt);
    detachRooms();
    for (const off of offs) off();
    guard.stop();
    im.stop();
    notices.stop();
    await session.stop();
    if (getRuntime(accountId) === rt) clearRuntime(accountId);
    ctx.setStatus({ ...ctx.getStatus(), accountId, running: false, connected: false, lastStopAt: now() });
  });

  ctx.setStatus({ ...ctx.getStatus(), accountId, running: true, connected: false, lastStartAt: now(), lastError: null });
  session.start();
  await untilAborted(ctx.abortSignal);
  if (currentGeneration(accountId) === generation) await teardown(accountId);
}

export async function stopAccount(ctx: ChannelGatewayContext<ResolvedAccount>): Promise<void> {
  nextGeneration(ctx.accountId);
  await teardown(ctx.accountId);
}

export const oscarPlugin: ChannelPlugin<ResolvedAccount, { passwordCheck: ProbeResult }> = createChatChannelPlugin<ResolvedAccount, { passwordCheck: ProbeResult }>({
  base: {
    id: CHANNEL_ID,
    meta: {
      id: CHANNEL_ID,
      label: 'OSCAR',
      selectionLabel: 'OSCAR (Open OSCAR Server)',
      docsPath: '/channels/oscar',
      blurb: 'Screen names, IMs and chat rooms on an Open OSCAR Server, over the native protocol.',
      markdownCapable: false,
    },
    capabilities: { chatTypes: ['direct', 'group'], media: false, reactions: false, reply: false, threads: false, polls: false, edit: false, unsend: false },
    actions: presenceActions,
    agentPrompt: { messageToolHints: presenceToolHints },
    reload: { configPrefixes: [`channels.${CHANNEL_ID}`], noopPrefixes: RELOAD_NOOP_PREFIXES },
    configSchema: oscarChannelConfigSchema as ChannelPlugin['configSchema'],
    config: {
      listAccountIds: (cfg) => listAccountIds(cfg),
      resolveAccount: (cfg, accountId) => resolveAccount(cfg, accountId),
      defaultAccountId: (cfg) => defaultAccountId(cfg),
      isEnabled: (account) => account.enabled,
      isConfigured: (account) => account.configured,
      unconfiguredReason: () => 'needs a host, a screen name and a password',
      resolveAllowFrom: ({ cfg }) => readPolicy(cfg).allowFrom,
      formatAllowFrom: ({ allowFrom }) => allowFrom.map((entry) => normalizeName(String(entry))).filter((entry) => entry.length > 0),
    },
    setup: oscarSetupAdapter,
    setupWizard: oscarSetupWizard,
    groups: {
      resolveToolPolicy: (params) => resolveToolPolicy(params),
      resolveRequireMention: (params) => {
        const ref = decodePeerId(params.groupId ?? '');
        if (!ref) return undefined;
        return ref.kind === 'room' ? roomRequiresMention(ref.bot, readPolicy(liveConfig(params.cfg))) : false;
      },
    },
    commands: { enforceOwnerForCommands: true },
    allowlist: {
      supportsScope: ({ scope }) => scope === 'dm',
      readConfig: ({ cfg }) => {
        const policy = readPolicy(cfg);
        return { dmAllowFrom: policy.allowFrom, dmPolicy: policy.dmPolicy };
      },
      applyConfigEdit: ({ parsedConfig, scope, action, entry }) => {
        if (scope !== 'dm') return null;
        const name = normalizeName(entry);
        if (!name || name === '*' || !isAsciiName(entry)) return { kind: 'invalid-entry' };
        if (roleOf(name, readPolicy(parsedConfig)) === 'bot') return { kind: 'invalid-entry' };
        const sec = ensure(ensure(parsedConfig, 'channels'), CHANNEL_ID);
        const current = strings(sec.allowFrom);
        const has = current.some((e) => normalizeName(e) === name);
        let changed = false;
        if (action === 'add' && !has) {
          sec.allowFrom = [...current, name];
          changed = true;
        }
        if (action === 'remove' && has) {
          sec.allowFrom = current.filter((e) => normalizeName(e) !== name);
          changed = true;
        }
        return { kind: 'ok', changed, pathLabel: `channels.${CHANNEL_ID}.allowFrom`, writeTarget: { kind: 'channel', scope: { channelId: CHANNEL_ID } } };
      },
    },
    messaging: {
      targetPrefixes: [CHANNEL_ID],
      normalizeTarget: (raw) => {
        const target = parseTarget(raw, '');
        return target ? formatTarget(target) : undefined;
      },
      inferTargetChatType: ({ to }) => {
        const target = parseTarget(to, '');
        return target ? (target.kind === 'im' ? 'direct' : 'group') : undefined;
      },
      targetResolver: {
        looksLikeId: (raw) => parseTarget(raw, '') !== null,
        hint: 'a screen name, or room:<name>',
        resolveTarget: async ({ cfg, accountId, input }) => {
          const target = parseTarget(input, botName(liveConfig(cfg), accountId));
          if (!target) return null;
          const to = formatTarget(target);
          return { to, kind: target.kind === 'im' ? 'user' : 'group', display: to, source: 'normalized' };
        },
      },
      resolveOutboundSessionRoute: ({ cfg, agentId, accountId, target: raw }) => {
        const bot = botName(liveConfig(cfg), accountId);
        const target = parseTarget(raw, bot);
        if (!target) return null;
        const peer: PeerRef = target.kind === 'im' ? { kind: 'im', bot, peer: target.name } : { kind: 'room', bot, room: target.room };
        return buildChannelOutboundSessionRoute({
          cfg: cfg as OpenClawConfig, agentId, channel: CHANNEL_ID, accountId,
          peer: { kind: 'group', id: encodePeerId(peer) },
          chatType: target.kind === 'im' ? 'direct' : 'group',
          from: `${CHANNEL_ID}:${bot}`, to: formatTarget(target),
        });
      },
    },
    message: createChannelMessageAdapterFromOutbound({ id: CHANNEL_ID, outbound: { sendText: async (ctx) => sendAdapterText(ctx) } }),
    heartbeat: {
      checkReady: async ({ cfg, accountId }) => {
        const rt = getRuntime(accountId && accountId.length > 0 ? accountId : defaultAccountId(liveConfig(cfg)));
        if (!rt) return { ok: false, reason: 'not running' };
        if (rt.halted) return { ok: false, reason: rt.halted.reason };
        const phase = rt.session.getState().phase;
        return phase === 'online' ? { ok: true, reason: 'signed on' } : { ok: false, reason: `not signed on (${phase})` };
      },
    },
    status: oscarStatus,
    secrets: channelSecrets,
    gateway: { startAccount, stopAccount },
  },
  threading: { topLevelReplyToMode: 'off' },
  outbound: { base: outboundBase, attachedResults: { channel: CHANNEL_ID, sendText: (ctx) => sendAdapterText(ctx) } },
});
