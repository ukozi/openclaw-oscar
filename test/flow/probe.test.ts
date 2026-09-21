import { afterEach, describe, expect, it } from 'vitest';
import { strongHash } from '../../src/oscar/auth.js';
import { toHex } from '../../src/oscar/bytes.js';
import { decodeTlvs, findTlv } from '../../src/oscar/tlv.js';
import { checkLogin, checkPasswordEnforced } from '../../src/oscar/index.js';
import { captureLog, makeSession, stopAllSessions } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';

let server: FakeOscarServer;

afterEach(async () => {
  await stopAllSessions();
  await server.stop();
});

const logins = (): string[] =>
  server
    .snacsFrom('botone')
    .filter((s) => s.conn === 'auth' && s.subtype === 0x02)
    .map((s) => toHex(findTlv(decodeTlvs(s.body), 0x25) ?? new Uint8Array()));

describe('password-check probe', () => {
  it('runs when asked, with a random hash, and leaves the live session alone', async () => {
    server = await FakeOscarServer.start();
    server.addUser('botone', 'botpass1');
    const h = makeSession(server);
    h.session.start();
    await h.online();
    expect(logins()).toHaveLength(1);
    expect(await h.session.probePasswordCheck()).toBe('checks');
    const [real, probe] = logins();
    expect(real).toBe(toHex(strongHash('botpass1', 'salt-botone')));
    expect(probe).toHaveLength(32);
    expect(probe).not.toBe(real);
    expect(h.states.map((s) => s.phase)).toEqual(['connecting', 'online']);
    expect(server.snacsFrom('botone').filter((s) => s.conn === 'bos' && s.family === 1 && s.subtype === 0x17)).toHaveLength(1);
    expect(h.timers.pending()).toEqual([60_000, 90_000]);
  });

  it('reports a server that accepts a wrong password and leaves the decision to the caller', async () => {
    server = await FakeOscarServer.start({ disableAuth: true });
    server.addUser('botone', 'botpass1');
    const h = makeSession(server);
    h.session.start();
    await h.online();
    expect(await h.session.probePasswordCheck()).toBe('does-not-check');
    expect(h.session.getState().phase).toBe('online');
    expect(server.sessionOf('botone')).toBeDefined();
  });

  it('caches the answer for 24 hours, and overlapping callers share one probe', async () => {
    server = await FakeOscarServer.start();
    server.addUser('botone', 'botpass1');
    const h = makeSession(server);
    h.session.start();
    await h.online();
    expect(await Promise.all([h.session.probePasswordCheck(), h.session.probePasswordCheck()])).toEqual(['checks', 'checks']);
    await h.session.probePasswordCheck();
    expect(logins()).toHaveLength(2);
    await h.session.stop();
    await h.timers.advance(24 * 60 * 60 * 1000);
    expect(await h.session.probePasswordCheck()).toBe('checks');
    expect(logins()).toHaveLength(3);
  });

  it('never probes before a real login has succeeded, so it cannot create an account', async () => {
    server = await FakeOscarServer.start({ disableAuth: true });
    const h = makeSession(server);
    expect(await h.session.probePasswordCheck()).toBe('unknown');
    expect(server.snacsFrom('botone')).toEqual([]);
  });

  it('reports unknown when the login limiter answers, and asks again next time', async () => {
    server = await FakeOscarServer.start({ loginLimit: 1 });
    server.addUser('botone', 'botpass1');
    const h = makeSession(server);
    h.session.start();
    await h.online();
    const authConnections = (): number => h.logs.lines.filter((l) => l.msg === 'oscar connection open' && l.fields?.['conn'] === 'auth').length;
    expect(await h.session.probePasswordCheck()).toBe('unknown');
    expect(authConnections()).toBe(2);
    expect(await h.session.probePasswordCheck()).toBe('unknown');
    expect(authConnections()).toBe(3);
    expect(h.session.getState().phase).toBe('online');
  });

  it('takes a slot from the shared login budget', async () => {
    server = await FakeOscarServer.start();
    server.addUser('botone', 'botpass1');
    let taken = 0;
    const h = makeSession(server, {
      loginBudget: {
        take: async () => {
          taken++;
        },
      },
    });
    h.session.start();
    await h.online();
    expect(taken).toBe(1);
    await h.session.probePasswordCheck();
    expect(taken).toBe(2);
  });
});

