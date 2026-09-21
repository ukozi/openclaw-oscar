import { createOscarSession, type OscarEvents, type OscarSession } from '../../src/oscar/index.js';
import type { FakeOscarServer } from '../fake/oscar-server.js';

export const PASSWORD = 'hunter22';
export const SCALE = 20;

const quiet = { debug() {}, info() {}, warn() {}, error() {} };

export type Seen = { [E in keyof OscarEvents]: OscarEvents[E][] };

export type Bot = { session: OscarSession; seen: Seen };

export function fastClock(): { now: () => number; timers: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout } } {
  const start = Date.now();
  return {
    now: () => start + (Date.now() - start) * SCALE,
    timers: {
      setTimeout: ((fn: () => void, ms?: number) => setTimeout(fn, (ms ?? 0) / SCALE)) as unknown as typeof setTimeout,
      clearTimeout,
    },
  };
}

export async function until<T>(read: () => T | undefined | null | false, what: string, ms = 4000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value !== undefined && value !== null && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export async function signOn(server: FakeOscarServer, name: string, buddies: string[] = []): Promise<Bot> {
  server.addUser(name, PASSWORD);
  const clock = fastClock();
  const session = createOscarSession({
    host: '127.0.0.1',
    port: server.port,
    tls: false,
    redirect: 'auto',
    screenName: name,
    getPassword: async () => PASSWORD,
    buddies: () => buddies,
    log: quiet,
    loginBudget: { take: async () => undefined },
    now: clock.now,
    timers: clock.timers,
  });
  const seen: Seen = {
    state: [], im: [], invite: [], roomMessage: [], roomJoin: [], roomLeave: [], roomReady: [], roomClosed: [], presence: [], rate: [],
  };
  for (const event of Object.keys(seen) as (keyof OscarEvents)[]) {
    session.on(event, (payload) => {
      (seen[event] as unknown[]).push(payload);
    });
  }
  session.start();
  await until(() => session.getState().phase === 'online', `${name} online`);
  return { session, seen };
}

export function chatSends(server: FakeOscarServer, name: string): Uint8Array[] {
  return server.snacsFrom(name).filter((s) => s.conn === 'chat' && s.family === 0x000e && s.subtype === 0x0005).map((s) => s.body);
}

export function serviceRequests(server: FakeOscarServer, name: string): number[] {
  return server
    .snacsFrom(name)
    .filter((s) => s.conn === 'bos' && s.family === 0x0001 && s.subtype === 0x0004)
    .map((s) => Buffer.from(s.body).readUInt16BE(0));
}
