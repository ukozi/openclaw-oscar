import { AsyncLocalStorage } from 'node:async_hooks';
import { createTypingCallbacks } from 'openclaw/plugin-sdk/channel-reply-pipeline';
import type { TypingCallbacks } from 'openclaw/plugin-sdk/channel-reply-pipeline';
import { chunkText } from 'openclaw/plugin-sdk/reply-chunking';
import { fallbackFor, sendByFallback } from './fallback.js';
import { ROOM_CHUNK_MAX, defaultAccountId, readPolicy, resolveAccount } from './config.js';
import { formatTarget, normalizeName, parseTarget } from './names.js';
import type { RoomRef, Target } from './names.js';
import type { SendPriority, SendReceipt } from './oscar/index.js';
import { guardRoll, htmlToText, toAsciiEntities, toWireHtml } from './oscar/text.js';
import { outboundProblem, roleOf } from './policy.js';
import { getRuntime, joinedRooms, liveConfig, roomKey } from './runtime.js';
import type { AccountRuntime } from './runtime.js';

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
  const joined = rt ? joinedRooms(rt) : [];
  const problem = outboundProblem(target, readPolicy(cfg), joined);
  if (problem) return { ok: false, error: new Error(problem) };
  return { ok: true, accountId, target, to: formatTarget(target) };
}

export async function sendWire(p: { cfg: unknown; accountId?: string | null; to: string; html: string }): Promise<{ messageId: string; chatId: string }> {
  const checked = checkTarget(p);
  if (!checked.ok) throw checked.error;
  const rt = getRuntime(checked.accountId);
  if (!rt || rt.halted) throw new Error(`account ${checked.accountId} is not signed on`);
  if (checked.target.kind === 'room') {
    try {
      const limit = resolveAccount(liveConfig(p.cfg), checked.accountId).roomTextChunkLimit;
      const receipts = await sendRoomHtml(checked.accountId, checked.target.room, p.html, limit);
      return { messageId: receipts[receipts.length - 1]?.id ?? '', chatId: checked.to };
    } catch (err) {
      rt.counters.droppedSends += 1;
      throw err;
    }
  }
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

async function viaFallback(cfg: unknown, accountId: string | null | undefined, to: string, text: string): Promise<string | null> {
  const checked = checkTarget({ cfg, accountId, to });
  if (!checked.ok) return null;
  const decision = fallbackFor(cfg, checked.accountId, checked.target);
  if (!decision || !(await sendByFallback(cfg, checked.accountId, decision, text))) return null;
  if ((priorityScope.getStore() ?? 'reply') === 'reply' && checked.target.kind === 'im') {
    getRuntime(checked.accountId)?.lastReplyAt.set(checked.target.name, Date.now());
  }
  return `fallback:${decision.route.channel}`;
}

export async function sendMarkdown(p: { cfg: unknown; accountId?: string | null; to: string; markdown: string; kind?: OutboundKind }): Promise<{ messageIds: string[] }> {
  const cfg = liveConfig(p.cfg);
  const markdown = await filtered({ cfg, accountId: p.accountId, to: p.to }, p.kind ?? 'final', 'markdown', p.markdown);
  if (markdown === null) return { messageIds: [] };
  const limit = resolveAccount(cfg, p.accountId).textChunkLimit;
  const checked = checkTarget({ cfg, accountId: p.accountId, to: p.to });
  if (checked.ok && checked.target.kind === 'room') {
    const sent = await sendWire({ cfg, accountId: p.accountId, to: p.to, html: toWireHtml(markdown) });
    return { messageIds: sent.messageId === '' ? [] : [sent.messageId] };
  }
  const rerouted = await viaFallback(cfg, p.accountId, p.to, markdown);
  if (rerouted) return { messageIds: [rerouted] };
  const messageIds: string[] = [];
  for (const chunk of chunkText(toWireHtml(markdown), limit)) {
    if (chunk.trim().length === 0) continue;
    messageIds.push((await sendWire({ cfg, accountId: p.accountId, to: p.to, html: chunk })).messageId);
  }
  return { messageIds };
}

export async function sendAutoReply(p: { cfg: unknown; accountId: string; to: string; text: string }): Promise<boolean> {
  const cfg = liveConfig(p.cfg);
  const checked = checkTarget({ cfg, accountId: p.accountId, to: p.to });
  if (!checked.ok || checked.target.kind !== 'im') return false;
  const rt = getRuntime(checked.accountId);
  if (!rt || rt.halted) return false;
  await rt.session.sendIm(checked.target.name, toWireHtml(p.text), { priority: 'notice', auto: true });
  return true;
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
  const rerouted = await viaFallback(ctx.cfg, ctx.accountId, ctx.to, htmlToText(html));
  if (rerouted) return { messageId: rerouted, chatId: ctx.to };
  return sendWire({ cfg: ctx.cfg, accountId: ctx.accountId, to: ctx.to, html });
}

const WIRE_ATOM = /<A\b[^>]*>[\s\S]*?<\/A>|<[^>]*>|&#?[A-Za-z0-9]+;|[\s\S]/giu;
const MIN_CHUNK_LIMIT = 64;
// The room info the server sends advertises a 1024-byte message limit (state/chat.go:109).
export const ROOM_WIRE_MAX = ROOM_CHUNK_MAX;

function isBreak(atom: string): boolean {
  return atom === ' ' || atom === '\n' || /^<br\s*\/?>$/i.test(atom);
}

export function splitWireHtml(html: string, limit: number): string[] {
  if (limit < MIN_CHUNK_LIMIT) throw new RangeError(`chunk limit ${limit} is below ${MIN_CHUNK_LIMIT}`);
  const budget = limit - 1;
  const atoms = html.match(WIRE_ATOM) ?? [];
  const chunks: string[] = [];
  let current: string[] = [];
  let length = 0;
  let lastBreak = -1;
  const cut = (upTo: number): void => {
    chunks.push(current.slice(0, upTo).join(''));
    current = current.slice(upTo);
    length = 0;
    lastBreak = -1;
    current.forEach((atom, i) => {
      length += atom.length;
      if (isBreak(atom)) lastBreak = i;
    });
  };
  for (const atom of atoms) {
    while (length + atom.length > budget && current.length > 0) cut(lastBreak >= 0 ? lastBreak + 1 : current.length);
    current.push(atom);
    length += atom.length;
    if (isBreak(atom)) lastBreak = current.length - 1;
  }
  if (current.length > 0) chunks.push(current.join(''));
  // Trimming takes off the space guardRoll may have put in front of //roll, and a cut can make a
  // later line the start of a message, so the guard runs last, on every chunk.
  return chunks
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk !== '')
    .map(guardRoll);
}

