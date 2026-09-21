import type { OpenClawConfig } from 'openclaw/plugin-sdk/channel-core';
import { sendDurableMessageBatch } from 'openclaw/plugin-sdk/channel-outbound';
import { resolveAgentRoute } from 'openclaw/plugin-sdk/routing';
import { CHANNEL_ID, readPolicy } from './config.js';
import { copy } from './copy.js';
import { encodePeerId, isAsciiName, normalizeName } from './names.js';
import type { Logger, Presence } from './oscar/index.js';
import { withPriority } from './outbound.js';
import type { Timers } from './runtime.js';

export const NOTICE_TIMING = { windowMs: 3600_000 };
const RING_SIZE = 20;

export type ContactKind = 'im' | 'invite';
export type ContactAttempt = { name: string; display: string; kind: ContactKind; at: number };
export type ContactRingEntry = { name: string; kind: ContactKind; firstAt: number; lastAt: number; count: number; oddName: boolean };
export type NoticeDeps = {
  self: () => string; getCfg: () => unknown; now: () => number; timers: Timers; log: Logger;
  presenceOf: (name: string) => Presence | undefined;
  send: (p: { owner: string; text: string }) => Promise<void>;
};
export interface Notices {
  contact(a: ContactAttempt): void;
  replayed(list: ContactAttempt[]): void;
  ownerPresence(name: string, online: boolean): void;
  ring(): ContactRingEntry[];
  stop(): void;
  idle(): Promise<void>;
}

export function createNotices(deps: NoticeDeps): Notices {
  const lastNoticeAt = new Map<string, number>();
  const storedWhileOffline = new Set<string>();
  const pending = new Map<string, number>();
  const ring: ContactRingEntry[] = [];
  let windowStart: number | undefined;
  let sentInWindow = 0;
  let windowTimer: ReturnType<typeof setTimeout> | undefined;
  let work: Promise<void> = Promise.resolve();

  const owners = (): string[] => readPolicy(deps.getCfg()).owners.filter((name) => name !== normalizeName(deps.self()));
  const isOnline = (owner: string): boolean => deps.presenceOf(owner)?.online === true;

  const enqueue = (owner: string, text: string): void => {
    work = work.then(() => deps.send({ owner, text })).catch((err: unknown) => {
      deps.log.warn('notice was not delivered', { owner, error: err instanceof Error ? err.message : String(err) });
    });
  };

  const flushPending = (owner: string): void => {
    const n = pending.get(owner) ?? 0;
    if (n === 0) return;
    pending.delete(owner);
    enqueue(owner, copy.noticeRollup(n));
  };

  const closeWindow = (): void => {
    windowStart = undefined;
    sentInWindow = 0;
    windowTimer = undefined;
    for (const owner of owners()) if (isOnline(owner)) flushPending(owner);
  };

  const openWindow = (): void => {
    if (windowStart !== undefined && deps.now() - windowStart < NOTICE_TIMING.windowMs) return;
    if (windowTimer) deps.timers.clearTimeout(windowTimer);
    if (windowStart !== undefined) closeWindow();
    windowStart = deps.now();
    windowTimer = deps.timers.setTimeout(closeWindow, NOTICE_TIMING.windowMs);
  };

  const remember = (a: ContactAttempt): void => {
    const name = normalizeName(a.name);
    const newest = ring[ring.length - 1];
    if (newest && newest.name === name && newest.kind === a.kind) {
      newest.lastAt = a.at;
      newest.count += 1;
      return;
    }
    ring.push({ name, kind: a.kind, firstAt: a.at, lastAt: a.at, count: 1, oddName: !isAsciiName(a.display) || !isAsciiName(name) });
    if (ring.length > RING_SIZE) ring.shift();
  };

  const notify = (a: ContactAttempt, others: number): void => {
    const name = normalizeName(a.name);
    const policy = readPolicy(deps.getCfg());
    const recipients = owners();
    if (recipients.length === 0) return;
    const last = lastNoticeAt.get(name);
    if (last !== undefined && deps.now() - last < policy.contactNotice.cooldownHours * 3600_000) return;
    lastNoticeAt.set(name, deps.now());
    openWindow();

    const due = recipients.filter((owner) => isOnline(owner) || !storedWhileOffline.has(owner));
    const counted = recipients.filter((owner) => !due.includes(owner));
    const room = sentInWindow + due.length <= policy.contactNotice.maxPerHour;
    for (const owner of room ? counted : recipients) pending.set(owner, (pending.get(owner) ?? 0) + 1 + others);
    if (!room) return;

    const odd = !isAsciiName(a.display) || !isAsciiName(name);
    const viaChat = (deps.getCfg() as { commands?: { config?: unknown } } | undefined)?.commands?.config === true;
    const lines = [a.kind === 'invite' ? copy.noticeInvite(name) : copy.noticeIm(name)];
    lines.push(odd ? copy.noticeOddName() : copy.noticeApprove(name, viaChat));
    if (others > 0) lines.push(copy.noticeRollup(others));
    const text = lines.join('\n');
    sentInWindow += due.length;
    for (const owner of due) {
      if (!isOnline(owner)) storedWhileOffline.add(owner);
      enqueue(owner, text);
    }
  };

  return {
    contact(a: ContactAttempt): void {
      remember(a);
      notify(a, 0);
    },
    replayed(list: ContactAttempt[]): void {
      const policy = readPolicy(deps.getCfg());
      const fresh: ContactAttempt[] = [];
      for (const a of list) {
        remember(a);
        const name = normalizeName(a.name);
        const last = lastNoticeAt.get(name);
        const cooling = last !== undefined && deps.now() - last < policy.contactNotice.cooldownHours * 3600_000;
        if (!cooling && !fresh.some((f) => normalizeName(f.name) === name)) fresh.push(a);
      }
      const first = fresh[0];
      if (!first) return;
      for (const a of fresh.slice(1)) lastNoticeAt.set(normalizeName(a.name), deps.now());
      notify(first, fresh.length - 1);
    },
    ownerPresence(name: string, online: boolean): void {
      const owner = normalizeName(name);
      if (!owners().includes(owner)) return;
      if (!online) return;
      storedWhileOffline.delete(owner);
      flushPending(owner);
    },
    ring: () => ring.map((entry) => ({ ...entry })),
    stop(): void {
      if (windowTimer) deps.timers.clearTimeout(windowTimer);
      windowTimer = undefined;
    },
    idle: () => work,
  };
}

export async function sendNotice(p: { cfg: unknown; accountId: string; bot: string; owner: string; text: string }): Promise<void> {
  const cfg = p.cfg as OpenClawConfig;
  const peerId = encodePeerId({ kind: 'im', bot: p.bot, peer: p.owner });
  const route = resolveAgentRoute({ cfg, channel: CHANNEL_ID, accountId: p.accountId, peer: { kind: 'group', id: peerId } });
  const result = await withPriority('notice', () => sendDurableMessageBatch({
    cfg,
    channel: CHANNEL_ID,
    to: p.owner,
    accountId: p.accountId,
    payloads: [{ text: p.text }],
    bestEffort: true,
    durability: 'best_effort',
    mirror: { sessionKey: route.sessionKey, agentId: route.agentId, text: p.text },
  }));
  if (result.status === 'failed') throw result.error instanceof Error ? result.error : new Error('notice send failed');
}
