import { isTlsError } from './connection.js';
import {
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  BACKOFF_FACTOR,
  BACKOFF_FLOOR_AFTER_FAILURES,
  BACKOFF_FLOOR_MS,
  BACKOFF_JITTER,
  LOGIN_BUDGET_PER_MINUTE,
  LOGIN_STAGGER_MS,
} from './constants.js';
import type { LoginBudget, StateReason, TimerApi } from './types.js';

type Timer = ReturnType<typeof setTimeout>;

export function connectFailureReason(error: unknown, followedUnroutable: boolean): StateReason {
  if (isTlsError(error)) return 'tls';
  return followedUnroutable ? 'redirect-unroutable' : 'network';
}

export function backoffDelay(failures: number, random: number): number {
  const raw = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * BACKOFF_FACTOR ** Math.max(0, failures - 1));
  const floored = failures >= BACKOFF_FLOOR_AFTER_FAILURES ? Math.max(raw, BACKOFF_FLOOR_MS) : raw;
  return Math.round(floored * (1 + BACKOFF_JITTER * random));
}

// The server allows 10 auth connections per minute per source address, shared by every account behind it.
export function createLoginBudget(
  opts: { perMinute?: number; staggerMs?: number; now?: () => number; timers?: TimerApi } = {},
): LoginBudget {
  const perMinute = opts.perMinute ?? LOGIN_BUDGET_PER_MINUTE;
  const staggerMs = opts.staggerMs ?? LOGIN_STAGGER_MS;
  const now = opts.now ?? Date.now;
  const timers = opts.timers ?? { setTimeout, clearTimeout };
  const grants: number[] = [];
  const waiting: (() => void)[] = [];
  let timer: Timer | null = null;

  const pump = (): void => {
    timer = null;
    while (waiting.length > 0) {
      const t = now();
      while (grants.length > 0 && (grants[0] ?? 0) <= t - 60_000) grants.shift();
      const last = grants[grants.length - 1];
      let wait = last === undefined ? 0 : last + staggerMs - t;
      if (grants.length >= perMinute) wait = Math.max(wait, (grants[0] ?? 0) + 60_000 - t);
      if (wait > 0) {
        timer = timers.setTimeout(pump, wait);
        return;
      }
      grants.push(t);
      waiting.shift()?.();
    }
  };

  return {
    take() {
      return new Promise<void>((resolve) => {
        waiting.push(resolve);
        if (timer === null) pump();
      });
    },
  };
}
