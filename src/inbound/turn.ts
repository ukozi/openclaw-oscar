import type { OpenClawConfig } from 'openclaw/plugin-sdk/channel-core';
import { buildChannelInboundEventContext, runChannelInboundEvent } from 'openclaw/plugin-sdk/channel-inbound';
import { recordInboundSession } from 'openclaw/plugin-sdk/conversation-runtime';
import { dispatchReplyWithBufferedBlockDispatcher } from 'openclaw/plugin-sdk/reply-dispatch-runtime';
import { resolveAgentRoute } from 'openclaw/plugin-sdk/routing';
import { resolveStorePath } from 'openclaw/plugin-sdk/session-store-runtime';
import { awarenessFor } from '../awareness.js';
import { CHANNEL_ID, readPolicy, resolveAccount } from '../config.js';
import { encodePeerId, formatTarget } from '../names.js';
import type { PeerRef } from '../names.js';
import type { ContactRingEntry } from '../notice.js';
import type { Logger } from '../oscar/index.js';
import { sendMarkdown, typingFor } from '../outbound.js';
import { neutralizeDirectives, roleOf } from '../policy.js';
import { originOf, presenceDispatch, runtimeWiring } from '../presence/register.js';
import { getRuntime, touchActivity } from '../runtime.js';
import type { TurnRequest } from './room.js';

export type ImTurn = {
  from: string; fromDisplay: string; text: string; cookie: bigint; at: number;
  replayed?: { text: string; ageSeconds: number | null }[];
};
export type TurnDeps = {
  accountId: string; self: () => string; getCfg: () => unknown; now: () => number; log: Logger;
  ring: () => ContactRingEntry[];
  onRunStart?: (runId: string, sessionKey: string) => void;
};

type Untrusted = { label: string; source: string; type: string; payload: unknown };

