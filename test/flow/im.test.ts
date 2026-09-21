import { afterEach, describe, expect, it } from 'vitest';
import { ByteReader, fromHex } from '../../src/oscar/bytes.js';
import { decodeImFragments } from '../../src/oscar/bos.js';
import { decodeTlvs, findTlv, hasTlv, tlv } from '../../src/oscar/tlv.js';
import { OscarSendError } from '../../src/oscar/types.js';
import { imSends, makeSession, stopAllSessions, waitFor } from '../fake/oscar-client.js';
import type { Harness } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';
import type { FakeGeneration, FakePeer } from '../fake/oscar-server.js';

let server: FakeOscarServer;
let alice: FakePeer;
let h: Harness;

async function boot(generation: FakeGeneration = 'main', bot = true): Promise<void> {
  server = await FakeOscarServer.start({ generation });
  server.addUser('botone', 'botpass1', { bot });
  alice = server.peer('alice');
  h = makeSession(server);
  h.session.start();
  await h.online();
}

afterEach(async () => {
  await stopAllSessions();
  await server.stop();
});

describe('receiving IMs', () => {
  it('decodes every charset a peer can pick', async () => {
    await boot();
    alice.sendIm('botone', 'plain');
    alice.sendIm('botone', 'héllo 😀');
    alice.sendIm('botone', 'café from a web client', { charset: 0 });
    alice.sendIm('botone', 'naïve', { charset: 3 });
    await waitFor(() => h.ims.length === 4, 'four IMs');
    expect(h.ims.map((m) => m.text)).toEqual(['plain', 'héllo 😀', 'café from a web client', 'naïve']);
    expect(h.ims[0]).toMatchObject({ from: 'alice', fromDisplay: 'alice', autoResponse: false, offline: false, system: false });
  });

  it('strips the HTML a classic client wraps around text and keeps typed angle brackets', async () => {
    await boot();
    alice.sendIm('botone', '<HTML><BODY BGCOLOR="#ffffff"><FONT FACE="Arial">if a &lt; b<BR>then &amp;c</FONT></BODY></HTML>', { html: true });
    await waitFor(() => h.ims.length === 1, 'IM');
    expect(h.ims[0]?.text).toBe('if a < b\nthen &c');
  });

  it('normalises the sender and keeps the display form', async () => {
    await boot();
    server.peer('Bo B').sendIm('botone', 'hi');
    await waitFor(() => h.ims.length === 1, 'IM');
    expect(h.ims[0]).toMatchObject({ from: 'bob', fromDisplay: 'Bo B' });
  });

  it('delivers every cookie-0 message: that cookie is what TOC clients always send', async () => {
    await boot();
    alice.sendIm('botone', 'first', { cookie: 0n });
    alice.sendIm('botone', 'second', { cookie: 0n });
    alice.sendIm('botone', 'third', { cookie: 77n });
    await waitFor(() => h.ims.length === 3, 'three IMs');
    expect(h.ims.map((m) => [m.text, m.cookie])).toEqual([['first', 0n], ['second', 0n], ['third', 77n]]);
  });

  it('flags an auto-response', async () => {
    await boot();
    alice.sendIm('botone', 'I am away', { autoResponse: true });
    await waitFor(() => h.ims.length === 1, 'IM');
    expect(h.ims[0]?.autoResponse).toBe(true);
  });

  it('hands a channel 2 message over as the whole SNAC body and raises no im event for it', async () => {
    await boot();
    const seen: Uint8Array[] = [];
    h.session.onChannel2((icbmBody) => seen.push(icbmBody));
    const fragment = fromHex('0000' + '1122334455667788' + '748f2420628711d18222444553540000' + '000a00020001');
    alice.sendRaw('botone', 2, [tlv.bytes(0x05, fragment)], 99n);
    await waitFor(() => seen.length === 1, 'channel 2');
    const r = new ByteReader(seen[0] ?? new Uint8Array(0));
    expect([r.u64(), r.u16(), r.str8()]).toEqual([99n, 2, 'alice']);
    r.u16();
    const userTlvs = r.u16();
    for (let i = 0; i < userTlvs; i++) {
      r.u16();
      r.bytes(r.u16());
    }
    expect(findTlv(decodeTlvs(r.rest()), 0x05)).toEqual(fragment);
    expect(h.ims).toEqual([]);
  });

  it('keeps delivering when one listener throws', async () => {
    await boot();
    const seen: string[] = [];
    h.session.on('im', () => {
      throw new Error('listener bug');
    });
    h.session.on('im', (e) => seen.push(e.text));
    alice.sendIm('botone', 'one');
    alice.sendIm('botone', 'two');
    await waitFor(() => seen.length === 2, 'both IMs');
    expect(seen).toEqual(['one', 'two']);
    expect(h.session.getState().phase).toBe('online');
    expect(h.logs.lines.filter((l) => l.level === 'error' && l.msg === 'oscar event listener threw')).toHaveLength(2);
  });

  it('stops delivering to a listener once it unsubscribes', async () => {
    await boot();
    const seen: string[] = [];
    const off = h.session.on('im', (e) => seen.push(e.text));
    alice.sendIm('botone', 'one');
    await waitFor(() => seen.length === 1, 'first IM');
    off();
    alice.sendIm('botone', 'two');
    await waitFor(() => h.ims.length === 2, 'second IM');
    expect(seen).toEqual(['one']);
  });

  it('keeps message text out of the log at every level', async () => {
    await boot();
    alice.sendIm('botone', 'inbound words nobody should log');
    await waitFor(() => h.ims.length === 1, 'IM');
    await h.session.sendIm('alice', 'outbound words nobody should log');
    expect(alice.ims()).toHaveLength(1);
    expect(h.logs.text()).toContain('oscar session state');
    expect(h.logs.text()).not.toContain('nobody should log');
  });

  it('survives an unreadable IM and still delivers the next one', async () => {
    await boot();
    alice.sendRaw('botone', 1, [tlv.bytes(0x02, fromHex('0101ffff41'))]);
    alice.sendIm('botone', 'still here');
    await waitFor(() => h.ims.length === 1, 'IM');
    expect(h.ims[0]?.text).toBe('still here');
    expect(h.session.getState().phase).toBe('online');
    expect(h.logs.lines.some((l) => l.level === 'warn' && l.msg === 'dropped an unreadable SNAC')).toBe(true);
  });
});

