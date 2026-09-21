import type { AwayConfig } from '../config.js';
import { copy } from '../copy.js';
import type { Logger, OscarSession } from '../oscar/index.js';
import { capText, filterBlurb, foldAscii, phraseForTool } from './blurb.js';
import type { RunTracker } from './runs.js';

export type LineVerdict =
  | { accepted: true; shown: string }
  | { accepted: false; reason: 'off' | 'no-run' | 'limit' | 'unsafe' };

export interface AwayController {
  noteInbound(sessionKey: string, text: string): void;
  noteTool(runId: string, toolName: string): void;
  offerLine(runId: string, raw: string, toolCallId?: string): LineVerdict;
  verdictFor(toolCallId: string): LineVerdict | undefined;
  current(): string | null;
  stop(): Promise<void>;
}

export type AwayDeps = {
  accountId: string;
  tracker: Pick<RunTracker, 'on' | 'onRun' | 'isBusy' | 'reset'>;
  session: Pick<OscarSession, 'setAway' | 'getState' | 'on'>;
  config: () => AwayConfig;
  forbidden: () => string[];
  summarize?: (text: string, signal: AbortSignal) => Promise<string>;
  log: Logger;
  minUpdateMs?: number;
  summarizeTimeoutMs?: number;
};

export function operatorAwayText(cfg: AwayConfig): string {
  return capText(foldAscii(cfg.message), cfg.maxLength) || capText(copy.awayDefault(), cfg.maxLength);
}

export const MAX_LINE_CHANGES = 2;
const MIN_UPDATE_MS = 5000;
const SUMMARIZE_TIMEOUT_MS = 15_000;
const CLEAR_RETRY_MS = 5000;
const CLEAR_RETRIES = 5;
const VERDICT_LIMIT = 64;
const INBOUND_LIMIT = 200;

type RunBlurb = {
  agentLine?: string; summary?: string; phrase?: string;
  changes: number; touchedAt: number; abort?: AbortController;
};

