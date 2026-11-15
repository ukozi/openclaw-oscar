import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { decodeTlvs, strongHash, tlvStr, tlvU8 } from 'open-oscar-client-kit/wire';
import type { OscarConnection } from 'open-oscar-client-kit/wire';
import { captureLog, settle } from 'open-oscar-client-kit/testing';
import type { FakeOscarServer } from 'open-oscar-client-kit/testing';
import { checkLogin, connectFailureReason, login, probeLogin, redirectProblem } from '../../../src/oscar/login.js';
import type { LoginOptions } from '../../../src/oscar/login.js';
import { caFile, startServer } from '../../fake/kit.js';

let server: FakeOscarServer | undefined;

afterEach(async () => {
  await server?.stop();
  server = undefined;
});

async function boot(opts: Parameters<typeof startServer>[0] = {}): Promise<FakeOscarServer> {
  server = await startServer(opts);
  server.addUser('botone', 'botpass1');
  return server;
}

function options(s: FakeOscarServer, over: Partial<LoginOptions> & { password?: string } = {}): LoginOptions {
  const { password = 'botpass1', ...rest } = over;
  return {
    host: '127.0.0.1',
    port: s.port,
    tls: false,
    redirect: 'auto',
    screenName: 'botone',
    hash: (key) => strongHash(password, key),
    log: captureLog().log,
    timeoutMs: 3000,
    ...rest,
  };
}

async function closedPort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as net.AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

describe('login', () => {
  it.each([
    ['a wrong password', { password: 'nope' }, { ok: false, reason: 'bad-password' }],
    ['a name the server does not know', { screenName: 'nobody' }, { ok: false, reason: 'unknown-name' }],
    ['a one-letter name', { screenName: 'a' }, { ok: false, reason: 'unknown-name', detail: 'screen name too short' }],
  ] as const)('%s', async (_title, over, want) => {
    const s = await boot();
    expect(await login(options(s, over))).toMatchObject(want);
  });

  it('sends nothing for a one-letter name', async () => {
    const s = await boot();
    await login(options(s, { screenName: 'a' }));
    expect(s.bucpLogins).toEqual([]);
    expect(s.snacsFrom('a')).toEqual([]);
  });

  it('a TLS server with no CA file fails as tls', async () => {
    const s = await boot({ tls: true });
    expect(await login(options(s, { tls: true }))).toMatchObject({ ok: false, reason: 'tls' });
  });

  it('a closed port fails as network', async () => {
    const s = await boot();
    expect(await login(options(s, { port: await closedPort() }))).toMatchObject({ ok: false, reason: 'network' });
  });

  it('sends the plugin client ID and the single-session flag', async () => {
    const s = await boot();
    expect((await login(options(s))).ok).toBe(true);
    expect(s.bucpLogins.map((l) => ({ clientId: l.clientId, multiConn: l.multiConn }))).toEqual([{ clientId: 'openclaw-oscar', multiConn: 0x03 }]);
    const sent = s.snacsFrom('botone').find((snac) => snac.conn === 'auth' && snac.family === 0x17 && snac.subtype === 0x02);
    const tlvs = decodeTlvs(sent?.body ?? new Uint8Array());
    expect(tlvs.map((t) => t.tag)).toEqual([0x01, 0x25, 0x03, 0x4a]);
    expect(tlvStr(tlvs, 0x03)).toBe('openclaw-oscar');
    expect(tlvU8(tlvs, 0x4a)).toBe(0x03);
  });

  it('pins an unroutable advertisement in auto mode and says why', async () => {
    const s = await boot({ advertisedHost: '169.254.10.1:5190' });
    const out = await login(options(s));
    expect(out).toMatchObject({ ok: true, host: '127.0.0.1', port: s.port, advertised: '169.254.10.1:5190', followedUnroutable: false });
    expect(out.ok && out.decision).toMatchObject({ pinned: true, why: 'unroutable' });
  });

  it('pins a loopback advertisement for a client that did not dial loopback', async () => {
    const s = await boot({ advertisedHost: '127.0.0.1:5190' });
    // 127.1 reaches the fake, and the redirect rule does not read it as loopback.
    const out = await login(options(s, { host: '127.1' }));
    expect(out).toMatchObject({ ok: true, host: '127.1', port: s.port });
    expect(out.ok && out.decision).toMatchObject({ pinned: true, why: 'loopback' });
  });

  it('follows it in follow mode and marks followedUnroutable', async () => {
    const s = await boot({ advertisedHost: '169.254.10.1:5190' });
    const out = await login(options(s, { host: '127.1', redirect: 'follow' }));
    expect(out).toMatchObject({ ok: true, host: '169.254.10.1', port: 5190, followedUnroutable: true });
    expect(out.ok && out.decision.pinned).toBe(false);
  });

  it('refuses a TLS session that follow would send to plaintext', async () => {
    const s = await boot({ tls: true, generation: 'v0.24', advertisedHost: 'bos.example.net:5190' });
    const out = await login(options(s, { tls: true, caFile: caFile(), redirect: 'follow' }));
    expect(out).toMatchObject({ ok: false, reason: 'tls' });
    expect(!out.ok && out.detail).toContain('bos.example.net:5190');
  });

  it('a login that stops at the cookie leaves no session on the server', async () => {
    const s = await boot();
    const tracked: OscarConnection[] = [];
    const out = await login(options(s, { track: (conn) => tracked.push(conn) }));
    expect(out.ok && out.cookie.length).toBeGreaterThan(0);
    await settle(s.port);
    expect(tracked).toHaveLength(1);
    expect(tracked[0]?.isOpen).toBe(false);
    expect(s.instancesOf('botone')).toBe(0);
    expect(s.snacsFrom('botone').every((snac) => snac.conn === 'auth')).toBe(true);
  });
});