describe.each<FakeGeneration>(['v0.24', 'main'])('sending IMs to %s', (generation) => {
  it('asks for a host ack, sends no store TLV to someone online, and resolves on the ack', async () => {
    await boot(generation);
    const receipt = await h.session.sendIm('alice', '<B>hi</B> there');
    expect(receipt.storedOffline).toBe(false);
    expect(receipt.id).toMatch(/^[0-9a-f]{16}$/);
    expect(alice.ims()).toEqual([{ from: 'botone', text: 'hi there', storeTlv: false }]);
    const [sent] = imSends(server, 'botone');
    expect(sent?.cookie).not.toBe(0n);
    expect(hasTlv(sent?.tlvs ?? [], 0x03)).toBe(true);
    expect(hasTlv(sent?.tlvs ?? [], 0x06)).toBe(false);
  });

  it('stores straight away for a buddy that presence shows offline', async () => {
    await boot(generation);
    alice.signOff();
    await waitFor(() => h.session.presenceOf('alice')?.online === false, 'alice offline');
    const receipt = await h.session.sendIm('alice', 'for later');
    expect(receipt.storedOffline).toBe(true);
    const sends = imSends(server, 'botone');
    expect(sends).toHaveLength(1);
    expect(hasTlv(sends[0]?.tlvs ?? [], 0x06)).toBe(true);
    expect(server.storedFor('alice')).toHaveLength(1);
  });

  it('resends once with the store TLV when an unwatched recipient turns out to be offline', async () => {
    await boot(generation);
    server.addUser('mallory', 'x');
    const receipt = await h.session.sendIm('mallory', 'for later');
    expect(receipt.storedOffline).toBe(true);
    const sends = imSends(server, 'botone');
    expect(sends.map((s) => hasTlv(s.tlvs, 0x06))).toEqual([false, true]);
    expect(sends[0]?.cookie).toBe(sends[1]?.cookie);
    expect(server.storedFor('mallory')).toHaveLength(1);
  });
});

