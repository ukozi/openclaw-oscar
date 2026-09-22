import { createOscarSession } from '../../../src/oscar/session.js';
import type { Logger, OscarSession, OscarSessionOptions } from '../../../src/oscar/types.js';
import type { ClientTarget } from './stack.js';
import { until } from './wait.js';

export type Captured = { session: OscarSession; logLines: string[] };

export function captureLogger(lines: string[]): Logger {
  const write = (level: string) => (msg: string, fields?: Record<string, unknown>) => {
    lines.push(`${level} ${msg} ${fields ? JSON.stringify(fields, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) : ''}`);
  };
  return { debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error') };
}

export async function startSession(
  target: ClientTarget,
  screenName: string,
  password: string,
  extra: Partial<Pick<OscarSessionOptions, 'redirect' | 'buddies'>> & { waitOnline?: boolean } = {},
): Promise<Captured> {
  const logLines: string[] = [];
  const session = createOscarSession({
    host: target.host,
    port: target.port,
    tls: target.tls,
    ...(target.caFile ? { caFile: target.caFile } : {}),
    redirect: extra.redirect ?? 'auto',
    screenName,
    getPassword: async () => password,
    buddies: extra.buddies ?? (() => []),
    log: captureLogger(logLines),
    loginBudget: { take: async () => {} },
  });
  session.start();
  if (extra.waitOnline !== false) {
    await until(() => {
      const state = session.getState();
      if (state.phase === 'fatal') throw new Error(`${screenName} went fatal: ${state.reason ?? ''} ${state.detail ?? ''}`);
      return state.phase === 'online';
    }, { timeoutMs: 45_000, what: `${screenName} to come online` });
  }
  return { session, logLines };
}
