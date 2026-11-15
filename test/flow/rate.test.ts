import { afterEach, describe, expect, it } from 'vitest';
import { waitFor } from 'open-oscar-client-kit/testing';
import type { FakeOscarServer, FakePeer } from 'open-oscar-client-kit/testing';
import { clearBos, imTexts, liftImLimit, limitBos, muteRateNotices, startServer } from '../fake/kit.js';
import { imSends, makeSession, stopAllSessions } from '../fake/session-harness.js';
import type { Harness } from '../fake/session-harness.js';

let server: FakeOscarServer;
let alice: FakePeer;
let h: Harness;

async function boot(bot: boolean): Promise<void> {
  server = await startServer();
  server.addUser('botone', 'botpass1', { bot });
  if (bot) liftImLimit(server, 'botone');
  alice = server.peer('alice');
  h = makeSession(server);
  h.session.start();
  await h.online();
}

afterEach(async () => {
  await stopAllSessions();
  await server.stop();
});

describe('rate drop and recovery', () => {
  it('holds sends while the server says limited and releases them on clear', async () => {
    await boot(false);
    limitBos(server, 'botone');
    await waitFor(() => h.rates.at(-1)?.status === 'limited', 'limited event');
    expect(h.rates.at(-1)).toEqual({ scope: 'bos', status: 'limited' });
    let done = false;
    const send = h.session.sendIm('alice', 'held').then(() => (done = true));
    await h.timers.advance(5000);
    expect(imSends(server, 'botone')).toEqual([]);
    clearBos(server, 'botone');
    await send;
    expect(done).toBe(true);
    expect(h.rates.at(-1)).toEqual({ scope: 'bos', status: 'clear' });
    expect(imTexts(alice).map((m) => m.text)).toEqual(['held']);
  });

  it.todo('treats a missing receipt as a silent drop: goes quiet, then retries once with the same cookie');

  it.todo('takes an ack that lands after the 10 s window as the receipt and does not say the IM twice');

  it.todo('sends the next IM normally after a late ack');

  it('fails the send after the one retry is dropped too', async () => {
    await boot(false);
    limitBos(server, 'botone', { silent: true });
    const send = h.session.sendIm('alice', 'never arrives').catch((e: unknown) => e);
    await waitFor(() => imSends(server, 'botone').length === 1, 'first attempt');
    await h.timers.advance(10_000);
    await h.timers.advance(27_000);
    await waitFor(() => imSends(server, 'botone').length === 2, 'retry');
    await h.timers.advance(10_000);
    expect(await send).toMatchObject({ code: 'rate-limited' });
    expect(imSends(server, 'botone')).toHaveLength(2);
    expect(imTexts(alice)).toEqual([]);
  });

  it('paces an ordinary account: three at once, then it keeps the server average at the alert line', async () => {
    await boot(false);
    muteRateNotices(server);
    const sends = Array.from({ length: 5 }, (_, i) => h.session.sendIm('alice', `m${i}`));
    await waitFor(() => imTexts(alice).length === 3, 'three delivered');
    await h.timers.advance(2000);
    expect(imTexts(alice)).toHaveLength(3);
    await h.timers.advance(300);
    await waitFor(() => imTexts(alice).length === 4, 'fourth delivered');
    await h.timers.advance(4000);
    expect(imTexts(alice)).toHaveLength(4);
    await h.timers.advance(1000);
    await Promise.all(sends);
    expect(imTexts(alice).map((m) => m.text)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4']);
    expect(h.rates).toEqual([]);
  });

  it('does not pace a bot-flagged account', async () => {
    await boot(true);
    await Promise.all(Array.from({ length: 20 }, (_, i) => h.session.sendIm('alice', `m${i}`)));
    expect(imTexts(alice)).toHaveLength(20);
    expect(h.rates).toEqual([]);
  });
});
