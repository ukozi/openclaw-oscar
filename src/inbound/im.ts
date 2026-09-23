import { resolveStableChannelMessageIngress } from 'openclaw/plugin-sdk/channel-ingress-runtime';
import type { ResolveStableChannelMessageIngressParams } from 'openclaw/plugin-sdk/channel-ingress-runtime';
import { CHANNEL_ID, buddyList, readPolicy } from '../config.js';
import type { RootPolicy } from '../config.js';
import { normalizeName } from '../names.js';
import type { ContactAttempt } from '../notice.js';
import type { ImEvent, Logger } from '../oscar/index.js';
import { roleOf } from '../policy.js';
import type { Timers } from '../runtime.js';
import type { ImTurn } from './turn.js';

export const IM_TIMING = { debounceMs: 2000, replyCooldownMs: 2000, replaySettleMs: 3000, dedupeMs: 60_000, replayMaxAgeMs: 4 * 3600_000 };

const SYSTEM_SENDER = 'oossystemmsg';
const REPEAT_WINDOW = 3;

export type ImControlHandler = (ev: ImEvent) => 'handled' | 'pass';

const controlHandlers = new Map<string, ImControlHandler>();

export function setImControlHandler(accountId: string, fn: ImControlHandler | null): void {
  if (fn) controlHandlers.set(accountId, fn);
  else controlHandlers.delete(accountId);
}

export function ingressParams(accountId: string, from: string, policy: RootPolicy): ResolveStableChannelMessageIngressParams {
  return {
    channelId: CHANNEL_ID,
    accountId,
    identity: { key: 'oscar-screen-name', normalize: (value: string) => normalizeName(value) || null, entryIdPrefix: 'oscar-entry' },
    subject: { stableId: from },
    conversation: { kind: 'direct', id: from },
    event: { kind: 'message', authMode: 'inbound', mayPair: false },
    dmPolicy: policy.dmPolicy,
    groupPolicy: 'disabled',
    // Under "open" the host's gate still wants a "*" in the list before it admits a stranger.
    allowFrom: policy.dmPolicy === 'open' ? [...policy.allowFrom, '*'] : [...policy.allowFrom],
    useDefaultPairingStore: false,
    command: false,
  };
}

export async function admitSender(accountId: string, from: string, policy: RootPolicy): Promise<boolean> {
  const result = await resolveStableChannelMessageIngress(ingressParams(accountId, from, policy));
  return result.senderAccess.decision === 'allow';
}

export type ImDeps = {
  accountId: string; self: () => string; getCfg: () => unknown; now: () => number; timers: Timers; log: Logger;
  admit: (from: string, policy: RootPolicy) => Promise<boolean>;
  dispatch: (turn: ImTurn) => Promise<void>;
  contact: (a: ContactAttempt) => void;
  replayed: (list: ContactAttempt[]) => void;
  lastReplyAt: (peer: string) => number | undefined;
  contacted?: (peer: string) => void;
  updateBuddies: () => void;
};

type Burst = { display: string; texts: string[]; cookie: bigint; timer?: ReturnType<typeof setTimeout> };
type Replay = { display: string; items: { text: string; ageSeconds: number | null }[] };

