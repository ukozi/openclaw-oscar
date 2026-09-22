import type { AwayConfig } from '../config.js';
import { copy } from '../copy.js';
import type { Logger } from '../oscar/index.js';
import type { AwayController } from './away.js';
import type { RunTracker } from './runs.js';

export type AutoReplyDeps = {
  accountId: string;
  tracker: Pick<RunTracker, 'onRun' | 'runInfo'>;
  away: Pick<AwayController, 'chosenLine'>;
  config: () => AwayConfig;
  peerFor: (sessionKey: string) => string | null;
  repliedAt: (peer: string) => number | undefined;
  send: (to: string, text: string) => Promise<void>;
  now?: () => number;
  log: Logger;
};

export interface AutoReplier {
  stop(): void;
  idle(): Promise<void>;
}

const PEER_LIMIT = 200;

type Pending = { timer: ReturnType<typeof setTimeout>; peer: string; startedAt: number };

export function createAutoReplier(deps: AutoReplyDeps): AutoReplier {
  const now = deps.now ?? ((): number => Date.now());
  const pending = new Map<string, Pending>();
  const sentAt = new Map<string, number>();
  let tail: Promise<void> = Promise.resolve();
  let stopped = false;

  function cancel(runId: string): void {
    const entry = pending.get(runId);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(runId);
  }

  function cooling(peer: string, cfg: AwayConfig): boolean {
    const last = sentAt.get(peer);
    return last !== undefined && now() - last < Math.max(0, cfg.replyCooldownMinutes) * 60_000;
  }

  function remember(peer: string): void {
    sentAt.delete(peer);
    sentAt.set(peer, now());
    if (sentAt.size > PEER_LIMIT) {
      const oldest = sentAt.keys().next().value;
      if (oldest !== undefined) sentAt.delete(oldest);
    }
  }

  function fire(runId: string, entry: Pending): void {
    pending.delete(runId);
    if (stopped) return;
    const cfg = deps.config();
    if (!cfg.enabled || !deps.tracker.runInfo(runId)) return;
    const answered = deps.repliedAt(entry.peer);
    if (answered !== undefined && answered >= entry.startedAt) return;
    if (cooling(entry.peer, cfg)) return;
    const line = copy.awayAutoReply(deps.away.chosenLine());
    remember(entry.peer);
    tail = tail
      .then(() => deps.send(entry.peer, line))
      .catch((err: unknown) => deps.log.debug('away auto-reply was not sent', { accountId: deps.accountId, error: String(err) }));
  }

  const off = deps.tracker.onRun((change) => {
    if (stopped || change.run.accountId !== deps.accountId) return;
    if (change.kind === 'end') {
      cancel(change.run.runId);
      return;
    }
    const cfg = deps.config();
    // A roster bot's messages are control lines, and a stranger never reaches a dispatch, so neither has a run here.
    if (!cfg.enabled || change.run.origin === 'bot') return;
    const peer = deps.peerFor(change.run.sessionKey);
    if (!peer || cooling(peer, cfg)) return;
    cancel(change.run.runId);
    const runId = change.run.runId;
    const timer = setTimeout(() => {
      const entry = pending.get(runId);
      if (entry) fire(runId, entry);
    }, Math.max(0, cfg.graceMs));
    timer.unref?.();
    pending.set(runId, { timer, peer, startedAt: change.run.startedAt });
  });

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      off();
      for (const runId of [...pending.keys()]) cancel(runId);
    },
    idle: () => tail,
  };
}
