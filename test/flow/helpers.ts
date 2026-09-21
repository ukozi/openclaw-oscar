import { oscarPlugin, startAccount } from '../../src/channel.js';
import { resolveAccount } from '../../src/config.js';
import { IM_TIMING } from '../../src/inbound/im.js';
import { NOTICE_TIMING } from '../../src/notice.js';
import { getRuntime, resetRuntimeForTests, setHost } from '../../src/runtime.js';
import { sdk } from '../fake/openclaw.js';
import { FakeOscarServer } from '../fake/oscar-server.js';
import type { FakePeer } from '../fake/oscar-server.js';

const ICBM = 0x04;
const ICBM_SEND = 0x06;
const ICBM_TYPING = 0x14;

export type Flow = {
  server: FakeOscarServer; cfgRef: { current: Record<string, unknown> }; status(): Record<string, unknown>;
  peer(name: string): FakePeer; stop(): Promise<void>;
};

export async function waitFor(check: () => boolean, ms = 8000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const latin1 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('latin1');

function imRecipient(body: Uint8Array): string | null {
  if (body.length < 11) return null;
  const length = body[10] ?? 0;
  return latin1(body.subarray(11, 11 + length)).replace(/ /g, '').toLowerCase();
}

export function snacsReferencing(server: FakeOscarServer, bot: string, name: string): { family: number; subtype: number }[] {
  return server.snacsFrom(bot).filter((s) => {
    if (s.conn === 'auth') return false;
    if (s.family === ICBM && (s.subtype === ICBM_SEND || s.subtype === ICBM_TYPING)) return imRecipient(s.body) === name;
    return latin1(s.body).toLowerCase().includes(name);
  }).map((s) => ({ family: s.family, subtype: s.subtype }));
}

export function imsSentTo(server: FakeOscarServer, bot: string, name: string): number {
  const cookies = server.snacsFrom(bot)
    .filter((s) => s.family === ICBM && s.subtype === ICBM_SEND && imRecipient(s.body) === name)
    .map((s) => Buffer.from(s.body.subarray(0, 8)).toString('hex'));
  return new Set(cookies).size;
}

export function imsNaming(server: FakeOscarServer, bot: string, name: string): { to: string; cookie: string }[] {
  const byCookie = new Map<string, { to: string; cookie: string }>();
  for (const s of server.snacsFrom(bot)) {
    if (s.conn === 'auth' || s.family !== ICBM || s.subtype !== ICBM_SEND) continue;
    if (!latin1(s.body).toLowerCase().includes(name)) continue;
    const cookie = Buffer.from(s.body.subarray(0, 8)).toString('hex');
    byCookie.set(cookie, { to: imRecipient(s.body) ?? '', cookie });
  }
  return [...byCookie.values()];
}

export async function startFlow(opts: { sec?: Record<string, unknown>; host?: Record<string, unknown>; server?: { disableAuth?: boolean }; expectOnline?: boolean } = {}): Promise<Flow> {
  sdk.reset();
  resetRuntimeForTests();
  Object.assign(IM_TIMING, { debounceMs: 30, replyCooldownMs: 0, replaySettleMs: 200 });
  NOTICE_TIMING.windowMs = 3600_000;

  const server = await FakeOscarServer.start(opts.server ?? {});
  server.addUser('botone', 'hunter22');
  for (const name of ['alice', 'bob', 'mallory', 'trudy', 'victor']) server.addUser(name, `pw-${name}`);

  const cfgRef = {
    current: {
      commands: { config: true },
      ...opts.host,
      channels: { oscar: { host: '127.0.0.1', port: server.port, tls: false, redirect: 'pin', screenName: 'botone', password: 'hunter22', owners: ['alice'], allowFrom: ['bob'], typing: false, ...opts.sec } },
    } as Record<string, unknown>,
  };
  setHost({ config: { current: () => cfgRef.current } });
  sdk.usePlugin(oscarPlugin);

  const abort = new AbortController();
  let status: Record<string, unknown> = { accountId: 'default' };
  const parked = startAccount({
    cfg: cfgRef.current, accountId: 'default', account: resolveAccount(cfgRef.current, 'default'), runtime: {}, abortSignal: abort.signal,
    log: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
    getStatus: () => status, setStatus: (next: Record<string, unknown>) => { status = next; },
  } as never);
  if (opts.expectOnline !== false) {
    await waitFor(() => getRuntime('default')?.session.getState().phase === 'online', 10_000, 'the bot to sign on');
  }

  return {
    server, cfgRef, status: () => status,
    peer: (name) => server.peer(name),
    async stop(): Promise<void> {
      abort.abort();
      await parked;
      await server.stop();
      setHost(undefined);
      Object.assign(IM_TIMING, { debounceMs: 2000, replyCooldownMs: 2000, replaySettleMs: 3000 });
      NOTICE_TIMING.windowMs = 3600_000;
    },
  };
}