describe('sending IMs', () => {
  it('fails when the server will not store it either', async () => {
    await boot();
    const err = await h.session.sendIm('nobody', 'hello?').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OscarSendError);
    expect((err as OscarSendError).code).toBe('recipient-unavailable');
    expect(imSends(server, 'botone')).toHaveLength(2);
  });

  it('uses charset 0 for ASCII and UTF-16BE for anything else', async () => {
    await boot();
    await h.session.sendIm('alice', 'plain');
    await h.session.sendIm('alice', 'café 😀');
    const charsets = imSends(server, 'botone').map((s) => decodeImFragments(findTlv(s.tlvs, 0x02) ?? new Uint8Array())[0]?.charset);
    expect(charsets).toEqual([0, 2]);
    expect(alice.ims().map((m) => m.text)).toEqual(['plain', 'café 😀']);
  });

  it('refuses when not online', async () => {
    server = await FakeOscarServer.start();
    h = makeSession(server);
    await expect(h.session.sendIm('alice', 'x')).rejects.toMatchObject({ code: 'not-online' });
    await expect(h.session.setAway('x')).rejects.toMatchObject({ code: 'not-online' });
  });

  it('refuses a message too long for one frame', async () => {
    await boot();
    await expect(h.session.sendIm('alice', 'x'.repeat(70_000))).rejects.toMatchObject({ code: 'too-long' });
    expect(imSends(server, 'botone')).toEqual([]);
  });

  it('fails the send in flight and the ones queued behind it when the socket drops', async () => {
    await boot();
    server.setRate('botone', 'bos', 'limited', { silent: true });
    const inFlight = h.session.sendIm('alice', 'one').catch((e: unknown) => e);
    const queued = h.session.sendIm('alice', 'two').catch((e: unknown) => e);
    await waitFor(() => imSends(server, 'botone').length === 1, 'send on the wire');
    server.dropSocket('botone', 'bos');
    expect(await inFlight).toMatchObject({ code: 'closed' });
    expect(await queued).toMatchObject({ code: 'closed' });
  });

  it('sends replies before control lines before notices', async () => {
    await boot();
    await Promise.all([
      h.session.sendIm('alice', 'first in'),
      h.session.sendIm('alice', 'notice', { priority: 'notice' }),
      h.session.sendIm('alice', 'control', { priority: 'control' }),
      h.session.sendIm('alice', 'reply', { priority: 'reply' }),
    ]);
    expect(alice.ims().map((m) => m.text)).toEqual(['first in', 'reply', 'control', 'notice']);
  });
});

describe('typing and away', () => {
  const typingEvents = (): number[] =>
    server
      .snacsFrom('botone')
      .filter((s) => s.family === 4 && s.subtype === 0x14)
      .map((s) => {
        const r = new ByteReader(s.body);
        expect(r.u64()).toBe(0n);
        expect(r.u16()).toBe(1);
        expect(r.str8()).toBe('alice');
        return r.u16();
      });

  it('keeps typing alive every 8 s and sends a real stop', async () => {
    await boot();
    h.session.sendTyping('alice', 'typing');
    await h.timers.advance(8000);
    await h.timers.advance(8000);
    h.session.sendTyping('alice', 'none');
    await h.timers.advance(30_000);
    await waitFor(() => typingEvents().length === 4, 'typing events');
    expect(typingEvents()).toEqual([2, 2, 2, 0]);
  });

  it('stops by itself after 120 s', async () => {
    await boot();
    h.session.sendTyping('alice', 'typing');
    // Stepwise, so the liveness probe that falls inside this span gets its reply in real time.
    for (let i = 1; i <= 15; i++) {
      await h.timers.advance(8000);
      await waitFor(() => typingEvents().length === i + 1, `typing event ${i + 1}`);
    }
    expect(typingEvents()).toEqual([...Array<number>(15).fill(2), 0]);
    await h.timers.advance(30_000);
    expect(typingEvents()).toHaveLength(16);
    expect(h.session.getState().phase).toBe('online');
  });

  it('sets and clears away through Locate only', async () => {
    await boot();
    await h.session.setAway('Working on something.');
    await waitFor(() => server.sessionOf('botone')?.away === 'Working on something.', 'away set');
    await h.session.setAway(null);
    await waitFor(() => server.sessionOf('botone')?.away === null, 'away cleared');
    const locate = server.snacsFrom('botone').filter((s) => s.family === 2 && s.subtype === 4);
    expect(locate.slice(1).map((s) => decodeTlvs(s.body).map((t) => [t.tag, Buffer.from(t.value).toString()]))).toEqual([
      [[4, 'Working on something.']],
      [[4, '']],
    ]);
    expect(server.snacsFrom('botone').some((s) => s.family === 1 && s.subtype === 0x1e)).toBe(false);
  });
});