export function createImHandler(deps: ImDeps): { onIm(ev: ImEvent): void; stop(): void; idle(): Promise<void> } {
  const seen = new Map<string, number>();
  const bodies = new Map<string, string[]>();
  const bursts = new Map<string, Burst>();
  const held = new Set<ReturnType<typeof setTimeout>>();
  const dispatchTails = new Map<string, Promise<void>>();
  const replay = new Map<string, Replay>();
  let replayStrangers: ContactAttempt[] = [];
  let replayTimer: ReturnType<typeof setTimeout> | undefined;
  let buddySignature: string | undefined;
  let tail: Promise<void> = Promise.resolve();
  let stopped = false;

  const dispatch = (turn: ImTurn): void => {
    const previous = dispatchTails.get(turn.from) ?? Promise.resolve();
    const next = previous.then(() => (stopped ? undefined : deps.dispatch(turn))).catch((err: unknown) => {
      deps.log.error('turn failed', { from: turn.from, error: err instanceof Error ? err.message : String(err) });
    });
    dispatchTails.set(turn.from, next);
  };

  const cooldownLeft = (peer: string): number => {
    const last = deps.lastReplyAt(peer);
    return last === undefined ? 0 : Math.max(0, last + IM_TIMING.replyCooldownMs - deps.now());
  };

  const flush = (peer: string): void => {
    const burst = bursts.get(peer);
    if (!burst) return;
    if (burst.timer) deps.timers.clearTimeout(burst.timer);
    bursts.delete(peer);
    dispatch({ from: peer, fromDisplay: burst.display, text: burst.texts.join('\n'), cookie: burst.cookie, at: deps.now() });
  };

  const holdAlone = (ev: ImEvent, delay: number): void => {
    const timer = deps.timers.setTimeout(() => {
      held.delete(timer);
      dispatch({ from: ev.from, fromDisplay: ev.fromDisplay, text: ev.text, cookie: ev.cookie, at: deps.now() });
    }, delay);
    held.add(timer);
  };

  const addToBurst = (ev: ImEvent, delay: number): void => {
    const burst = bursts.get(ev.from) ?? { display: ev.fromDisplay, texts: [], cookie: ev.cookie };
    if (burst.timer) deps.timers.clearTimeout(burst.timer);
    burst.texts.push(ev.text);
    burst.timer = deps.timers.setTimeout(() => flush(ev.from), delay);
    bursts.set(ev.from, burst);
  };

  const settleReplay = (): void => {
    replayTimer = undefined;
    for (const [peer, r] of replay) {
      dispatch({ from: peer, fromDisplay: r.display, text: r.items.map((i) => i.text).join('\n'), cookie: 0n, at: deps.now(), replayed: r.items });
    }
    replay.clear();
    if (replayStrangers.length > 0) deps.replayed(replayStrangers);
    replayStrangers = [];
  };

  const armReplay = (): void => {
    if (replayTimer) deps.timers.clearTimeout(replayTimer);
    replayTimer = deps.timers.setTimeout(settleReplay, IM_TIMING.replaySettleMs);
  };

  const isDuplicate = (ev: ImEvent): boolean => {
    if (ev.cookie === 0n) return false;
    const now = deps.now();
    for (const [key, at] of seen) if (now - at >= IM_TIMING.dedupeMs) seen.delete(key);
    const key = `${ev.from}:${ev.cookie}`;
    if (seen.has(key)) return true;
    seen.set(key, now);
    return false;
  };

  const isRepeat = (ev: ImEvent): boolean => {
    const history = bodies.get(ev.from) ?? [];
    if (history.length === REPEAT_WINDOW && history.every((b) => b === ev.text)) return true;
    history.push(ev.text);
    if (history.length > REPEAT_WINDOW) history.shift();
    bodies.set(ev.from, history);
    return false;
  };

  const handle = async (ev: ImEvent): Promise<void> => {
    if (stopped) return;
    const policy = readPolicy(deps.getCfg());
    const self = normalizeName(deps.self());
    const signature = buddyList(policy, self).join(',');
    if (buddySignature !== undefined && buddySignature !== signature) deps.updateBuddies();
    buddySignature = signature;

    const from = normalizeName(ev.from);
    if (ev.system && from === SYSTEM_SENDER) {
      deps.log.debug('dropped a server notice');
      return;
    }
    if (from === self) return;
    if (controlHandlers.get(deps.accountId)?.({ ...ev, from }) === 'handled') return;
    if (roleOf(from, policy) === 'bot') return;
    if (ev.autoResponse) {
      deps.log.debug('dropped an auto-response', { from });
      return;
    }

    const event: ImEvent = { ...ev, from };
    if (!(await deps.admit(from, policy))) {
      const attempt: ContactAttempt = { name: from, display: ev.fromDisplay, kind: 'im', at: deps.now() };
      if (ev.offline) {
        replayStrangers.push(attempt);
        armReplay();
      } else {
        deps.contact(attempt);
      }
      return;
    }
    if (stopped || isDuplicate(event)) return;

    if (ev.offline) {
      const ageMs = ev.sentAt === undefined ? null : Math.max(0, deps.now() - ev.sentAt);
      if (ageMs !== null && ageMs > IM_TIMING.replayMaxAgeMs) {
        deps.log.info('dropped a stale offline message', { from, ageHours: Math.round(ageMs / 3600_000) });
      } else {
        const r = replay.get(from) ?? { display: ev.fromDisplay, items: [] };
        r.items.push({ text: ev.text, ageSeconds: ageMs === null ? null : Math.round(ageMs / 1000) });
        replay.set(from, r);
      }
      armReplay();
      return;
    }
    deps.contacted?.(from);

    if (ev.text.trimStart().startsWith('/')) {
      flush(from);
      const wait = cooldownLeft(from);
      if (wait === 0) dispatch({ from, fromDisplay: ev.fromDisplay, text: ev.text, cookie: ev.cookie, at: deps.now() });
      else holdAlone(event, wait);
      return;
    }
    if (isRepeat(event)) {
      deps.log.info('loop guard dropped a repeated message', { from });
      return;
    }
    addToBurst(event, Math.max(IM_TIMING.debounceMs, cooldownLeft(from)));
  };

  return {
    onIm(ev: ImEvent): void {
      tail = tail.then(() => handle(ev)).catch((err: unknown) => {
        deps.log.error('inbound handling failed', { error: err instanceof Error ? err.message : String(err) });
      });
    },
    stop(): void {
      stopped = true;
      for (const burst of bursts.values()) if (burst.timer) deps.timers.clearTimeout(burst.timer);
      bursts.clear();
      for (const timer of held) deps.timers.clearTimeout(timer);
      held.clear();
      if (replayTimer) deps.timers.clearTimeout(replayTimer);
      replay.clear();
      replayStrangers = [];
    },
    async idle(): Promise<void> {
      await tail;
      await Promise.all([...dispatchTails.values()]);
    },
  };
}