export async function dispatchImTurn(turn: ImTurn, deps: TurnDeps): Promise<void> {
  const rawCfg = deps.getCfg();
  const cfg = rawCfg as OpenClawConfig;
  const policy = readPolicy(rawCfg);
  const account = resolveAccount(rawCfg, deps.accountId);
  const role = roleOf(turn.from, policy);
  const owner = role === 'owner';
  const peer: PeerRef = { kind: 'im', bot: deps.self(), peer: turn.from };
  const peerId = encodePeerId(peer);
  const to = formatTarget({ kind: 'im', name: turn.from });
  // A group-shaped peer keeps every host dmScope from folding this conversation into agent:main:main.
  const route = resolveAgentRoute({ cfg, channel: CHANNEL_ID, accountId: deps.accountId, peer: { kind: 'group', id: peerId } });
  getRuntime(deps.accountId)?.sessionKeys.set(route.sessionKey, { accountId: deps.accountId, peer });

  const body = owner ? turn.text : neutralizeDirectives(turn.text);
  const presence = presenceDispatch(
    { sessionKey: route.sessionKey, accountId: deps.accountId, origin: originOf(role), text: body },
    runtimeWiring,
  );
  const messageId = turn.cookie !== 0n ? `${turn.from}:${turn.cookie}` : `${turn.from}:t${turn.at}`;

  const untrusted: Untrusted[] = [
    { label: 'Sender', source: CHANNEL_ID, type: 'oscar_sender', payload: { role: owner ? 'owner' : role === 'approved' ? 'approved' : 'unlisted' } },
  ];
  if (turn.replayed) {
    untrusted.push({
      label: 'Messages received while signed off', source: CHANNEL_ID, type: 'oscar_offline_replay',
      payload: { messages: turn.replayed.map((m, i) => ({ line: i + 1, ageSeconds: m.ageSeconds })) },
    });
  }
  const ring = owner ? deps.ring() : [];
  if (ring.length > 0) {
    untrusted.push({
      label: 'Recent contact attempts', source: CHANNEL_ID, type: 'oscar_contact_attempts',
      payload: { attempts: ring.map((e) => ({ name: e.name, kind: e.kind, count: e.count, secondsAgo: Math.max(0, Math.round((deps.now() - e.lastAt) / 1000)), oddName: e.oddName })) },
    });
  }

  const rt = getRuntime(deps.accountId);
  if (rt) {
    for (const entry of awarenessFor(rt, policy, peer, owner ? 'owner' : 'approved', deps.now(), [])) {
      untrusted.push({ label: entry.label, source: CHANNEL_ID, type: 'awareness', payload: entry.payload });
    }
    touchActivity(rt, to, deps.now());
  }

  const ctxPayload = buildChannelInboundEventContext({
    channel: CHANNEL_ID,
    accountId: deps.accountId,
    messageId,
    timestamp: turn.at,
    from: `${CHANNEL_ID}:${turn.from}`,
    sender: { id: turn.from, name: turn.fromDisplay, isBot: false },
    conversation: { kind: 'direct', id: peerId, label: turn.fromDisplay },
    route: { agentId: route.agentId, accountId: deps.accountId, routeSessionKey: route.sessionKey },
    reply: { to, originatingTo: to },
    message: { rawBody: body, body, bodyForAgent: body, commandBody: body },
    access: { commands: { authorized: owner && !turn.replayed } },
    supplemental: { untrustedContext: untrusted },
    channelContext: { sender: { id: turn.from }, chat: { id: peerId, accountId: deps.accountId, kind: 'im' } },
    extra: { OwnerAllowFrom: [...policy.owners] },
  });

  const typingCallbacks = typingFor({ cfg: rawCfg, accountId: deps.accountId, peer: turn.from });

  await runChannelInboundEvent({
    channel: CHANNEL_ID,
    accountId: deps.accountId,
    raw: turn,
    adapter: {
      ingest: (raw) => ({ id: messageId, timestamp: raw.at, rawText: body, textForAgent: body, textForCommands: body, raw }),
      resolveTurn: () => ({
        cfg,
        channel: CHANNEL_ID,
        accountId: deps.accountId,
        agentId: route.agentId,
        routeSessionKey: route.sessionKey,
        storePath: resolveStorePath(cfg.session?.store, { agentId: route.agentId }),
        ctxPayload,
        recordInboundSession,
        dispatchReplyWithBufferedBlockDispatcher,
        messageId,
        delivery: {
          deliver: async (payload, info) => {
            const text = payload.text?.trim();
            if (!text) return;
            const sent = await sendMarkdown({ cfg: deps.getCfg(), accountId: deps.accountId, to, markdown: text, kind: info.kind });
            return { messageIds: sent.messageIds, visibleReplySent: sent.messageIds.length > 0 };
          },
          onError: (err, info) => {
            deps.log.warn('reply was not delivered', { to, kind: info.kind, error: err instanceof Error ? err.message : String(err) });
          },
        },
        ...(typingCallbacks ? { dispatcherOptions: { typingCallbacks } } : {}),
        replyOptions: {
          disableBlockStreaming: typeof account.blockStreaming === 'boolean' ? !account.blockStreaming : true,
          sourceReplyDeliveryMode: 'automatic',
          onAgentRunStart: (runId: string) => {
            presence.onAgentRunStart(runId);
            deps.onRunStart?.(runId, route.sessionKey);
          },
        },
        record: {
          onRecordError: (err) => {
            deps.log.warn('session meta was not recorded', { error: err instanceof Error ? err.message : String(err) });
          },
        },
      }),
    },
  });
}

export type RoomTurnDeps = Pick<TurnDeps, 'accountId' | 'getCfg' | 'log' | 'onRunStart'>;