export function createAwayController(deps: AwayDeps): AwayController {
  const { accountId, tracker, session, log } = deps;
  const minUpdateMs = deps.minUpdateMs ?? MIN_UPDATE_MS;
  const summarizeTimeoutMs = deps.summarizeTimeoutMs ?? SUMMARIZE_TIMEOUT_MS;
  const blurbs = new Map<string, RunBlurb>();
  const inbound = new Map<string, string>();
  const verdicts = new Map<string, LineVerdict>();
  let wire: string | null = null;
  let lastSetAt = 0;
  let chain: Promise<void> = Promise.resolve();
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let updateTimer: ReturnType<typeof setTimeout> | undefined;
  let clearTimer: ReturnType<typeof setTimeout> | undefined;
  let clearRetries = 0;
  let stopped = false;
  let lastPhase = session.getState().phase;

  function stopTimer(timer: ReturnType<typeof setTimeout> | undefined): undefined {
    if (timer) clearTimeout(timer);
    return undefined;
  }

  function pickText(cfg: AwayConfig): string {
    const live = [...blurbs.values()].sort((a, b) => b.touchedAt - a.touchedAt);
    for (const blurb of live) {
      const line =
        (cfg.blurb !== 'phrases' ? blurb.agentLine : undefined) ??
        (cfg.blurb === 'summarize' ? blurb.summary : undefined) ??
        blurb.phrase;
      if (line) return capText(line, cfg.maxLength) || operatorAwayText(cfg);
    }
    return operatorAwayText(cfg);
  }

  function push(text: string | null): void {
    wire = text;
    if (text !== null) lastSetAt = Date.now();
    chain = chain
      .then(() => session.setAway(text))
      .then(() => {
        if (text === null) clearRetries = 0;
      })
      .catch((err: unknown) => {
        log.debug('away update failed', { accountId, error: String(err) });
        if (text !== null) {
          if (wire === text) wire = null;
          return;
        }
        if (stopped || session.getState().phase !== 'online' || clearRetries >= CLEAR_RETRIES) return;
        clearRetries += 1;
        clearTimer = stopTimer(clearTimer);
        clearTimer = setTimeout(() => {
          clearTimer = undefined;
          if (!stopped && !tracker.isBusy(accountId) && wire === null) push(null);
        }, CLEAR_RETRY_MS);
        clearTimer.unref?.();
      });
  }

  function refresh(): void {
    if (stopped || graceTimer || !tracker.isBusy(accountId)) return;
    const cfg = deps.config();
    if (!cfg.enabled) {
      updateTimer = stopTimer(updateTimer);
      if (wire !== null) push(null);
      return;
    }
    const text = pickText(cfg);
    if (text === wire) return;
    const wait = wire === null ? 0 : lastSetAt + minUpdateMs - Date.now();
    if (wait <= 0) {
      updateTimer = stopTimer(updateTimer);
      push(text);
      return;
    }
    if (updateTimer) return;
    updateTimer = setTimeout(() => {
      updateTimer = undefined;
      refresh();
    }, wait);
    updateTimer.unref?.();
  }

  function summarizeRun(runId: string, blurb: RunBlurb, sessionKey: string): void {
    const text = inbound.get(sessionKey);
    inbound.delete(sessionKey);
    if (!deps.summarize || !text || deps.config().blurb !== 'summarize') return;
    const abort = new AbortController();
    blurb.abort = abort;
    const timer = setTimeout(() => abort.abort(), summarizeTimeoutMs);
    timer.unref?.();
    deps
      .summarize(text, abort.signal)
      .then((out) => {
        const line = filterBlurb(out, deps.forbidden(), deps.config().maxLength);
        if (!line || blurbs.get(runId) !== blurb) return;
        blurb.summary = line;
        blurb.touchedAt = Date.now();
        refresh();
      })
      .catch((err: unknown) => log.debug('away summary failed', { accountId, error: String(err) }))
      .finally(() => clearTimeout(timer));
  }

  const unsubscribe = [
    tracker.onRun((change) => {
      if (change.run.accountId !== accountId || stopped) return;
      if (change.kind === 'start') {
        const blurb: RunBlurb = { changes: 0, touchedAt: Date.now() };
        blurbs.set(change.run.runId, blurb);
        summarizeRun(change.run.runId, blurb, change.run.sessionKey);
        return;
      }
      blurbs.get(change.run.runId)?.abort?.abort();
      blurbs.delete(change.run.runId);
      refresh();
    }),
    tracker.on('busy', (id) => {
      if (id !== accountId || stopped) return;
      clearTimer = stopTimer(clearTimer);
      graceTimer = stopTimer(graceTimer);
      graceTimer = setTimeout(() => {
        graceTimer = undefined;
        refresh();
      }, Math.max(0, deps.config().graceMs));
      graceTimer.unref?.();
    }),
    tracker.on('idle', (id) => {
      if (id !== accountId || stopped) return;
      graceTimer = stopTimer(graceTimer);
      updateTimer = stopTimer(updateTimer);
      if (wire !== null) push(null);
    }),
    session.on('state', (state) => {
      const was = lastPhase;
      lastPhase = state.phase;
      if (state.phase !== 'online' || was === 'online' || stopped) return;
      // A new BOS session starts with no away text on the server.
      wire = null;
      clearRetries = 0;
      clearTimer = stopTimer(clearTimer);
      tracker.reset(accountId);
    }),
  ];

  function remember(toolCallId: string | undefined, verdict: LineVerdict): LineVerdict {
    if (!toolCallId) return verdict;
    verdicts.set(toolCallId, verdict);
    if (verdicts.size > VERDICT_LIMIT) {
      const oldest = verdicts.keys().next().value;
      if (oldest !== undefined) verdicts.delete(oldest);
    }
    return verdict;
  }

  return {
    noteInbound(sessionKey, text) {
      const key = sessionKey.trim().toLowerCase();
      if (!key || !text.trim() || !deps.summarize || deps.config().blurb !== 'summarize') return;
      inbound.delete(key);
      inbound.set(key, text);
      if (inbound.size > INBOUND_LIMIT) {
        const oldest = inbound.keys().next().value;
        if (oldest !== undefined) inbound.delete(oldest);
      }
    },
    noteTool(runId, toolName) {
      const blurb = blurbs.get(runId);
      const phrase = phraseForTool(toolName);
      if (!blurb || !phrase) return;
      blurb.phrase = phrase;
      blurb.touchedAt = Date.now();
      refresh();
    },
    offerLine(runId, raw, toolCallId) {
      const cfg = deps.config();
      if (!cfg.enabled || cfg.blurb === 'phrases') return remember(toolCallId, { accepted: false, reason: 'off' });
      const blurb = blurbs.get(runId);
      if (!blurb) return remember(toolCallId, { accepted: false, reason: 'no-run' });
      const line = filterBlurb(raw, deps.forbidden(), cfg.maxLength);
      if (line && line === blurb.agentLine) return remember(toolCallId, { accepted: true, shown: line });
      if (blurb.changes >= MAX_LINE_CHANGES) return remember(toolCallId, { accepted: false, reason: 'limit' });
      if (!line) return remember(toolCallId, { accepted: false, reason: 'unsafe' });
      blurb.agentLine = line;
      blurb.changes += 1;
      blurb.touchedAt = Date.now();
      refresh();
      return remember(toolCallId, { accepted: true, shown: line });
    },
    verdictFor(toolCallId) {
      return verdicts.get(toolCallId);
    },
    current() {
      return wire;
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      for (const off of unsubscribe) off();
      graceTimer = stopTimer(graceTimer);
      updateTimer = stopTimer(updateTimer);
      clearTimer = stopTimer(clearTimer);
      for (const blurb of blurbs.values()) blurb.abort?.abort();
      blurbs.clear();
      if (wire !== null) push(null);
      await chain;
    },
  };
}

export type RosterPresence = { name: string; online: boolean; away: boolean };

export function rosterPresence(
  session: Pick<OscarSession, 'presenceOf'>,
  roster: { screenName: string }[],
  self: string,
): RosterPresence[] {
  return roster
    .filter((entry) => entry.screenName !== self)
    .map((entry) => {
      const presence = session.presenceOf(entry.screenName);
      return { name: entry.screenName, online: presence?.online ?? false, away: presence?.away ?? false };
    });
}

export function awayToolHints(away: AwayConfig): string[] {
  if (!away.enabled || away.blurb === 'phrases') return [];
  return [
    'While you work on a longer task, people see a short status line next to your name. To set it, use the message tool with action "set-presence" and awayMessage, or call oscar_status with text.',
    'Make the status line one vague sentence. No names, no file paths, no addresses, no long numbers, no secrets: anyone on the server can read it. You can set it at most twice per task.',
  ];
}
