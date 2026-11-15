import { afterEach, describe, expect, it } from 'vitest';
import { settle, waitFor } from 'open-oscar-client-kit/testing';
import type { FakeOscarServer, FakePeer } from 'open-oscar-client-kit/testing';
import { clearBos, holdAcks, imTexts, liftImLimit, limitBos, muteRateNotices, startServer } from '../fake/kit.js';
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

  it('treats a missing receipt as a silent drop: goes quiet, then retries once with the same cookie', async () => {
    await boot(false);
    limitBos(server, 'botone', { silent: true });
    const send = h.session.sendIm('alice', 'dropped once');
    await waitFor(() => imSends(server, 'botone').length === 1, 'first attempt');
    await h.timers.advance(10_000);
    await waitFor(() => h.rates.at(-1)?.status === 'limited', 'limited event');
    // The model wants about 26 s of silence, counted from the dropped send.
    await h.timers.advance(15_000);
    expect(imSends(server, 'botone')).toHaveLength(1);
    clearBos(server, 'botone');
    await h.timers.advance(2000);
    const receipt = await send;
    const sends = imSends(server, 'botone');
    expect(sends).toHaveLength(2);
    expect(sends[0]?.cookie).toBe(sends[1]?.cookie);
    expect(receipt.id).toBe(sends[0]?.cookie.toString(16).padStart(16, '0'));
    expect(imTexts(alice)).toHaveLength(1);
  });

  it('takes an ack that lands after the 10 s window as the receipt and does not say the IM twice', async () => {
    await boot(false);
    const release = holdAcks(server);
    const send = h.session.sendIm('alice', 'slow ack');
    await waitFor(() => imSends(server, 'botone').length === 1, 'first attempt');
    await h.timers.advance(10_000);
    await waitFor(() => h.rates.at(-1)?.status === 'limited', 'limited event');
    release();
    const receipt = await send;
    expect(receipt.id).toBe(imSends(server, 'botone')[0]?.cookie.toString(16).padStart(16, '0'));
    await h.timers.advance(60_000);
    await settle(server.port);
    expect(imSends(server, 'botone')).toHaveLength(1);
    expect(imTexts(alice).map((m) => m.text)).toEqual(['slow ack']);
  });

  it('sends the next IM normally after a late ack', async () => {
    await boot(false);
    const release = holdAcks(server);
    const send = h.session.sendIm('alice', 'one');
    await waitFor(() => imSends(server, 'botone').length === 1, 'first attempt');
    await h.timers.advance(10_000);
    await waitFor(() => h.rates.at(-1)?.status === 'limited', 'limited event');
    release();
    await send;
    const next = h.session.sendIm('alice', 'two');
    await h.timers.advance(60_000);
    await next;
    expect(imTexts(alice).map((m) => m.text)).toEqual(['one', 'two']);
    expect(imSends(server, 'botone')).toHaveLength(2);
  });

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
