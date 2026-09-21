import type { Logger, OscarSession, SessionState } from '../../src/oscar/index.js';

export const quietLog: Logger = { debug() {}, info() {}, warn() {}, error() {} };

export function stubSession() {
  const calls: (string | null)[] = [];
  const callTimes: number[] = [];
  const listeners = new Set<(state: SessionState) => void>();
  let phase: SessionState['phase'] = 'online';
  let failures = 0;
  const session: Pick<OscarSession, 'setAway' | 'getState' | 'on'> = {
    async setAway(text) {
      if (failures > 0) {
        failures -= 1;
        throw new Error('not-online');
      }
      calls.push(text);
      callTimes.push(Date.now());
    },
    getState: () => ({ phase, since: 0, attempts: 0 }),
    on(event, fn) {
      if (event !== 'state') return () => {};
      const listener = fn as (state: SessionState) => void;
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    session,
    calls,
    callTimes,
    failNext(count: number) {
      failures = count;
    },
    drop() {
      phase = 'backoff';
      for (const fn of [...listeners]) fn({ phase, since: Date.now(), attempts: 1 });
    },
    signOn() {
      phase = 'online';
      for (const fn of [...listeners]) fn({ phase, since: Date.now(), attempts: 0 });
    },
  };
}