describe('checkLogin and checkPasswordEnforced, the setup-time checks that stop at the cookie', () => {
  const base = (over: Partial<Parameters<typeof checkPasswordEnforced>[0]> = {}): Parameters<typeof checkPasswordEnforced>[0] => ({
    host: '127.0.0.1',
    port: server.port,
    tls: false,
    redirect: 'auto',
    screenName: 'botone',
    log: captureLog().log,
    timeoutMs: 3000,
    ...over,
  });

  it('accept the right password without touching a live session of the same name', async () => {
    server = await FakeOscarServer.start();
    server.addUser('botone', 'botpass1');
    const h = makeSession(server);
    h.session.start();
    await h.online();
    expect(await checkLogin({ ...base(), password: 'botpass1' })).toEqual({
      ok: true,
      bosHost: '127.0.0.1',
      bosPort: server.port,
      redirectProblem: null,
    });
    expect(await checkPasswordEnforced(base())).toBe('checks');
    expect(h.session.getState().phase).toBe('online');
    expect(h.states.map((s) => s.phase)).toEqual(['connecting', 'online']);
    expect(server.snacsFrom('botone').filter((s) => s.conn === 'bos' && s.family === 1 && s.subtype === 0x17)).toHaveLength(1);
  });

  it('report a bad password, an unknown name and a server that is not there', async () => {
    server = await FakeOscarServer.start();
    server.addUser('botone', 'botpass1');
    expect(await checkLogin({ ...base(), password: 'wrong123' })).toEqual({ ok: false, reason: 'bad-password' });
    expect(await checkLogin({ ...base({ screenName: 'nobody' }), password: 'botpass1' })).toEqual({ ok: false, reason: 'unknown-name' });
    // A UIN with no account comes back as 0x0008 (foodgroup/auth.go:566-574), not 0x0001.
    expect(await checkLogin({ ...base({ screenName: '123456789' }), password: 'botpass1' })).toEqual({
      ok: false,
      reason: 'unknown-name',
    });
    expect(await checkPasswordEnforced(base({ screenName: '123456789' }))).toBe('checks');
    expect(await checkLogin({ ...base({ port: 1 }), password: 'botpass1' })).toMatchObject({ ok: false, reason: 'network' });
    expect(await checkPasswordEnforced(base({ port: 1 }))).toBe('unknown');
  });

  it('tell a server that checks passwords from one that does not', async () => {
    server = await FakeOscarServer.start({ disableAuth: true });
    server.addUser('botone', 'botpass1');
    expect(await checkPasswordEnforced(base())).toBe('does-not-check');
    expect(server.sessionOf('botone')).toBeUndefined();
  });

  it('say what the redirect rule did', async () => {
    server = await FakeOscarServer.start({ advertisedHost: ':0' });
    server.addUser('botone', 'botpass1');
    const unreadable = await checkLogin({ ...base(), password: 'botpass1' });
    expect(unreadable).toMatchObject({ ok: true, bosHost: '127.0.0.1', bosPort: server.port });
    expect(unreadable.ok && unreadable.redirectProblem).toContain('cannot be read');
    const pinned = await checkLogin({ ...base({ redirect: 'pin' }), password: 'botpass1' });
    expect(pinned).toMatchObject({ ok: true, redirectProblem: null });
  });

  it('flag a TLS session that the server would send to plaintext', async () => {
    server = await FakeOscarServer.start({ tls: true, generation: 'v0.24', advertisedHost: 'bos.example.net:5190' });
    server.addUser('botone', 'botpass1');
    const result = await checkLogin({ ...base({ tls: true, caFile: server.caFile }), password: 'botpass1' });
    expect(result).toMatchObject({ ok: true, bosHost: '127.0.0.1', bosPort: server.port });
    expect(result.ok && result.redirectProblem).toContain('without TLS');
    const followed = await checkLogin({ ...base({ tls: true, caFile: server.caFile, redirect: 'follow' }), password: 'botpass1' });
    expect(followed).toMatchObject({ ok: false, reason: 'tls' });
    expect(!followed.ok && followed.detail).toContain('bos.example.net:5190');
  });
});