export async function dispatchRoomTurn(req: TurnRequest, deps: RoomTurnDeps): Promise<void> {
  const peer = req.peer;
  const group = req.group;
  if (peer.kind !== 'room' || !group) throw new Error('a room turn needs a room peer and group facts');
  const rawCfg = deps.getCfg();
  const cfg = rawCfg as OpenClawConfig;
  const policy = readPolicy(rawCfg);
  const account = resolveAccount(rawCfg, deps.accountId);
  const peerId = encodePeerId(peer);
  const to = formatTarget({ kind: 'room', room: peer.room });
  const route = resolveAgentRoute({ cfg, channel: CHANNEL_ID, accountId: deps.accountId, peer: { kind: 'group', id: peerId } });
  getRuntime(deps.accountId)?.sessionKeys.set(route.sessionKey, { accountId: deps.accountId, peer });
  const presence = presenceDispatch(
    { sessionKey: route.sessionKey, accountId: deps.accountId, origin: req.origin, text: req.text },
    runtimeWiring,
  );

  const ctxPayload = buildChannelInboundEventContext({
    channel: CHANNEL_ID,
    accountId: deps.accountId,
    messageId: req.messageId,
    timestamp: req.timestamp,
    from: `${CHANNEL_ID}:${req.sender.name}`,
    sender: { id: req.sender.name, name: req.sender.display, isBot: req.sender.role === 'bot' },
    conversation: { kind: 'group', id: peerId, label: group.label },
    route: { agentId: route.agentId, accountId: deps.accountId, routeSessionKey: route.sessionKey },
    reply: { to, originatingTo: to },
    message: { rawBody: req.text, body: req.text, bodyForAgent: req.text, commandBody: req.text, inboundHistory: group.history },
    access: {
      commands: { authorized: req.commandAuthorized },
      // Core never derives mention state; false here can make it drop a group dispatch silently.
      mentions: { canDetectMention: true, wasMentioned: true, effectiveWasMentioned: true, requireMention: true },
    },
    supplemental: { untrustedContext: req.untrustedContext, groupSystemPrompt: group.systemPrompt },
    channelContext: { sender: { id: req.sender.name }, chat: { id: peerId, accountId: deps.accountId, kind: 'room' } },
    extra: { OwnerAllowFrom: [...policy.owners] },
  });

  await runChannelInboundEvent({
    channel: CHANNEL_ID,
    accountId: deps.accountId,
    raw: req,
    adapter: {
      ingest: (raw) => ({ id: raw.messageId, timestamp: raw.timestamp, rawText: raw.text, textForAgent: raw.text, textForCommands: raw.text, raw }),
      resolveTurn: () => ({
        cfg,
        channel: CHANNEL_ID,
        accountId: deps.accountId,
        agentId: route.agentId,
        routeSessionKey: route.sessionKey,
        storePath: resolveStorePath(cfg.session?.store, { agentId: route.agentId }),
        ctxPayload,
        recordInboundSession,
        dispatchReplyWithBufferedBlockDispatcher,
        messageId: req.messageId,
        delivery: {
          deliver: async (payload, info) => {
            const text = payload.text?.trim();
            if (!text) return;
            const sent = await sendMarkdown({ cfg: deps.getCfg(), accountId: deps.accountId, to, markdown: text, kind: info.kind });
            return { messageIds: sent.messageIds, visibleReplySent: sent.messageIds.length > 0 };
          },
          onError: (err, info) => {
            deps.log.warn('room reply was not delivered', { to, kind: info.kind, error: err instanceof Error ? err.message : String(err) });
          },
        },
        ...(req.botLoopProtection ? { botLoopProtection: req.botLoopProtection } : {}),
        replyOptions: {
          disableBlockStreaming: typeof account.blockStreaming === 'boolean' ? !account.blockStreaming : true,
          sourceReplyDeliveryMode: 'automatic',
          onAgentRunStart: (runId: string) => {
            presence.onAgentRunStart(runId);
            deps.onRunStart?.(runId, route.sessionKey);
          },
        },
        record: {
          onRecordError: (err) => {
            deps.log.warn('session meta was not recorded', { error: err instanceof Error ? err.message : String(err) });
          },
        },
      }),
    },
  });
}
