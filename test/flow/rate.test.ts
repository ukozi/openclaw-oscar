import { afterEach, describe, expect, it } from 'vitest';
import { ManualTimers, settle, waitFor } from 'open-oscar-client-kit/testing';
import type { FakeOscarServer, FakePeer } from 'open-oscar-client-kit/testing';
import { FAMILY_OSERVICE, OSERVICE_RATE_PARAM_CHANGE, RATE_CLASS_IM, RATE_CODE_ALERT, RATE_CODE_CLEAR } from 'open-oscar-client-kit/wire';
import { clearBos, holdAcks, imTexts, liftImLimit, limitBos, muteRateNotices, startServer } from '../fake/kit.js';
import { imSends, makeSession, stopAllSessions } from '../fake/session-harness.js';
import type { Harness } from '../fake/session-harness.js';

let server: FakeOscarServer;
let alice: FakePeer;
let h: Harness;

// monitor: the server shares the session's clock, and with true its rate monitor runs each second.
async function boot(bot: boolean, monitor?: boolean): Promise<void> {
  const timers = new ManualTimers();
  server = await startServer(monitor === undefined ? {} : { now: timers.now, timers: timers.api, rateMonitor: monitor });
  server.addUser('botone', 'botpass1', { bot });
  if (bot) liftImLimit(server, 'botone');
  alice = server.peer('alice');
  h = makeSession(server, {}, timers);
  h.session.start();
  await h.online();
}

const hex = (cookie: bigint | undefined): string => (cookie ?? 0n).toString(16).padStart(16, '0');
const notices = (): number[] => server.rateNotices('botone').map((n) => n.code);
const holdRateNotices = (): (() => void) => server.withhold(FAMILY_OSERVICE, OSERVICE_RATE_PARAM_CHANGE);

// The IM is dropped by a limit the bot has not heard of yet; then it hears the notices.
async function dropOne(text: string): Promise<{ send: Promise<{ id: string }>; droppedAt: number }> {
  const release = holdRateNotices();
  limitBos(server, 'botone');
  const droppedAt = h.timers.now();
  const send = h.session.sendIm('alice', text);
  await waitFor(() => server.dropped('botone') === 1, 'the dropped copy');
  release();
  await waitFor(() => h.rates.at(-1)?.status === 'limited', 'limited event');
  return { send, droppedAt };
}

