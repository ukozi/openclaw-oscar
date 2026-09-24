import type { OpenClawConfig } from 'openclaw/plugin-sdk/channel-core';
import { sendDurableMessageBatch } from 'openclaw/plugin-sdk/channel-outbound';
import { resolveAccount } from './config.js';
import type { FallbackRoute } from './config.js';
import { normalizeName } from './names.js';
import type { Target } from './names.js';
import { getRuntime, liveConfig } from './runtime.js';

export type FallbackReason = 'away' | 'offline' | 'unknown' | 'not-signed-on';
export type FallbackDecision = { route: FallbackRoute; reason: FallbackReason };

export function fallbackFor(cfg: unknown, accountId: string, target: Target): FallbackDecision | null {
  if (target.kind !== 'im') return null;
  const name = normalizeName(target.name);
  const route = resolveAccount(liveConfig(cfg), accountId).fallback.find((r) => r.screenName === name);
  if (!route) return null;
  const rt = getRuntime(accountId);
  if (!rt || rt.halted || rt.session.getState().phase !== 'online') return { route, reason: 'not-signed-on' };
  const presence = rt.session.presenceOf(name);
  if (!presence) return { route, reason: 'unknown' };
  if (!presence.online) return { route, reason: 'offline' };
  if (presence.away) return { route, reason: 'away' };
  return null;
}

export async function sendByFallback(cfg: unknown, accountId: string, decision: FallbackDecision, text: string): Promise<boolean> {
  const { route, reason } = decision;
  const log = getRuntime(accountId)?.log;
  try {
    const params: Parameters<typeof sendDurableMessageBatch>[0] & { skipQueue?: boolean } = {
      cfg: liveConfig(cfg) as OpenClawConfig,
      channel: route.channel as never,
      to: route.to,
      ...(route.accountId ? { accountId: route.accountId } : {}),
      payloads: [{ text }],
      // A queued retry would replay the text after we already fell back to AIM.
      skipQueue: true,
    };
    const result = await sendDurableMessageBatch(params);
    if (result.status === 'failed' && !mayHaveArrived(result)) {
      log?.warn('fallback send failed', { to: route.screenName, channel: route.channel, status: result.status });
      return false;
    }
    if (result.status === 'partial_failed' || result.status === 'failed') {
      log?.warn(`fallback send to ${route.screenName} over ${route.channel} partly failed; some of it already arrived there, so it is not resent on AIM`);
      return true;
    }
    if (result.status === 'suppressed') {
      log?.info(`fallback send to ${route.screenName} over ${route.channel} was suppressed by the host`);
      return true;
    }
    log?.info(`sent to ${route.screenName} over ${route.channel} (${reason})`);
    return true;
  } catch (err) {
    log?.warn('fallback send failed', { to: route.screenName, channel: route.channel, error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

function mayHaveArrived(result: { error?: unknown; payloadOutcomes?: unknown }): boolean {
  const error = result.error as { sentBeforeError?: unknown } | undefined;
  const outcomes = Array.isArray(result.payloadOutcomes) ? (result.payloadOutcomes as { sentBeforeError?: unknown }[]) : [];
  return error?.sentBeforeError === true || outcomes.some((o) => o?.sentBeforeError === true);
}
