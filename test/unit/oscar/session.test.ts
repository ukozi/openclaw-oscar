import { decodeTlvs, tlvStr, tlvU8 } from 'open-oscar-client-kit/wire';
import { ManualTimers, waitFor } from 'open-oscar-client-kit/testing';
import type { FakeOscarServer } from 'open-oscar-client-kit/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { OscarRoomError, OscarSendError, createLoginBudget } from '../../../src/oscar/index.js';
import { OscarSessionImpl, backoffDelay } from '../../../src/oscar/session.js';
import { startServer } from '../../fake/kit.js';
import { makeSession, stopAllSessions } from '../../fake/session-harness.js';

describe('backoffDelay', () => {
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
});

describe('createLoginBudget', () => {
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

  it('grants at once after a quiet spell', async () => {
    const timers = new ManualTimers();
    const budget = createLoginBudget({ now: timers.now, timers: timers.api });
    await budget.take();
    await timers.advance(5000);
    let granted = false;
    void budget.take().then(() => (granted = true));
    await timers.advance(0);
    expect(granted).toBe(true);
  });
});

describe('the hooks rooms are wired to', () => {
  it('has the service request and the channel 2 source', () => {
    expect(typeof OscarSessionImpl.prototype.resolveService).toBe('function');
    expect(typeof OscarSessionImpl.prototype.onChannel2).toBe('function');
  });
});

describe('what the session takes from the client kit', () => {
  let server: FakeOscarServer | undefined;

  afterEach(async () => {
    await stopAllSessions();
    await server?.stop();
    server = undefined;
  });

  async function signOn() {
    server = await startServer();
    server.addUser('botone', 'botpass1');
    const h = makeSession(server);
    h.session.start();
    await h.online();
    return { server, h };
  }

  const logins = (s: FakeOscarServer) =>
    s.snacsFrom('botone').filter((snac) => snac.conn === 'auth' && snac.family === 0x17 && snac.subtype === 0x02);

  it('logs in with the plugin client ID and the single-session flag', async () => {
    const { server: s } = await signOn();
    const tlvs = decodeTlvs(logins(s)[0]?.body ?? new Uint8Array());
    expect(tlvStr(tlvs, 0x0003)).toBe('openclaw-oscar');
    expect(tlvU8(tlvs, 0x004a)).toBe(0x03);
  });

  it('the password probe sends the same client ID and flag', async () => {
    const { server: s, h } = await signOn();
    expect(await h.session.probePasswordCheck()).toBe('checks');
    await waitFor(() => logins(s).length === 2, 'the probe login');
    const tlvs = decodeTlvs(logins(s)[1]?.body ?? new Uint8Array());
    expect(tlvs.map((t) => t.tag)).toEqual([0x01, 0x25, 0x03, 0x4a]);
    expect(tlvStr(tlvs, 0x0003)).toBe('openclaw-oscar');
    expect(tlvU8(tlvs, 0x004a)).toBe(0x03);
  });

  it('shares its error classes with the client kit', async () => {
    const wire = await import('open-oscar-client-kit/wire');
    expect(OscarSendError).toBe(wire.OscarSendError);
    expect(OscarRoomError).toBe(wire.OscarRoomError);
  });
});