// One second at a time until the check holds; returns the clock then.
async function stepUntil(check: () => boolean, maxSeconds: number, each: () => void = () => {}): Promise<number> {
  for (let i = 0; i < maxSeconds && !check(); i++) {
    each();
    await h.timers.advance(1000);
    await settle(server.port);
  }
  expect(check()).toBe(true);
  return h.timers.now();
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

  it('reports no alert for the IM class, only limited and clear', async () => {
    await boot(false);
    for (let i = 0; i < 40 && notices().at(-1) !== RATE_CODE_ALERT; i++) server.spend('botone', RATE_CLASS_IM, 1);
    expect(notices()).toEqual([RATE_CODE_ALERT]);
    await settle(server.port);
    expect(h.rates).toEqual([]);
    limitBos(server, 'botone');
    await waitFor(() => h.rates.length === 1, 'limited event');
    clearBos(server, 'botone');
    await waitFor(() => h.rates.length === 2, 'clear event');
    expect(h.rates.map((r) => r.status)).toEqual(['limited', 'clear']);
  });

  it('treats a missing acknowledgement as a silent drop: holds until the level is back, then sends once more with a new cookie', async () => {
    await boot(false, true);
    const { send, droppedAt } = await dropOne('dropped once');
    let beforeClear = 0;
    const clearAt = await stepUntil(() => notices().includes(RATE_CODE_CLEAR), 60, () => {
      beforeClear = imSends(server, 'botone').length;
    });
    expect(beforeClear).toBe(1);
    await waitFor(() => imSends(server, 'botone').length === 2, 'second copy');
    const receipt = await send;
    const sends = imSends(server, 'botone');
    expect(clearAt - droppedAt).toBeGreaterThan(15_000);
    expect(sends[1]?.cookie).not.toBe(sends[0]?.cookie);
    expect(receipt.id).toBe(hex(sends[1]?.cookie));
    expect(imTexts(alice).map((m) => m.text)).toEqual(['dropped once']);
  });

  it('takes an acknowledgement at 12 s as the receipt and sends once', async () => {
    await boot(false, true);
    const release = holdAcks(server);
    const send = h.session.sendIm('alice', 'slow ack');
    await waitFor(() => imSends(server, 'botone').length === 1, 'first copy');
    await h.timers.advance(12_000);
    release();
    const receipt = await send;
    expect(receipt.id).toBe(hex(imSends(server, 'botone')[0]?.cookie));
    await h.timers.advance(60_000);
    await settle(server.port);
    expect(imSends(server, 'botone')).toHaveLength(1);
    expect(imTexts(alice).map((m) => m.text)).toEqual(['slow ack']);
    expect(h.rates).toEqual([]);
  });

  it('sends a second copy when the acknowledgement comes after 15 s, and the recipient has both', async () => {
    await boot(false, true);
    const release = holdAcks(server);
    const send = h.session.sendIm('alice', 'late ack');
    await waitFor(() => imSends(server, 'botone').length === 1, 'first copy');
    await h.timers.advance(14_999);
    await settle(server.port);
    expect(imSends(server, 'botone')).toHaveLength(1);
    await h.timers.advance(1);
    await waitFor(() => imSends(server, 'botone').length === 2, 'second copy');
    release();
    const receipt = await send;
    const sends = imSends(server, 'botone');
    expect(sends[1]?.cookie).not.toBe(sends[0]?.cookie);
    expect(receipt.id).toBe(hex(sends[1]?.cookie));
    expect(imTexts(alice).map((m) => m.text)).toEqual(['late ack', 'late ack']);
  });

  it('sends the next IM normally after a late ack', async () => {
    await boot(false, true);
    const release = holdAcks(server);
    const send = h.session.sendIm('alice', 'one');
    await waitFor(() => imSends(server, 'botone').length === 1, 'first copy');
    await h.timers.advance(15_000);
    await waitFor(() => imSends(server, 'botone').length === 2, 'second copy');
    release();
    await send;
    await h.session.sendIm('alice', 'two');
    expect(imSends(server, 'botone')).toHaveLength(3);
    expect(imTexts(alice).map((m) => m.text)).toEqual(['one', 'one', 'two']);
  });

  it('sends the second copy within a second of the level coming back when the server sends no clear notice', async () => {
    await boot(false, false);
    const { send, droppedAt } = await dropOne('no clear');
    // Class 3 has window 20 and clear level 5100; the dropped copy lowered the notice's level once more.
    const level = Math.trunc(((server.rateNotices('botone').at(-1)?.level ?? 0) * 19) / 20);
    const backAt = droppedAt + 20 * 5100 - 19 * level;
    await h.timers.advance(backAt - h.timers.now());
    await settle(server.port);
    expect(imSends(server, 'botone')).toHaveLength(1);
    const at = await stepUntil(() => imSends(server, 'botone').length === 2, 5);
    await send;
    expect(at - backAt).toBeLessThanOrEqual(1000);
    expect(notices().slice(0, -1)).not.toContain(RATE_CODE_CLEAR);
    expect(h.logs.text()).toMatch(/rate hold stopped/);
    expect(imTexts(alice).map((m) => m.text)).toEqual(['no clear']);
  });

  it('fails the send as rate-limited after the second copy is dropped too', async () => {
    await boot(false, true);
    limitBos(server, 'botone', { silent: true });
    const send = h.session.sendIm('alice', 'never arrives').catch((e: unknown) => e);
    await waitFor(() => imSends(server, 'botone').length === 1, 'first copy');
    await h.timers.advance(15_000);
    await waitFor(() => imSends(server, 'botone').length === 2, 'second copy');
    await h.timers.advance(15_000);
    expect(await send).toMatchObject({ code: 'rate-limited' });
    expect(imSends(server, 'botone')).toHaveLength(2);
    expect(server.dropped('botone')).toBe(2);
    expect(imTexts(alice)).toEqual([]);
  });

  it('holds a typing notice behind a held rate class', async () => {
    await boot(false);
    const generalClass = 1;
    for (let i = 0; i < 200 && notices().at(-1) !== RATE_CODE_ALERT; i++) server.spend('botone', generalClass, 1);
    expect(server.rateNotices('botone').at(-1)).toMatchObject({ code: RATE_CODE_ALERT, classId: generalClass });
    const typing = (): number => server.snacsFrom('botone').filter((s) => s.family === 4 && s.subtype === 0x14).length;
    const marker = h.session.sendIm('alice', 'marker');
    await marker;
    h.session.sendTyping('alice', 'typing');
    await settle(server.port);
    expect(typing()).toBe(0);
    server.setRateParams('botone', generalClass, { currentLevel: 6000 });
    server.rateTick('botone');
    await waitFor(() => typing() === 1, 'the typing notice');
    expect(h.rates).toEqual([]);
  });

  it('paces an ordinary account: three at once, then it keeps the server average above the alert line', async () => {
    await boot(false);
    muteRateNotices(server);
    const sends = Array.from({ length: 5 }, (_, i) => h.session.sendIm('alice', `m${i}`));
    await waitFor(() => imTexts(alice).length === 3, 'three delivered');
    await h.timers.advance(2800);
    expect(imTexts(alice)).toHaveLength(3);
    await h.timers.advance(200);
    await waitFor(() => imTexts(alice).length === 4, 'fourth delivered');
    await h.timers.advance(4800);
    expect(imTexts(alice)).toHaveLength(4);
    await h.timers.advance(200);
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
