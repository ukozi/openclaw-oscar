import { OscarError, SignOnError, backoffDelay } from 'open-oscar-client-kit/client';
import type { DropEvidence, IssuedTicket, TicketSource } from 'open-oscar-client-kit/client';
import type { BuddyPresence, DirectImStatus, FileSink, IncomingIm, Invite, OutgoingFile, SelfInfo, TransferStatus } from 'open-oscar-client-kit/model';
import { ManualTimers } from 'open-oscar-client-kit/testing';
import { PASSWORD_CHECK_CACHE_MS } from 'open-oscar-client-kit/wire';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KitSession } from '../../../src/oscar/adapter.js';
import { OscarRoomError, OscarSendError, createLoginBudget, createOscarSession } from '../../../src/oscar/index.js';
import { login, probeLogin } from '../../../src/oscar/login.js';
import type { LoginOutcome } from '../../../src/oscar/login.js';
import type { Logger, OscarEvents, OscarSessionOptions, SessionState, StateReason } from '../../../src/oscar/types.js';
import { StubClient } from '../../fake/stub-client.js';

vi.mock('../../../src/oscar/login.js', async (original) => ({
  ...(await original<typeof import('../../../src/oscar/login.js')>()),
  login: vi.fn(),
  probeLogin: vi.fn(),
}));

const quietLog: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
};
const cookie = new Uint8Array([1, 2, 3]);
const loggedIn = (over: Partial<Extract<LoginOutcome, { ok: true }>> = {}): LoginOutcome => ({
  ok: true,
  host: '10.0.0.9',
  port: 5190,
  cookie,
  decision: { host: '10.0.0.9', port: 5190, pinned: false },
  advertised: '10.0.0.9:5190',
  followedUnroutable: false,
  ...over,
});
const coded = (code: string, message: string): Error => Object.assign(new Error(message), { code });
const tlsError = (): Error => coded('DEPTH_ZERO_SELF_SIGNED_CERT', 'self-signed certificate');
const econnrefused = (): Error => coded('ECONNREFUSED', 'connect ECONNREFUSED 10.0.0.9:5190');
const connectFailure = (cause: Error): SignOnError =>
  new SignOnError({ kind: 'unreachable' }, cause === undefined ? undefined : { kind: (cause as { code?: string }).code === 'ECONNREFUSED' ? 'connect-refused' : 'unreachable' }, { cause });

type World = ReturnType<typeof world>;

function world(over: Partial<OscarSessionOptions> = {}) {
  const client = new StubClient();
  client.state = 'offline';
  client.self = { screenName: 'Bot One' } as SelfInfo;
  const timers = new ManualTimers();
  const taken = { count: 0 };
  const session = new KitSession(
    {
      host: 'oscar.example',
      port: 5190,
      tls: false,
      redirect: 'auto',
      screenName: 'botone',
      getPassword: async () => 'botpass1',
      buddies: () => ['alice'],
      log: quietLog,
      loginBudget: {
        take: async () => {
          taken.count += 1;
        },
      },
      now: timers.now,
      timers: timers.api,
      ...over,
    },
    client,
  );
  const states: SessionState[] = [];
  session.on('state', (s) => states.push(s));
  const up = async (): Promise<void> => {
    session.start();
    await settle();
    expect(session.getState().phase).toBe('online');
  };
  const drop = (evidence: DropEvidence): void => client.drop(session.reconnect, evidence);
  return { client, timers, taken, session, states, up, drop };
}

type Scenario = (w: World) => Promise<void>;
const loginFails = (reason: StateReason, detail = 'why'): Scenario => async (w) => {
  vi.mocked(login).mockResolvedValue({ ok: false, reason, detail });
  w.session.start();
  await settle();
};
const bosConnectFails = (cause: Error, outcome: LoginOutcome = loggedIn()): Scenario => async (w) => {
  vi.mocked(login).mockResolvedValue(outcome);
  w.client.script('signOnWith', { reject: connectFailure(cause) });
  w.session.start();
  await settle();
};
const drops = (evidence: DropEvidence): Scenario => async (w) => {
  await w.up();
  w.drop(evidence);
};
const dropsAfterLimited = (): Scenario => async (w) => {
  await w.up();
  w.client.emit('rate', { limited: true });
  w.drop({ kind: 'signed-off', reason: 1 });
};

