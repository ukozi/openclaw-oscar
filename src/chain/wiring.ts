import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';
import { registerAwarenessSource } from '../awareness.js';
import { listAccountIds, readPolicy, resolveAccount } from '../config.js';
import { setImControlHandler } from '../inbound/im.js';
import { roomSink, setRoomBrain } from '../inbound/room.js';
import { decodePeerId, normalizeName } from '../names.js';
import { toWireHtml } from '../oscar/text.js';
import type { Logger } from '../oscar/types.js';
import { sendRoomLine, setOutboundTextFilter } from '../outbound.js';
import { handoffToolPolicy, roleOf } from '../policy.js';
import type { ToolPolicy } from '../policy.js';
import { rosterPresence } from '../presence/away.js';
import { getRuntime, liveConfig, runtimeForSessionKey } from '../runtime.js';
import type { AccountRuntime } from '../runtime.js';
import { hostOwnerListHasStar } from '../status.js';
import { ChainController } from './controller.js';
import type { ChainTracker } from './controller.js';
import { handoffAwarenessLines } from './report.js';
import { roomKeyOf } from './types.js';

const unsubscribers = new WeakMap<AccountRuntime, (() => void)[]>();

export function installChain(opts: { rt: AccountRuntime; getCfg: () => unknown; tracker: ChainTracker; log: Logger }): ChainController {
  const { rt, getCfg, tracker, log } = opts;
  const accountId = rt.accountId;
  const self = (): string => normalizeName(rt.session.selfInfo()?.screenName ?? resolveAccount(getCfg(), accountId).screenName);
  const controller = new ChainController({
    accountId,
    self,
    policy: () => readPolicy(getCfg()),
    ownerWildcard: () => hostOwnerListHasStar(getCfg()),
    roomChunkLimit: () => resolveAccount(getCfg(), accountId).roomTextChunkLimit,
    room: (roomKey) => rt.rooms.get(roomKey),
    sessionKeyFor: (roomKey) => {
      for (const [sessionKey, bound] of rt.sessionKeys) {
        if (bound.peer.kind === 'room' && roomKeyOf(bound.peer.room) === roomKey) return sessionKey;
      }
      return undefined;
    },
    roomKeyForSession: (sessionKey) => {
      const wanted = sessionKey.toLowerCase();
      for (const [key, bound] of rt.sessionKeys) {
        if (key.toLowerCase() === wanted) return bound.peer.kind === 'room' ? roomKeyOf(bound.peer.room) : undefined;
      }
      return undefined;
    },
    tracker,
    sink: roomSink(accountId),
    say: (room, markdown, sayOpts) => sendRoomLine(accountId, room, markdown, sayOpts),
    sendIm: (to, line) => {
      rt.session.sendIm(to, toWireHtml(line), { priority: 'control' }).catch((err: unknown) => {
        log.debug('chain hello was not sent', { to, error: String(err) });
      });
    },
    rosterPresence: () => rosterPresence(rt.session, readPolicy(getCfg()).chain.roster, self()),
    log,
  });
  rt.chain = controller;
  setRoomBrain(accountId, { onRoomMessage: (ev) => controller.onRoomMessage(ev) });
  setOutboundTextFilter(accountId, (meta, markdown) => controller.filterOutbound(meta, markdown));
  setImControlHandler(accountId, (ev) => controller.onIm(ev));
  unsubscribers.set(rt, [
    rt.session.on('roomReady', (p) => controller.onRoomReady(p.room, p.occupants)),
    rt.session.on('roomJoin', (ev) => controller.onRoomJoin(ev)),
    rt.session.on('roomLeave', (ev) => controller.onRoomLeave(ev)),
    rt.session.on('presence', (p) => controller.onPresence(p.name, p.online)),
    rt.session.on('rate', (ev) => controller.onRate(ev)),
  ]);
  return controller;
}

export function uninstallChain(rt: AccountRuntime): void {
  rt.chain?.stop();
  delete rt.chain;
  for (const off of unsubscribers.get(rt) ?? []) off();
  unsubscribers.delete(rt);
  setRoomBrain(rt.accountId, null);
  setOutboundTextFilter(rt.accountId, null);
  setImControlHandler(rt.accountId, null);
}

export type GroupHookParams = { cfg: unknown; groupId?: string | null; accountId?: string | null; senderId?: string | null };

function runtimeForBot(cfg: unknown, accountId: string | null | undefined, bot: string): AccountRuntime | undefined {
  const direct = accountId ? getRuntime(accountId) : undefined;
  if (direct) return direct;
  for (const id of listAccountIds(cfg)) {
    const rt = getRuntime(id);
    if (rt && normalizeName(rt.session.selfInfo()?.screenName ?? resolveAccount(cfg, id).screenName) === bot) return rt;
  }
  return undefined;
}

export function chainToolPolicy(params: GroupHookParams): { handled: true; policy: ToolPolicy | undefined } | { handled: false } {
  const peer = params.groupId ? decodePeerId(params.groupId) : null;
  if (!peer || peer.kind !== 'room') return { handled: false };
  const cfg = liveConfig(params.cfg);
  const policy = readPolicy(cfg);
  const origin = runtimeForBot(cfg, params.accountId, peer.bot)?.chain?.turnOrigin(roomKeyOf(peer.room));
  if (origin) return { handled: true, policy: handoffToolPolicy(origin, policy, peer.room.name) };
  const sender = params.senderId ? normalizeName(params.senderId) : '';
  if (roleOf(sender, policy) !== 'bot') return { handled: false };
  return { handled: true, policy: handoffToolPolicy({ originator: '', delegator: sender }, policy, peer.room.name) };
}

export function registerChainHooks(api: Pick<OpenClawPluginApi, 'on'>): void {
  api.on('before_tool_call', (_event, ctx) => {
    if (!ctx.sessionKey) return;
    runtimeForSessionKey(ctx.sessionKey)?.chain?.toolStarted(ctx.sessionKey);
  });
  registerAwarenessSource((accountId) => {
    const chain = getRuntime(accountId)?.chain;
    return chain ? handoffAwarenessLines(chain.facts().open, Date.now()) : [];
  });
}
