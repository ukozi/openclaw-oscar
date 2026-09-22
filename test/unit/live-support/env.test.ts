import { describe, expect, it } from 'vitest';
import { liveEnv } from '../../live/support/env.js';
import { holds, until } from '../../live/support/wait.js';

const remote = {
  OSCAR_LIVE_HOST: 'oscar.example.net', OSCAR_LIVE_USER_A: 'botone', OSCAR_LIVE_PASS_A: 'aaaa1111',
  OSCAR_LIVE_USER_B: 'alice', OSCAR_LIVE_PASS_B: 'bbbb2222',
};

describe('live env', () => {
  it('is off with nothing set', () => {
    expect(liveEnv({})).toEqual({ mode: 'off' });
  });

  it('reads a local binary and its generation', () => {
    expect(liveEnv({ OOS_BIN: '/opt/oos/server', OOS_GENERATION: 'v0.24' })).toEqual({ mode: 'local', bin: '/opt/oos/server', generation: 'v0.24' });
  });

  it('refuses a local binary without a generation', () => {
    expect(() => liveEnv({ OOS_BIN: '/opt/oos/server' })).toThrow(/OOS_GENERATION/);
    expect(() => liveEnv({ OOS_BIN: '/opt/oos/server', OOS_GENERATION: 'latest' })).toThrow(/OOS_GENERATION/);
  });

  it('reads a remote host with defaults', () => {
    expect(liveEnv(remote)).toEqual({
      mode: 'remote', host: 'oscar.example.net', port: 5190, tls: false, room: 'smoketest',
      a: { screenName: 'botone', password: 'aaaa1111' }, b: { screenName: 'alice', password: 'bbbb2222' },
    });
  });

  it('reads remote TLS, port, CA and room', () => {
    const got = liveEnv({ ...remote, OSCAR_LIVE_TLS: '1', OSCAR_LIVE_PORT: '5193', OSCAR_LIVE_CA_FILE: '/etc/ssl/ca.pem', OSCAR_LIVE_ROOM: 'proving' });
    expect(got).toEqual({
      mode: 'remote', host: 'oscar.example.net', port: 5193, tls: true, caFile: '/etc/ssl/ca.pem', room: 'proving',
      a: { screenName: 'botone', password: 'aaaa1111' }, b: { screenName: 'alice', password: 'bbbb2222' },
    });
  });

  it('names every missing remote variable', () => {
    expect(() => liveEnv({ OSCAR_LIVE_HOST: 'oscar.example.net', OSCAR_LIVE_USER_A: 'botone' })).toThrow(
      /OSCAR_LIVE_PASS_A, OSCAR_LIVE_USER_B, OSCAR_LIVE_PASS_B/,
    );
  });

  it('refuses a bad port and a double target', () => {
    expect(() => liveEnv({ ...remote, OSCAR_LIVE_PORT: '0' })).toThrow(/port/);
    expect(() => liveEnv({ ...remote, OOS_BIN: '/opt/oos/server', OOS_GENERATION: 'main' })).toThrow(/not both/);
  });
});

describe('wait helpers', () => {
  it('until returns the first truthy value', async () => {
    let n = 0;
    expect(await until(() => (++n >= 3 ? n : 0), { timeoutMs: 1000, everyMs: 5, what: 'three' })).toBe(3);
  });

  it('until names what it waited for', async () => {
    await expect(until(() => false, { timeoutMs: 30, everyMs: 5, what: 'the impossible' })).rejects.toThrow(/the impossible/);
  });

  it('holds fails as soon as the probe turns false', async () => {
    let n = 0;
    await expect(holds(() => ++n < 3, { forMs: 500, everyMs: 5, what: 'calm' })).rejects.toThrow(/calm/);
  });
});