beforeEach(() => {
  vi.mocked(login).mockReset().mockResolvedValue(loggedIn());
  vi.mocked(probeLogin).mockReset().mockResolvedValue('checks');
  vi.spyOn(Math, 'random').mockReturnValue(0);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('the state each failure leaves', () => {
  const rows: [string, Scenario, Partial<SessionState>][] = [
    ['a wrong password', loginFails('bad-password'), { phase: 'fatal', reason: 'bad-password', detail: 'why' }],
    ['a name the server does not know', loginFails('unknown-name'), { phase: 'fatal', reason: 'unknown-name' }],
    ['a suspended account', loginFails('suspended'), { phase: 'fatal', reason: 'suspended' }],
    ['a Node build without MD5', loginFails('md5-unavailable'), { phase: 'fatal', reason: 'md5-unavailable' }],
    ['a limited login', loginFails('login-rate-limited'), { phase: 'backoff', reason: 'login-rate-limited' }],
    ['a refused redirect', loginFails('redirect-unroutable'), { phase: 'backoff', reason: 'redirect-unroutable', detail: 'why' }],
    ['a login that could not connect', loginFails('network', 'connect ECONNREFUSED'), { phase: 'backoff', reason: 'network', detail: 'connect ECONNREFUSED' }],
    ['a TLS failure at login', loginFails('tls', 'self-signed certificate'), { phase: 'backoff', reason: 'tls', detail: 'self-signed certificate' }],
    ['a TLS failure on the BOS connect', bosConnectFails(tlsError()), { phase: 'backoff', reason: 'tls', detail: 'self-signed certificate' }],
    ['a refused BOS connect', bosConnectFails(econnrefused()), { phase: 'backoff', reason: 'network', detail: 'connect ECONNREFUSED 10.0.0.9:5190' }],
    [
      'a refused BOS connect after a followed unroutable redirect',
      bosConnectFails(econnrefused(), loggedIn({ followedUnroutable: true })),
      { phase: 'backoff', reason: 'redirect-unroutable' },
    ],
    [
      'a BOS connect that timed out after a followed unroutable redirect',
      bosConnectFails(new Error('connect timeout'), loggedIn({ followedUnroutable: true })),
      { phase: 'backoff', reason: 'redirect-unroutable', detail: 'connect timeout' },
    ],
    ['a sign-off with a reason', drops({ kind: 'signed-off', reason: 1 }), { phase: 'backoff', reason: 'disconnected-by-server', detail: 'signed on elsewhere or kicked' }],
    ['a sign-off after a limited rate', dropsAfterLimited(), { phase: 'backoff', reason: 'disconnected-by-server', detail: 'rate limit' }],
    ['a closed socket', drops({ kind: 'closed', close: 'eof' }), { phase: 'backoff', reason: 'network', detail: 'eof' }],
    ['a liveness probe with no answer', drops({ kind: 'closed', close: 'probe-timeout' }), { phase: 'backoff', reason: 'network', detail: 'probe-timeout' }],
    ['a sign-off with no reason', drops({ kind: 'empty-signoff' }), { phase: 'backoff', reason: 'network', detail: 'empty-signoff' }],
  ];
  it.each(rows)('%s', async (_name, scenario, want) => {
    const w = world();
    await scenario(w);
    expect(w.session.getState()).toMatchObject(want);
    await w.session.stop();
  });

  it('reads a sign-off during the bring-up as disconnected by the server', async () => {
    const w = world();
    w.client.script('signOnWith', { reject: new SignOnError({ kind: 'unreachable' }, { kind: 'signed-off', reason: 1 }) });
    w.session.start();
    await settle();
    expect(w.session.getState()).toMatchObject({ phase: 'backoff', reason: 'disconnected-by-server', detail: 'signed on elsewhere or kicked' });
  });

  it('reads a bring-up that timed out after a followed unroutable redirect as network', async () => {
    const { RequestTimeoutError } = await import('open-oscar-client-kit/wire');
    const w = world();
    vi.mocked(login).mockResolvedValue(loggedIn({ followedUnroutable: true }));
    const cause = Object.assign(Object.create(RequestTimeoutError.prototype) as Error, { message: 'request timed out' });
    w.client.script('signOnWith', { reject: new SignOnError({ kind: 'unreachable' }, { kind: 'unreachable' }, { cause }) });
    w.session.start();
    await settle();
    expect(w.session.getState()).toMatchObject({ phase: 'backoff', reason: 'network' });
  });

  it('reads a password that could not be read as network, with its message', async () => {
    const w = world();
    vi.mocked(login).mockRejectedValue(new Error('secret store locked'));
    w.session.start();
    await settle();
    expect(w.session.getState()).toMatchObject({ phase: 'backoff', reason: 'network', detail: 'secret store locked' });
  });

  it('says rate limit for 30 s after the limit lifted, and not after that', async () => {
    const w = world();
    await w.up();
    w.client.emit('rate', { limited: true });
    await w.timers.advance(5000);
    w.client.emit('rate', { limited: false });
    await w.timers.advance(30_000);
    w.drop({ kind: 'signed-off', reason: 1 });
    expect(w.session.getState().detail).toBe('rate limit');

    const later = world();
    await later.up();
    later.client.emit('rate', { limited: true });
    later.client.emit('rate', { limited: false });
    await later.timers.advance(30_001);
    later.drop({ kind: 'signed-off', reason: 1 });
    expect(later.session.getState().detail).toBe('signed on elsewhere or kicked');
  });
});

describe('the sign-on', () => {
  it('logs in with the configured address and hands the client an adapter ticket', async () => {
    const w = world({ tls: true, caFile: '/ca.pem', redirect: 'follow' });
    await w.up();
    expect(vi.mocked(login).mock.calls[0]?.[0]).toMatchObject({ host: 'oscar.example', port: 5190, tls: true, caFile: '/ca.pem', redirect: 'follow', screenName: 'botone' });
    const [source, server] = w.client.callsTo('signOnWith')[0] as [TicketSource, unknown];
    expect(server).toEqual({ host: 'oscar.example', port: 5190 });
    const issued: IssuedTicket = await source.ticket({ reconnect: false, track: () => {} });
    expect(issued).toEqual({ ticket: { host: '10.0.0.9', port: 5190, cookie }, source: 'adapter', obtainedAt: w.timers.now(), expiresAt: null });
  });

  it('hashes the password it reads at each attempt', async () => {
    const { strongHash } = await import('open-oscar-client-kit/wire');
    const w = world({ getPassword: async () => 'secret42' });
    await w.up();
    const hash = vi.mocked(login).mock.calls[0]?.[0].hash;
    expect(await hash?.('key')).toEqual(strongHash('secret42', 'key'));
  });

  it('gives the name the server formatted, and keeps it after a drop', async () => {
    const w = world();
    expect(w.session.selfInfo()).toBeNull();
    await w.up();
    expect(w.session.selfInfo()).toEqual({ screenName: 'Bot One' });
    w.drop({ kind: 'closed', close: 'eof' });
    expect(w.session.selfInfo()).toEqual({ screenName: 'Bot One' });
  });

  it('takes one login budget token per attempt', async () => {
    const w = world();
    vi.mocked(login).mockResolvedValue({ ok: false, reason: 'network', detail: 'down' });
    w.session.start();
    await settle();
    expect(w.taken.count).toBe(1);
    await w.timers.advance(2000);
    await settle();
    expect(w.taken.count).toBe(2);
    expect(w.client.callsTo('signOnWith')).toHaveLength(2);
  });

  it('never lets the kit retry by itself', () => {
    const w = world();
    const kinds: DropEvidence[] = [
      { kind: 'closed', close: 'eof' },
      { kind: 'connect-refused' },
      { kind: 'unreachable' },
      { kind: 'empty-signoff' },
      { kind: 'cookie-refused' },
      { kind: 'session-cap' },
      { kind: 'signed-off', reason: 1 },
      { kind: 'refused', failure: { kind: 'wrong-password' } },
      { kind: 'local' },
    ];
    for (const evidence of kinds) {
      for (const phase of ['drop', 'attempt'] as const) {
        expect(w.session.reconnect.next({ phase, evidence, attempt: 1, onlineAt: 0, now: 0 })).toEqual({ retry: false, reason: { kind: 'unreachable' } });
      }
    }
  });
});

describe('the retry schedule', () => {
  it("retries after the plugin's back-off and at least 60 s after a server disconnect", async () => {
    const w = world();
    vi.mocked(login).mockResolvedValue({ ok: false, reason: 'network', detail: 'down' });
    w.session.start();
    await settle();
    expect(w.session.getState()).toMatchObject({ phase: 'backoff', attempts: 1 });
    expect(w.timers.pending()).toEqual([2000]);
    await w.timers.advance(2000);
    await settle();
    expect(w.session.getState()).toMatchObject({ phase: 'backoff', attempts: 2 });
    expect(w.timers.pending()).toEqual([4000]);
    vi.mocked(login).mockResolvedValue(loggedIn());
    await w.timers.advance(4000);
    await settle();
    expect(w.session.getState().phase).toBe('online');

    w.drop({ kind: 'signed-off', reason: 1 });
    expect(w.session.getState()).toMatchObject({ phase: 'backoff', attempts: 3 });
    expect(w.timers.pending()).toEqual([60_000]);
    await w.timers.advance(59_999);
    await settle();
    expect(w.session.getState().phase).toBe('backoff');
    await w.timers.advance(1);
    await settle();
    expect(w.session.getState().phase).toBe('online');
  });

  it('waits at least 60 s after a limited login', async () => {
    const w = world();
    await loginFails('login-rate-limited')(w);
    expect(w.timers.pending()).toEqual([60_000]);
  });

  it('resets the failure count after 60 s online', async () => {
    const w = world();
    await w.up();
    w.drop({ kind: 'closed', close: 'eof' });
    expect(w.session.getState().attempts).toBe(1);
    await w.timers.advance(2000);
    await settle();
    w.drop({ kind: 'closed', close: 'eof' });
    expect(w.session.getState().attempts).toBe(2);
    await w.timers.advance(4000);
    await settle();
    expect(w.session.getState().phase).toBe('online');
    await w.timers.advance(60_000);
    w.drop({ kind: 'closed', close: 'eof' });
    expect(w.session.getState().attempts).toBe(1);
  });

  it('start from fatal begins again with no failures counted', async () => {
    const w = world();
    await loginFails('bad-password')(w);
    expect(w.session.getState()).toMatchObject({ phase: 'fatal', attempts: 1 });
    expect(w.timers.pending()).toEqual([]);
    vi.mocked(login).mockResolvedValue(loggedIn());
    w.session.start();
    await settle();
    expect(w.session.getState()).toMatchObject({ phase: 'online', attempts: 0 });
  });

  it('start does nothing while an attempt runs or the session is online', async () => {
    const w = world();
    await w.up();
    w.session.start();
    await settle();
    expect(w.client.callsTo('signOnWith')).toHaveLength(1);
  });
});

describe('stop', () => {
  it('stop during an attempt leaves stopped and no timer', async () => {
    const w = world();
    w.client.script('signOnWith', 'hold');
    w.session.start();
    await settle();
    expect(w.session.getState().phase).toBe('connecting');
    await w.session.stop();
    w.client.held[0]?.resolve('cancelled');
    await settle();
    expect(w.session.getState().phase).toBe('stopped');
    expect(w.client.callsTo('signOff')).toHaveLength(1);
    expect(w.timers.pending()).toEqual([]);
  });

  it('stop during an attempt that then fails leaves stopped and no timer', async () => {
    const w = world();
    w.client.script('signOnWith', 'hold');
    w.session.start();
    await settle();
    await w.session.stop();
    w.client.held[0]?.reject(connectFailure(econnrefused()));
    await settle();
    expect(w.session.getState().phase).toBe('stopped');
    expect(w.timers.pending()).toEqual([]);
  });

  it('stop while it waits to retry clears the timer', async () => {
    const w = world();
    await loginFails('network')(w);
    expect(w.timers.pending()).toHaveLength(1);
    await w.session.stop();
    expect(w.session.getState().phase).toBe('stopped');
    expect(w.timers.pending()).toEqual([]);
  });

  it('stop while online signs off and is not read as a drop', async () => {
    const w = world();
    await w.up();
    await w.session.stop();
    expect(w.client.callsTo('signOff')).toHaveLength(1);
    expect(w.states.map((s) => s.phase)).toEqual(['connecting', 'online', 'stopped']);
    expect(w.timers.pending()).toEqual([]);
  });
});

describe('sends', () => {
  it('rejects a send as not-online before the first sign-on', async () => {
    const w = world();
    await expect(w.session.sendIm('alice', 'hi')).rejects.toMatchObject({ code: 'not-online' });
    await expect(w.session.setAway('gone')).rejects.toMatchObject({ code: 'not-online' });
    expect(w.client.callsTo('sendIm')).toHaveLength(0);
  });

  it('sends in lane order, with the automatic flag and the when-offline store rule', async () => {
    const w = world();
    await w.up();
    w.client.script('sendIm', 'hold');
    const first = w.session.sendIm('alice', 'one');
    const notice = w.session.sendIm('alice', 'notice', { priority: 'notice' });
    const reply = w.session.sendIm('alice', 'reply', { auto: true });
    await settle();
    (w.client.held[0]?.resolve as (v: unknown) => void)({ id: '00000000000000aa', stored: true });
    expect(await first).toEqual({ id: '00000000000000aa', storedOffline: true });
    await Promise.all([notice, reply]);
    expect(w.client.callsTo('sendIm')).toEqual([
      ['alice', { html: 'one' }, { automatic: false, store: 'when-offline' }],
      ['alice', { html: 'reply' }, { automatic: true, store: 'when-offline' }],
      ['alice', { html: 'notice' }, { automatic: false, store: 'when-offline' }],
    ]);
  });

  it('fails waiting sends as closed on the way down', async () => {
    const w = world();
    await w.up();
    w.client.script('sendIm', 'hold');
    const running = w.session.sendIm('alice', 'one');
    const waiting = w.session.sendIm('alice', 'two');
    await settle();
    w.drop({ kind: 'closed', close: 'eof' });
    await expect(waiting).rejects.toMatchObject({ code: 'closed' });
    w.client.held[0]?.reject(new OscarError({ kind: 'connection-lost' }));
    await expect(running).rejects.toMatchObject({ code: 'closed' });
    expect(w.client.callsTo('sendIm')).toHaveLength(1);
  });

  it('fails waiting sends as closed on stop', async () => {
    const w = world();
    await w.up();
    w.client.script('sendIm', 'hold');
    void w.session.sendIm('alice', 'one').catch(() => {});
    const waiting = w.session.sendIm('alice', 'two');
    await settle();
    await w.session.stop();
    await expect(waiting).rejects.toMatchObject({ code: 'closed' });
  });

  it('sets away as HTML, clears it with null, and maps a refusal', async () => {
    const w = world();
    await w.up();
    await w.session.setAway('<B>out</B>');
    await w.session.setAway(null);
    expect(w.client.callsTo('setAway')).toEqual([[{ html: '<B>out</B>' }], [null]]);
    w.client.script('setAway', { reject: new OscarError({ kind: 'local', code: 'text-too-long' }) });
    await expect(w.session.setAway('long')).rejects.toMatchObject({ code: 'too-long' });
  });

  it('stops the typing keepalive on the way down', async () => {
    const w = world();
    await w.up();
    w.session.sendTyping('alice', 'typing');
    expect(w.client.callsTo('sendTyping')).toEqual([['alice', 'typing']]);
    w.drop({ kind: 'closed', close: 'eof' });
    await w.timers.advance(1999);
    expect(w.client.callsTo('sendTyping')).toHaveLength(1);
  });

  it('sends no typing notice while the rate is limited', async () => {
    const w = world();
    await w.up();
    w.client.emit('rate', { limited: true });
    w.session.sendTyping('alice', 'typing');
    expect(w.client.callsTo('sendTyping')).toHaveLength(0);
  });
});

describe('events', () => {
  const seen = <E extends keyof OscarEvents>(w: World, event: E): OscarEvents[E][] => {
    const out: OscarEvents[E][] = [];
    w.session.on(event, (payload) => out.push(payload));
    return out;
  };
  const arrival = (screenName: string, away = false): BuddyPresence => ({ screenName, online: true, away, idleSince: null, signedOnAt: null, warnLevel: 0 });

  it('maps an IM and an invitation', async () => {
    const w = world();
    const ims = seen(w, 'im');
    const invites = seen(w, 'invite');
    await w.up();
    const im: IncomingIm = { from: 'Alice B', body: [], autoResponse: false, at: 5, offline: false, serverNotice: false, wire: { cookie: '00000000000000ff', html: '<B>hi</B>' } } as IncomingIm;
    w.client.emit('im', im);
    expect(ims).toEqual([{ from: 'aliceb', fromDisplay: 'Alice B', text: 'hi', cookie: 255n, autoResponse: false, offline: false, system: false }]);
    const invite = { id: 'alice:00000000000000a1', from: 'Alice', room: { exchange: 4, name: 'Den' }, message: [], at: 0, wire: { html: 'come' } } as unknown as Invite;
    w.client.emit('roomInvite', invite);
    expect(invites).toEqual([{ from: 'alice', fromDisplay: 'Alice', room: { exchange: 4, name: 'den' }, roomCookie: 'alice:00000000000000a1', text: 'come' }]);
    // An invitation the plugin leaves alone must not count toward the client's cap on open ones.
    expect(w.client.callsTo('forgetInvite')).toEqual([['alice:00000000000000a1']]);
  });

  it('maps presence with the time it was seen, and forgets it on the way down', async () => {
    const w = world();
    const presence = seen(w, 'presence');
    await w.up();
    await w.timers.advance(700);
    const at = w.timers.now();
    w.client.presence.set('Alice B', arrival('Alice B', true));
    w.client.emit('presence', arrival('Alice B', true));
    expect(presence).toEqual([{ name: 'aliceb', online: true, away: true, at }]);
    await w.timers.advance(300);
    expect(w.session.presenceOf('Alice B')).toEqual({ online: true, away: true, at });
    expect(w.session.presenceOf('nobody')).toBeUndefined();
    w.drop({ kind: 'closed', close: 'eof' });
    expect(w.session.presenceOf('Alice B')).toBeUndefined();
  });

  it('maps the rate of the IM class to a rate event scoped to bos', async () => {
    const w = world();
    const rates = seen(w, 'rate');
    await w.up();
    w.client.emit('rate', { limited: true });
    w.client.emit('rate', { limited: false });
    expect(rates).toEqual([
      { scope: 'bos', status: 'limited' },
      { scope: 'bos', status: 'clear' },
    ]);
  });

  it('joins the wanted rooms again after each sign-on and closes them on the way down', async () => {
    const w = world();
    const ready = seen(w, 'roomReady');
    const closed = seen(w, 'roomClosed');
    await w.session.joinRoom({ exchange: 4, name: 'Den' }, { persistent: true });
    await w.up();
    await settle();
    expect(ready).toEqual([{ room: { exchange: 4, name: 'den' }, occupants: [] }]);
    w.drop({ kind: 'closed', close: 'eof' });
    expect(closed).toEqual([{ room: { exchange: 4, name: 'den' }, willRejoin: true }]);
    await w.timers.advance(2000);
    await settle();
    expect(ready).toHaveLength(2);
  });

  it('refreshes the buddy list only while online, and logs a refusal', async () => {
    const lines: string[] = [];
    const w = world({ log: { ...quietLog, warn: (msg) => lines.push(msg) } });
    w.session.updateBuddies();
    expect(w.client.callsTo('refreshSessionBuddies')).toHaveLength(0);
    await w.up();
    w.client.script('refreshSessionBuddies', { reject: new OscarError({ kind: 'connection-lost' }) });
    w.session.updateBuddies();
    await settle();
    expect(w.client.callsTo('refreshSessionBuddies')).toHaveLength(1);
    expect(lines).toContain('buddy list update failed');
  });

  it('keeps going when a listener throws', async () => {
    const w = world();
    const states: string[] = [];
    w.session.on('state', () => {
      throw new Error('boom');
    });
    w.session.on('state', (s) => states.push(s.phase));
    await w.up();
    expect(states).toEqual(['connecting', 'online']);
  });
});

describe('the password check', () => {
  it('keeps the password-check cache for 24 h and probes only after a first login', async () => {
    const w = world();
    expect(await w.session.probePasswordCheck()).toBe('unknown');
    expect(probeLogin).not.toHaveBeenCalled();
    await w.up();
    const taken = w.taken.count;
    expect(await w.session.probePasswordCheck()).toBe('checks');
    expect(w.taken.count).toBe(taken + 1);
    expect(vi.mocked(probeLogin).mock.calls[0]?.[0]).toMatchObject({ host: 'oscar.example', port: 5190, tls: false, screenName: 'botone' });
    await w.timers.advance(PASSWORD_CHECK_CACHE_MS - 1);
    expect(await w.session.probePasswordCheck()).toBe('checks');
    expect(probeLogin).toHaveBeenCalledTimes(1);
    await w.timers.advance(1);
    vi.mocked(probeLogin).mockResolvedValue('does-not-check');
    expect(await w.session.probePasswordCheck()).toBe('does-not-check');
    expect(probeLogin).toHaveBeenCalledTimes(2);
  });

  it('shares one probe between callers that overlap, and does not keep unknown', async () => {
    const w = world();
    await w.up();
    vi.mocked(probeLogin).mockResolvedValue('unknown');
    const [a, b] = await Promise.all([w.session.probePasswordCheck(), w.session.probePasswordCheck()]);
    expect([a, b]).toEqual(['unknown', 'unknown']);
    expect(probeLogin).toHaveBeenCalledTimes(1);
    await w.session.probePasswordCheck();
    expect(probeLogin).toHaveBeenCalledTimes(2);
  });
});

describe('what the package gives the session', () => {
  const rows: [number, number, number][] = [
    [1, 0, 2000],
    [2, 0, 4000],
    [3, 0, 60_000],
    [4, 0, 60_000],
    [6, 0, 64_000],
    [7, 0, 120_000],
    [20, 0, 120_000],
    [1, 1, 2400],
    [7, 1, 144_000],
    [3, 0.5, 66_000],
  ];
  it.each(rows)('failure %i with random %d waits %i ms', (failures, random, want) => {
    expect(backoffDelay(failures, random)).toBe(want);
  });

  it('staggers logins 2 s apart and allows 8 per minute', async () => {
    const timers = new ManualTimers();
    const budget = createLoginBudget({ now: timers.now, timers: timers.api });
    const start = timers.now();
    const granted: number[] = [];
    for (let i = 0; i < 10; i++) void budget.take().then(() => granted.push(timers.now() - start));
    await timers.advance(0);
    expect(granted).toEqual([0]);
    await timers.advance(59_999);
    expect(granted).toEqual([0, 2000, 4000, 6000, 8000, 10_000, 12_000, 14_000]);
    await timers.advance(2001);
    expect(granted).toEqual([0, 2000, 4000, 6000, 8000, 10_000, 12_000, 14_000, 60_000, 62_000]);
  });

  it('grants a login at once after a quiet spell', async () => {
    const timers = new ManualTimers();
    const budget = createLoginBudget({ now: timers.now, timers: timers.api });
    await budget.take();
    await timers.advance(5000);
    let granted = false;
    void budget.take().then(() => (granted = true));
    await timers.advance(0);
    expect(granted).toBe(true);
  });

  it('shares its error classes with the client kit', async () => {
    const wire = await import('open-oscar-client-kit/wire');
    expect(OscarSendError).toBe(wire.OscarSendError);
    expect(OscarRoomError).toBe(wire.OscarRoomError);
  });

  it('makes the session the package exports', () => {
    const timers = new ManualTimers();
    const session = createOscarSession({
      host: '127.0.0.1',
      port: 1,
      tls: false,
      redirect: 'auto',
      screenName: 'botone',
      getPassword: async () => 'x',
      buddies: () => [],
      log: quietLog,
      loginBudget: { take: async () => {} },
      now: timers.now,
      timers: timers.api,
    });
    expect(session).toBeInstanceOf(KitSession);
    expect(session.getState().phase).toBe('idle');
  });
});

describe('Direct IM on the session', () => {
  const ID = 'alicesmith:00000000000000aa';
  const status = (over: Partial<DirectImStatus>): DirectImStatus => ({ id: ID, peer: 'Alice Smith', role: 'receiving', state: 'open', verified: false, ...over });
  const text = { id: ID, from: 'Alice Smith', at: 1, autoResponse: false, parts: [], attachments: [], unreferenced: 0, damaged: false };

  function listen() {
    const w = world();
    const states: OscarEvents['directIm'][] = [];
    const messages: OscarEvents['directMessage'][] = [];
    w.session.on('directIm', (e) => states.push(e));
    w.session.on('directMessage', (e) => messages.push(e));
    return { ...w, states, messages };
  }

  it('reports a session once when it opens and once when it ends', () => {
    const w = listen();
    w.client.emit('directIm', status({ state: 'waiting' }));
    w.client.emit('directIm', status({ state: 'connecting' }));
    w.client.emit('directIm', status({}));
    w.client.emit('directIm', status({ verified: true }));
    w.client.emit('directIm', status({ state: 'closed', end: 'peer-closed', by: 'peer', verified: true }));
    expect(w.states).toEqual([
      { id: ID, peer: 'alicesmith', role: 'receiving', state: 'open' },
      { id: ID, peer: 'alicesmith', role: 'receiving', state: 'closed', end: 'peer-closed', by: 'peer' },
    ]);
  });

  it('passes on a message only while its session is live', () => {
    const w = listen();
    w.client.emit('directMessage', text);
    w.client.emit('directIm', status({}));
    w.client.emit('directMessage', text);
    w.client.emit('directIm', status({ state: 'closed', end: 'closed', by: 'self' }));
    w.client.emit('directMessage', text);
    expect(w.messages).toHaveLength(1);
  });

  it('reports a session the bot offered, once when it opens, and passes on its messages', () => {
    const w = listen();
    w.client.emit('directMessage', text);
    w.client.emit('directIm', status({ role: 'offering', state: 'waiting' }));
    w.client.emit('directIm', status({ role: 'offering', state: 'connecting' }));
    w.client.emit('directIm', status({ role: 'offering' }));
    w.client.emit('directIm', status({ role: 'offering', verified: true }));
    w.client.emit('directMessage', text);
    w.client.emit('directIm', status({ role: 'offering', state: 'closed', end: 'closed', by: 'peer', verified: true }));
    w.client.emit('directMessage', text);
    expect(w.states).toEqual([
      { id: ID, peer: 'alicesmith', role: 'offering', state: 'open' },
      { id: ID, peer: 'alicesmith', role: 'offering', state: 'closed', end: 'closed', by: 'peer' },
    ]);
    expect(w.messages).toHaveLength(1);
  });

  it('reports a session the bot offered that ended before it opened', () => {
    const w = listen();
    w.client.emit('directIm', status({ role: 'offering', state: 'waiting' }));
    w.client.emit('directIm', status({ role: 'offering', state: 'closed', end: 'timed-out' }));
    expect(w.states).toEqual([{ id: ID, peer: 'alicesmith', role: 'offering', state: 'closed', end: 'timed-out' }]);
  });

  it('hands accept, decline and close to the client', async () => {
    const w = listen();
    await w.session.acceptDirectIm(ID);
    await w.session.declineDirectIm(ID);
    await w.session.closeDirectIm(ID);
    expect(w.client.calls.map((c) => [c.method, ...c.args])).toEqual([
      ['acceptDirectIm', ID],
      ['declineDirectIm', ID],
      ['closeDirectIm', ID],
    ]);
  });
});

describe('Send File on the session', () => {
  const ID = 'alicesmith:00000000000000bb';
  const status = (over: Partial<TransferStatus>): TransferStatus => ({
    id: ID,
    direction: 'in',
    peer: 'Alice Smith',
    state: 'transferring',
    count: 1,
    index: 0,
    name: 'notes.md',
    bytesDone: 0,
    bytesTotal: 10,
    ...over,
  });

  function listen() {
    const w = world();
    const offers: OscarEvents['fileOffer'][] = [];
    const transfers: OscarEvents['transfer'][] = [];
    w.session.on('fileOffer', (e) => offers.push(e));
    w.session.on('transfer', (e) => transfers.push(e));
    return { ...w, offers, transfers };
  }

  it('passes on a file offer', () => {
    const w = listen();
    w.client.emit('fileOffer', { id: ID, from: 'Alice Smith', count: 1, totalBytes: 10, name: 'notes.md', folder: null, at: 1 });
    expect(w.offers).toEqual([{ id: ID, from: 'alicesmith', fromDisplay: 'Alice Smith', count: 1, totalBytes: 10, name: 'notes.md', folder: false }]);
  });

  it('passes on each step of a transfer, in and out, with its direction', () => {
    const w = listen();
    w.client.emit('transfer', status({ direction: 'out', state: 'waiting' }));
    w.client.emit('transfer', status({ direction: 'out', state: 'done', bytesDone: 10 }));
    w.client.emit('transfer', status({}));
    w.client.emit('transfer', status({ bytesDone: 4 }));
    w.client.emit('transfer', status({ state: 'failed', failure: 'file-problem', bytesDone: 4 }));
    expect(w.transfers).toEqual([
      { id: ID, peer: 'alicesmith', direction: 'out', state: 'waiting', index: 0, bytesDone: 0 },
      { id: ID, peer: 'alicesmith', direction: 'out', state: 'done', index: 0, bytesDone: 10 },
      { id: ID, peer: 'alicesmith', direction: 'in', state: 'transferring', index: 0, bytesDone: 0 },
      { id: ID, peer: 'alicesmith', direction: 'in', state: 'transferring', index: 0, bytesDone: 4 },
      { id: ID, peer: 'alicesmith', direction: 'in', state: 'failed', failure: 'file-problem', index: 0, bytesDone: 4 },
    ]);
  });

  it('hands accept, decline and cancel to the client', async () => {
    const w = listen();
    const sink: FileSink = { begin: async () => ({ write: async () => {}, finish: async () => {}, abort: async () => {} }) };
    await w.session.acceptFileOffer(ID, sink);
    await w.session.declineFileOffer(ID);
    await w.session.cancelTransfer(ID);
    expect(w.client.calls.map((c) => [c.method, ...c.args])).toEqual([
      ['acceptFileOffer', ID, sink],
      ['declineFileOffer', ID],
      ['cancelTransfer', ID],
    ]);
  });
});

describe('sending from the session', () => {
  const file: OutgoingFile = { name: 'notes.md', bytes: 3, modifiedAt: 0, read: async function* () { yield Uint8Array.of(1, 2, 3); } };
  const picture = { name: 'dot.gif', bytes: Uint8Array.of(1), width: 1, height: 1 };

  it('hands sendFiles, openDirectIm and sendDirectMessage to the client', async () => {
    const w = world();
    await w.up();
    expect(await w.session.sendFiles('alice', [file])).toBe('alice:0000000000000001');
    expect(await w.session.openDirectIm('alice')).toBe('alice:0000000000000002');
    await w.session.sendDirectMessage('alice:0000000000000002', { pictures: [picture] });
    expect(w.client.calls.filter((c) => c.method !== 'signOnWith').map((c) => [c.method, ...c.args])).toEqual([
      ['sendFiles', 'alice', [file]],
      ['openDirectIm', 'alice'],
      ['sendDirectMessage', 'alice:0000000000000002', { pictures: [picture] }],
    ]);
  });

  it('rejects each of the three when the session is not online, without the client', async () => {
    const w = world();
    for (const call of [
      () => w.session.sendFiles('alice', [file]),
      () => w.session.openDirectIm('alice'),
      () => w.session.sendDirectMessage('alice:0000000000000002', { pictures: [picture] }),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: 'not-online' });
    }
    expect(w.client.calls).toEqual([]);
  });

  it('passes on what the client rejects with', async () => {
    const w = world();
    await w.up();
    const refused = new OscarError({ kind: 'local', code: 'invalid-argument' });
    w.client.script('sendFiles', { reject: refused });
    w.client.script('openDirectIm', { reject: refused });
    w.client.script('sendDirectMessage', { reject: refused });
    await expect(w.session.sendFiles('alice', [file])).rejects.toBe(refused);
    await expect(w.session.openDirectIm('alice')).rejects.toBe(refused);
    await expect(w.session.sendDirectMessage('alice:0000000000000002', { pictures: [picture] })).rejects.toBe(refused);
  });
});
