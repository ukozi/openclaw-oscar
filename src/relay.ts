import type { OpenClawConfig } from 'openclaw/plugin-sdk/channel-core';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';
import { resolveAgentRoute } from 'openclaw/plugin-sdk/routing';
import { CHANNEL_ID, listAccountIds, readPolicy, resolveAccount } from './config.js';
import { encodePeerId, normalizeName } from './names.js';
import { sendMarkdown } from './outbound.js';
import { liveConfig } from './runtime.js';

export const RELAY_DEDUPE_MS = 600_000;
export const SKIP_TOKENS = ['ANNOUNCE_SKIP', 'REPLY_SKIP', 'NO_REPLY', 'HEARTBEAT_OK'];
const ANNOUNCE_MARKER = 'Agent-to-agent announce step';

function textOf(message: unknown): string {
  const content = (message as { content?: unknown } | null)?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part): part is { type: 'text'; text: string } =>
      (part as { type?: unknown })?.type === 'text' && typeof (part as { text?: unknown }).text === 'string')
    .map((part) => part.text)
    .join('');
}

function lastOf(messages: unknown[], role: string): unknown {
  for (let i = messages.length - 1; i >= 0; i--) {
    if ((messages[i] as { role?: unknown } | null)?.role === role) return messages[i];
  }
  return undefined;
}

function accountForAgent(cfg: unknown, agentId: string): string | null {
  const owners = readPolicy(cfg).owners;
  for (const accountId of listAccountIds(cfg)) {
    const bot = resolveAccount(cfg, accountId).screenName;
    const peerId = encodePeerId({ kind: 'im', bot, peer: owners[0] ?? bot });
    const route = resolveAgentRoute({ cfg: cfg as OpenClawConfig, channel: CHANNEL_ID, accountId, peer: { kind: 'group', id: peerId } });
    if (route.agentId === agentId) return accountId;
  }
  return null;
}

export function relayDecision(p: { cfg: unknown; agentId?: string; sessionKey?: string; messages: unknown[] }): { accountId: string; text: string } | null {
  if (!p.agentId || p.sessionKey?.includes(`:${CHANNEL_ID}:`)) return null;
  if (!textOf(lastOf(p.messages, 'user')).includes(ANNOUNCE_MARKER)) return null;
  const text = textOf(lastOf(p.messages, 'assistant')).trim();
  if (text.length === 0 || SKIP_TOKENS.some((token) => text.startsWith(token))) return null;
  const accountId = accountForAgent(p.cfg, p.agentId);
  return accountId ? { accountId, text } : null;
}

export function registerAnnounceRelay(api: Pick<OpenClawPluginApi, 'on' | 'logger'>): void {
  const seenRuns = new Map<string, number>();
  const seenTexts = new Map<string, number>();
  const prune = (seen: Map<string, number>, now: number): void => {
    for (const [key, at] of seen) if (now - at >= RELAY_DEDUPE_MS) seen.delete(key);
  };
  api.on('agent_end', (event, ctx) => {
    const cfg = liveConfig(undefined);
    const decision = relayDecision({ cfg, agentId: ctx.agentId, sessionKey: ctx.sessionKey, messages: event.messages });
    if (!decision) return;
    const now = Date.now();
    prune(seenRuns, now);
    prune(seenTexts, now);
    // 2026.7.1-2 sets runId on the hook context only.
    const runId = event.runId ?? ctx.runId;
    if (runId) {
      if (seenRuns.has(runId)) return;
      seenRuns.set(runId, now);
    }
    const bot = normalizeName(resolveAccount(cfg, decision.accountId).screenName);
    for (const owner of readPolicy(cfg).owners) {
      if (owner === bot) continue;
      const key = `${decision.accountId}\n${owner}\n${decision.text}`;
      if (seenTexts.has(key)) continue;
      seenTexts.set(key, now);
      sendMarkdown({ cfg, accountId: decision.accountId, to: owner, markdown: decision.text }).catch((err: unknown) => {
        api.logger.warn(`announce reply was not relayed to ${owner}: ${String(err)}`);
      });
    }
  });
}
