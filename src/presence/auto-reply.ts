import type { AwayConfig } from '../config.js';
import { copy } from '../copy.js';
import type { Logger } from '../oscar/index.js';
import type { AwayController } from './away.js';
import type { RunTracker } from './runs.js';

export type AutoReplyDeps = {
  accountId: string;
  tracker: Pick<RunTracker, 'on' | 'isBusy'>;
  away: Pick<AwayController, 'current' | 'onShown'>;
  config: () => AwayConfig;
  repliedAt: (peer: string) => number | undefined;
  send: (to: string, text: string) => Promise<void>;
  now?: () => number;
  log: Logger;
};

export interface AutoReplier {
  contacted(peer: string): void;
  stop(): void;
  idle(): Promise<void>;
}

const PEER_LIMIT = 200;

// Only answers people who write while we're busy, never the question being worked on.
export function createAutoReplier(deps: AutoReplyDeps): AutoReplier {
  const now = deps.now ?? ((): number => Date.now());
  const waiting = new Map<string, number>();
  const sentAt = new Map<string, number>();
  let tail: Promise<void> = Promise.resolve();
  let stopped = false;

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

  function fire(peer: string, contactedAt: number, line: string): void {
    const cfg = deps.config();
    if (!cfg.enabled || cooling(peer, cfg)) return;
    const answered = deps.repliedAt(peer);
    if (answered !== undefined && answered >= contactedAt) return;
    remember(peer);
    const text = copy.awayAutoReply(line);
    tail = tail
      .then(() => deps.send(peer, text))
      .catch((err: unknown) => deps.log.debug('away auto-reply was not sent', { accountId: deps.accountId, error: String(err) }));
  }

  const offs = [
    deps.away.onShown((line) => {
      if (stopped) return;
      const ready = [...waiting];
      waiting.clear();
      for (const [peer, at] of ready) fire(peer, at, line);
    }),
    deps.tracker.on('idle', (id) => {
      if (id === deps.accountId) waiting.clear();
    }),
  ];

  return {
    contacted(peer): void {
      if (stopped || !deps.tracker.isBusy(deps.accountId)) return;
      const cfg = deps.config();
      if (!cfg.enabled || cooling(peer, cfg)) return;
      const line = deps.away.current();
      if (line !== null) {
        fire(peer, now(), line);
        return;
      }
      if (!waiting.has(peer)) waiting.set(peer, now());
      if (waiting.size > PEER_LIMIT) {
        const oldest = waiting.keys().next().value;
        if (oldest !== undefined) waiting.delete(oldest);
      }
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      for (const off of offs) off();
      waiting.clear();
    },
    idle: () => tail,
  };
}
