import { ManualTimers, captureLog, waitFor } from 'open-oscar-client-kit/testing';
import type { FakeOscarServer } from 'open-oscar-client-kit/testing';
import { ByteReader, decodeTlvs } from 'open-oscar-client-kit/wire';
import type { Tlv } from 'open-oscar-client-kit/wire';
import { KitSession } from '../../src/oscar/adapter.js';
import type {
  DirectImOfferEvent,
  DirectImStateEvent,
  DirectMessageEvent,
  ImEvent,
  OscarEvents,
  OscarSessionOptions,
  RateEvent,
  SessionState,
} from '../../src/oscar/types.js';
import { caFileOf } from './kit.js';

export type Harness = {
  session: KitSession;
  timers: ManualTimers;
  logs: ReturnType<typeof captureLog>;
  states: SessionState[];
  ims: ImEvent[];
  presence: OscarEvents['presence'][];
  rates: RateEvent[];
  directImOffers: DirectImOfferEvent[];
  directIms: DirectImStateEvent[];
  directMessages: DirectMessageEvent[];
  online(): Promise<void>;
  phase(phase: SessionState['phase']): Promise<SessionState>;
};

const harnesses: Harness[] = [];

export function makeSession(server: FakeOscarServer, over: Partial<OscarSessionOptions> = {}, timers = new ManualTimers()): Harness {
  const logs = captureLog();
  const session = new KitSession({
    host: '127.0.0.1',
    port: server.port,
    tls: caFileOf(server) !== undefined,
    caFile: caFileOf(server),
    redirect: 'auto',
    screenName: 'botone',
    getPassword: async () => 'botpass1',
    buddies: () => ['alice', 'bob'],
    log: logs.log,
    loginBudget: { take: async () => {} },
    now: timers.now,
    timers: timers.api,
    ...over,
  });
  const h: Harness = {
    session,
    timers,
    logs,
    states: [],
    ims: [],
    presence: [],
    rates: [],
    directImOffers: [],
    directIms: [],
    directMessages: [],
    online: async () => {
      await h.phase('online');
    },
    phase: async (phase) => {
      await waitFor(() => session.getState().phase === phase, `phase ${phase} (now ${session.getState().phase})`);
      return session.getState();
    },
  };
  session.on('state', (s) => h.states.push(s));
  session.on('im', (e) => h.ims.push(e));
  session.on('presence', (e) => h.presence.push(e));
  session.on('rate', (e) => h.rates.push(e));
  session.on('directImOffer', (e) => h.directImOffers.push(e));
  session.on('directIm', (e) => h.directIms.push(e));
  session.on('directMessage', (e) => h.directMessages.push(e));
  harnesses.push(h);
  return h;
}

export async function stopAllSessions(): Promise<void> {
  for (const h of harnesses.splice(0)) await h.session.stop();
}

export function imSends(server: FakeOscarServer, name: string): { cookie: bigint; to: string; tlvs: Tlv[] }[] {
  return server
    .snacsFrom(name)
    .filter((s) => s.conn === 'bos' && s.family === 4 && s.subtype === 6)
    .map((s) => {
      const r = new ByteReader(s.body);
      return { cookie: r.u64(), to: (r.u16(), r.str8()), tlvs: decodeTlvs(r.rest()) };
    });
}
