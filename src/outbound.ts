import { AsyncLocalStorage } from 'node:async_hooks';
import { createTypingCallbacks } from 'openclaw/plugin-sdk/channel-reply-pipeline';
import type { TypingCallbacks } from 'openclaw/plugin-sdk/channel-reply-pipeline';
import { chunkText } from 'openclaw/plugin-sdk/reply-chunking';
import { defaultAccountId, readPolicy, resolveAccount } from './config.js';
import { formatTarget, parseTarget } from './names.js';
import type { Target } from './names.js';
import type { SendPriority } from './oscar/index.js';
import { toWireHtml } from './oscar/text.js';
import { outboundProblem, roleOf } from './policy.js';
import { getRuntime, liveConfig } from './runtime.js';

const TYPING_KEEPALIVE_MS = 8000;
const TYPING_MAX_MS = 120_000;

const priorityScope = new AsyncLocalStorage<SendPriority>();

export function withPriority<T>(priority: SendPriority, fn: () => Promise<T>): Promise<T> {
  return priorityScope.run(priority, fn);
}

export type OutboundKind = 'final' | 'block' | 'tool' | 'send' | 'plugin';
export type OutboundFormat = 'markdown' | 'wire';
export type OutboundMeta = { accountId: string; target: Target; kind: OutboundKind; format?: OutboundFormat };
export type OutboundTextFilter = (meta: OutboundMeta, body: string) => Promise<string | null> | string | null;

const textFilters = new Map<string, OutboundTextFilter>();

export function setOutboundTextFilter(accountId: string, filter: OutboundTextFilter | null): void {
  if (filter) textFilters.set(accountId, filter);
  else textFilters.delete(accountId);
}

export type CheckedTarget = { ok: true; accountId: string; target: Target; to: string } | { ok: false; error: Error };

export function checkTarget(p: { cfg: unknown; accountId?: string | null; to: string }): CheckedTarget {
  const cfg = liveConfig(p.cfg);
  const accountId = p.accountId && p.accountId.length > 0 ? p.accountId : defaultAccountId(cfg);
  const rt = getRuntime(accountId);
  const bot = rt?.session.selfInfo()?.screenName ?? resolveAccount(cfg, accountId).screenName;
  const target = parseTarget(p.to, bot);
  if (!target) return { ok: false, error: new Error(`"${p.to}" is not a screen name or room this account can address`) };
  const joined = [...(rt?.rooms.values() ?? [])].map((room) => room.ref);
  const problem = outboundProblem(target, readPolicy(cfg), joined);
  if (problem) return { ok: false, error: new Error(problem) };
  return { ok: true, accountId, target, to: formatTarget(target) };
}

export async function sendWire(p: { cfg: unknown; accountId?: string | null; to: string; html: string }): Promise<{ messageId: string; chatId: string }> {
  const checked = checkTarget(p);
  if (!checked.ok) throw checked.error;
  const rt = getRuntime(checked.accountId);
  if (!rt || rt.halted) throw new Error(`account ${checked.accountId} is not signed on`);
  if (checked.target.kind !== 'im') throw new Error(`not in room ${checked.target.room.name}`);
  const priority = priorityScope.getStore() ?? 'reply';
  try {
    const receipt = await rt.session.sendIm(checked.target.name, p.html, { priority });
    if (priority === 'reply') rt.lastReplyAt.set(checked.target.name, Date.now());
    return { messageId: receipt.id, chatId: checked.to };
  } catch (err) {
    rt.counters.droppedSends += 1;
    throw err;
  }
}

async function filtered(
  p: { cfg: unknown; accountId?: string | null; to: string },
  kind: OutboundKind,
  format: OutboundFormat,
  body: string,
): Promise<string | null> {
  if ((priorityScope.getStore() ?? 'reply') !== 'reply') return body;
  const checked = checkTarget(p);
  if (!checked.ok) return body;
  const filter = textFilters.get(checked.accountId);
  return filter ? filter({ accountId: checked.accountId, target: checked.target, kind, format }, body) : body;
}

export async function sendMarkdown(p: { cfg: unknown; accountId?: string | null; to: string; markdown: string; kind?: OutboundKind }): Promise<{ messageIds: string[] }> {
  const cfg = liveConfig(p.cfg);
  const markdown = await filtered({ cfg, accountId: p.accountId, to: p.to }, p.kind ?? 'final', 'markdown', p.markdown);
  if (markdown === null) return { messageIds: [] };
  const limit = resolveAccount(cfg, p.accountId).textChunkLimit;
  const messageIds: string[] = [];
  for (const chunk of chunkText(toWireHtml(markdown), limit)) {
    if (chunk.trim().length === 0) continue;
    messageIds.push((await sendWire({ cfg, accountId: p.accountId, to: p.to, html: chunk })).messageId);
  }
  return { messageIds };
}

export function typingFor(p: { cfg: unknown; accountId: string; peer: string }): TypingCallbacks | undefined {
  const cfg = liveConfig(p.cfg);
  if (!resolveAccount(cfg, p.accountId).typing) return undefined;
  const role = roleOf(p.peer, readPolicy(cfg));
  if (role !== 'owner' && role !== 'approved') return undefined;
  const send = (state: 'typing' | 'none') => async (): Promise<void> => {
    getRuntime(p.accountId)?.session.sendTyping(p.peer, state);
  };
  return createTypingCallbacks({
    start: send('typing'),
    stop: send('none'),
    onStartError: () => undefined,
    keepaliveIntervalMs: TYPING_KEEPALIVE_MS,
    maxDurationMs: TYPING_MAX_MS,
  });
}

export const outboundBase = {
  deliveryMode: 'gateway' as const,
  chunker: chunkText,
  chunkerMode: 'text' as const,
  textChunkLimit: 1800,
  sanitizeText: (p: { text: string }): string => toWireHtml(p.text),
  resolveTarget: (p: { cfg?: unknown; to?: string; accountId?: string | null }): { ok: true; to: string } | { ok: false; error: Error } => {
    const checked = checkTarget({ cfg: p.cfg, accountId: p.accountId, to: p.to ?? '' });
    return checked.ok ? { ok: true, to: checked.to } : { ok: false, error: checked.error };
  },
};

export async function sendAdapterText(ctx: { cfg: unknown; to: string; text: string; accountId?: string | null }): Promise<{ messageId: string; chatId: string }> {
  const html = await filtered(ctx, 'send', 'wire', ctx.text);
  if (html === null) return { messageId: '', chatId: ctx.to };
  return sendWire({ cfg: ctx.cfg, accountId: ctx.accountId, to: ctx.to, html });
}