function notOnline(accountId: string): Error {
  return Object.assign(new Error(`${accountId} is not signed on`), { code: 'not-online' as const });
}

function noteOwnLine(rt: AccountRuntime, room: RoomRef): void {
  const state = rt.rooms.get(roomKey(room));
  if (!state) return;
  state.lastBotLine = { from: normalizeName(rt.session.selfInfo()?.screenName ?? rt.accountId), at: Date.now() };
}

export async function sendRoomHtml(accountId: string, room: RoomRef, html: string, limit: number): Promise<SendReceipt[]> {
  const rt = getRuntime(accountId);
  if (!rt) throw notOnline(accountId);
  const receipts: SendReceipt[] = [];
  for (const chunk of splitWireHtml(toAsciiEntities(html), Math.min(limit, ROOM_WIRE_MAX))) {
    receipts.push(await rt.session.sendRoom(room, chunk, { priority: 'reply' }));
    noteOwnLine(rt, room);
  }
  return receipts;
}

export async function sendRoomLine(
  accountId: string,
  room: RoomRef,
  markdown: string,
  opts: { whisperTo?: string; priority?: SendPriority } = {},
): Promise<SendReceipt> {
  const rt = getRuntime(accountId);
  if (!rt) throw notOnline(accountId);
  const html = guardRoll(toAsciiEntities(toWireHtml(markdown)));
  const sendOpts: { whisperTo?: string; priority: SendPriority } = { priority: opts.priority ?? 'reply' };
  if (opts.whisperTo !== undefined) sendOpts.whisperTo = opts.whisperTo;
  const receipt = await rt.session.sendRoom(room, html, sendOpts);
  if (opts.whisperTo === undefined) noteOwnLine(rt, room);
  return receipt;
}