describe('connectFailureReason', () => {
  it('names TLS failures, unroutable redirects and plain network errors', () => {
    const cert = Object.assign(new Error('self-signed certificate'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
    const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    expect(connectFailureReason(cert, false)).toBe('tls');
    expect(connectFailureReason(cert, true)).toBe('tls');
    expect(connectFailureReason(refused, true)).toBe('redirect-unroutable');
    expect(connectFailureReason(refused, false)).toBe('network');
  });
});

describe('checkLogin', () => {
  it('gives the redirect problem text as before', () => {
    const at = { host: '127.0.0.1', port: 5190 };
    const where = '10.0.0.1:5190';
    expect(redirectProblem({ ...at, pinned: true, why: 'unroutable' }, where, false)).toBe(
      'the server advertises 10.0.0.1:5190, which cannot be reached from here; using the configured address',
    );
    expect(redirectProblem({ ...at, pinned: true, why: 'loopback' }, where, false)).toBe(
      'the server advertises 10.0.0.1:5190, which cannot be reached from here; using the configured address',
    );
    expect(redirectProblem({ ...at, pinned: true, why: 'tls-mismatch' }, where, false)).toBe(
      'the server advertises 10.0.0.1:5190 without TLS; staying on the configured TLS address',
    );
    expect(redirectProblem({ ...at, pinned: true, why: 'malformed' }, where, false)).toBe(
      'the server advertises an address that cannot be read; using the configured address',
    );
    expect(redirectProblem({ ...at, pinned: false }, where, true)).toBe('redirect "follow" leads to 10.0.0.1:5190, which cannot be reached from here');
    expect(redirectProblem({ ...at, pinned: true, why: 'mode' }, where, false)).toBeNull();
    expect(redirectProblem({ ...at, pinned: false }, where, false)).toBeNull();
  });

  it('reports a followed unroutable address as a problem', async () => {
    const s = await boot({ advertisedHost: '169.254.10.1:5190' });
    const { hash: _hash, ...rest } = options(s, { host: '127.1', redirect: 'follow' });
    expect(await checkLogin({ ...rest, password: 'botpass1' })).toEqual({
      ok: true,
      bosHost: '169.254.10.1',
      bosPort: 5190,
      redirectProblem: 'redirect "follow" leads to 169.254.10.1:5190, which cannot be reached from here',
    });
  });

  it('leaves out the detail of a refusal that carries a code', async () => {
    const s = await boot();
    const { hash: _hash, ...rest } = options(s);
    expect(await checkLogin({ ...rest, password: 'wrong123' })).toEqual({ ok: false, reason: 'bad-password' });
  });
});

describe('probeLogin', () => {
  it('probeLogin answers checks, does-not-check and unknown', async () => {
    const checks = await boot();
    const { hash: _a, redirect: _b, ...probe } = options(checks);
    expect(await probeLogin(probe)).toBe('checks');
    expect(await probeLogin({ ...probe, screenName: 'nobody' })).toBe('checks');
    await checks.stop();

    const open = await boot({ disableAuth: true });
    expect(await probeLogin({ ...probe, port: open.port })).toBe('does-not-check');
    await settle(open.port);
    expect(open.instancesOf('botone')).toBe(0);
    await open.stop();
    server = undefined;

    expect(await probeLogin({ ...probe, port: await closedPort() })).toBe('unknown');
  });
});
