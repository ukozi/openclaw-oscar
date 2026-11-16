import { afterEach, describe, expect, it } from 'vitest';
import { waitFor } from 'open-oscar-client-kit/testing';
import type { FakeOscarServer } from 'open-oscar-client-kit/testing';
import { ByteReader, RDV_CANCEL_DECLINED, decodeTlvs, encodeRendezvousCancel } from 'open-oscar-client-kit/wire';
import { createDirectImIntake } from '../../src/inbound/direct-im.js';
import { Slots } from '../../src/inbound/media-gate.js';
import type { MediaEvent } from '../../src/inbound/media-gate.js';
import { OscarSendError } from '../../src/oscar/index.js';
import type { FileSink, OscarSessionOptions, OutgoingFile, TransferOptions } from '../../src/oscar/index.js';
import { createFileSender } from '../../src/sending/send-file.js';
import type { SendOutcome } from '../../src/sending/send-file.js';
import { startServer } from '../fake/kit.js';
import { makeSession, stopAllSessions } from '../fake/session-harness.js';
import type { Harness } from '../fake/session-harness.js';

const MB = 1024 * 1024;
const NOTES = new TextEncoder().encode('# Notes\n\nBring the cake.\n');
const GIF = Uint8Array.from([...'GIF89a'].map((c) => c.charCodeAt(0)).concat([1, 0, 1, 0, 0, 0, 0, 0x3b]));

let server: FakeOscarServer;

afterEach(async () => {
  await stopAllSessions();
  await server.stop();
});

async function signOn(transfers: Partial<TransferOptions> = {}, over: Partial<OscarSessionOptions> = {}): Promise<Harness> {
  server = await startServer({ relay: true });
  server.addUser('botone', 'botpass1');
  const h = makeSession(server, { transfers: { directIm: true, sendFile: true, maxBytes: 10 * MB, ...transfers }, ...over });
  h.session.start();
  await h.online();
  return h;
}

function fileOf(name: string, bytes: Uint8Array): OutgoingFile {
  return {
    name,
    bytes: bytes.byteLength,
    modifiedAt: 0,
    read: async function* () {
      yield bytes;
    },
  };
}

function memorySink(): { sink: FileSink; files: { name: string; bytes: Uint8Array }[] } {
  const files: { name: string; bytes: Uint8Array }[] = [];
  const sink: FileSink = {
    begin: async (file) => {
      const chunks: Uint8Array[] = [];
      return {
        write: async (chunk) => {
          chunks.push(chunk.slice());
        },
        finish: async () => {
          files.push({ name: file.name, bytes: Buffer.concat(chunks) });
        },
        abort: async () => {},
      };
    },
  };
  return { sink, files };
}

// The cancel a client sends when its user declines the offer.
function declineFrom(peer: string, id: string): void {
  const cookie = BigInt(`0x${id.split(':')[1]}`);
  const r = new ByteReader(encodeRendezvousCancel(cookie, 'botone', 'send-file', RDV_CANCEL_DECLINED));
  r.u64();
  const channel = r.u16();
  r.str8();
  server.peer(peer).sendRaw('botone', channel, decodeTlvs(r.rest()), cookie);
}

async function openWith(h: Harness, peer: string): Promise<string> {
  server.peer(peer).acceptDirectIm();
  const id = await h.session.openDirectIm(peer);
  await waitFor(() => h.directIms.some((s) => s.id === id && s.state === 'open'), 'the open session');
  return id;
}

describe('sending from the session', () => {
  it('sends a file to a peer that accepts, and reports the transfer as outgoing and done', async () => {
    const h = await signOn();
    const { sink, files } = memorySink();
    server.peer('alice').acceptOffers(sink);
    const id = await h.session.sendFiles('alice', [fileOf('notes.md', NOTES)]);
    await waitFor(() => h.transfers.at(-1)?.state === 'done', 'the end of the transfer');
    expect(files).toEqual([{ name: 'notes.md', bytes: Buffer.from(NOTES) }]);
    expect(h.transfers.every((t) => t.id === id && t.peer === 'alice' && t.direction === 'out')).toBe(true);
    expect(h.transfers.at(-1)).toEqual({ id, peer: 'alice', direction: 'out', state: 'done', index: 0, bytesDone: NOTES.length });
    expect(server.relayed()).toHaveLength(1);
  });

  it('three files in one offer reach a peer that accepts', async () => {
    const h = await signOn();
    const { sink, files } = memorySink();
    server.peer('alice').acceptOffers(sink);
    const slots = new Slots();
    const sender = createFileSender(h.session, { now: h.timers.now, timers: h.timers.api, log: h.logs.log, slots });
    const big = new Uint8Array(200_000).map((_, i) => i % 251);
    const ends: SendOutcome[] = [];
    const sent = [
      { name: 'notes.md', bytes: NOTES },
      { name: 'big.bin', bytes: big },
      { name: 'dot.gif', bytes: GIF },
    ];
    expect(sender.offer('Alice', sent, (outcome) => void ends.push(outcome))).toBe('queued');
    expect(slots.active()).toBe(1);
    await waitFor(() => ends.length === 1, 'the end of the offer');
    expect(ends).toEqual(['done']);
    expect(files).toEqual(sent.map((f) => ({ name: f.name, bytes: Buffer.from(f.bytes) })));
    const ids = new Set(h.transfers.map((t) => t.id));
    expect(ids.size).toBe(1);
    expect(h.transfers.every((t) => t.direction === 'out' && t.peer === 'alice')).toBe(true);
    expect(h.transfers.at(-1)).toMatchObject({ state: 'done', index: 2 });
    expect(server.relayed()).toHaveLength(1);
    expect(slots.active()).toBe(0);
    sender.stop();
    await sender.idle();
  });

  it("a picture reaches a peer that accepts Direct IM, and the peer's answer in that session reaches the agent", async () => {
    const h = await signOn();
    server.peer('alice').acceptDirectIm();
    const slots = new Slots();
    const delivered: MediaEvent[] = [];
    const refused: string[] = [];
    const intake = createDirectImIntake(h.session, {
      self: () => 'botone',
      getCfg: () => ({ channels: { oscar: { owners: ['alice'], files: { directIm: true } } } }),
      now: h.timers.now,
      timers: h.timers.api,
      log: h.logs.log,
      slots,
      admit: async () => true,
      save: async (p) => ({ path: `/media/inbound/${p.name}` }) as never,
      deliver: (ev) => void delivered.push(ev),
      refuse: (to, why) => void refused.push(`${to} ${why}`),
      stranger: () => {},
    });
    const ends: SendOutcome[] = [];
    intake.send('Alice', [{ name: 'dot.gif', bytes: GIF, width: 1, height: 1 }], (outcome) => void ends.push(outcome));
    await waitFor(() => ends.length === 1, 'the end of the send');
    expect(ends).toEqual(['done']);
    expect(slots.active()).toBe(1);
    const peerSide = server.peer('alice').directIms()[0];
    await waitFor(() => (peerSide?.received().length ?? 0) === 1, 'the picture');
    expect(peerSide?.received()[0]?.attachments.map((a) => ({ name: a.name, bytes: Buffer.from(a.bytes) }))).toEqual([
      { name: 'dot.gif', bytes: Buffer.from(GIF) },
    ]);
    expect(server.relayed()).toHaveLength(1);

    await peerSide?.sendPicture('back.gif', GIF, 'thanks');
    await waitFor(() => delivered.length === 1, "the peer's answer");
    expect(delivered).toEqual([
      {
        from: 'alice',
        fromDisplay: 'alice',
        text: 'thanks',
        media: [{ path: '/media/inbound/back.gif', contentType: 'image/gif', kind: 'image', name: 'back.gif', bytes: GIF.byteLength, via: 'direct-im' }],
      },
    ]);
    expect(refused).toEqual([]);

    // A second picture uses the same session.
    intake.send('alice', [{ name: 'again.gif', bytes: GIF, width: 1, height: 1 }], (outcome) => void ends.push(outcome));
    await waitFor(() => ends.length === 2, 'the end of the second send');
    expect(ends).toEqual(['done', 'done']);
    expect(h.directIms.filter((d) => d.state === 'open')).toHaveLength(1);
    expect(server.peer('alice').directIms()).toHaveLength(1);

    peerSide?.close();
    await waitFor(() => slots.active() === 0, 'the slot given back');
    intake.stop();
    await intake.idle();
  });

  it('pictures near the limit, given while the session opens, go out one to a message', async () => {
    const h = await signOn({ maxBytes: MB });
    const slots = new Slots();
    const intake = createDirectImIntake(h.session, {
      self: () => 'botone',
      getCfg: () => ({ channels: { oscar: { owners: ['alice'], files: { directIm: true, maxMb: 1 } } } }),
      now: h.timers.now,
      timers: h.timers.api,
      log: h.logs.log,
      slots,
      admit: async () => true,
      save: async (p) => ({ path: `/media/inbound/${p.name}` }) as never,
      deliver: () => {},
      refuse: () => {},
      stranger: () => {},
    });
    const big = (fill: number): Uint8Array => {
      const bytes = new Uint8Array(900 * 1024).fill(fill);
      bytes.set(GIF);
      return bytes;
    };
    const ends: SendOutcome[] = [];
    intake.send('alice', [{ name: 'one.gif', bytes: big(1), width: 1, height: 1 }], (outcome) => void ends.push(outcome));
    intake.send('alice', [{ name: 'two.gif', bytes: big(2), width: 1, height: 1 }], (outcome) => void ends.push(outcome));
    server.peer('alice').acceptDirectIm();
    await waitFor(() => ends.length === 2, 'the end of both sends');
    expect(ends).toEqual(['done', 'done']);
    const peerSide = server.peer('alice').directIms()[0];
    await waitFor(() => (peerSide?.received().length ?? 0) === 2, 'both pictures');
    expect(peerSide?.received().map((m) => m.attachments.map((a) => `${a.name} ${a.bytes.byteLength}`))).toEqual([
      [`one.gif ${900 * 1024}`],
      [`two.gif ${900 * 1024}`],
    ]);
    intake.stop();
    await intake.idle();
  });

  it('a picture is not sent to a peer that does not answer, and the session is cancelled', async () => {
    const h = await signOn();
    const slots = new Slots();
    const intake = createDirectImIntake(h.session, {
      self: () => 'botone',
      getCfg: () => ({ channels: { oscar: { owners: ['alice'], files: { directIm: true } } } }),
      now: h.timers.now,
      timers: h.timers.api,
      log: h.logs.log,
      slots,
      admit: async () => true,
      save: async () => ({ path: '/media/inbound/none' }) as never,
      deliver: () => {},
      refuse: () => {},
      stranger: () => {},
    });
    const ends: SendOutcome[] = [];
    // Signed on, with no client that answers the offer.
    server.peer('alice');
    intake.send('alice', [{ name: 'dot.gif', bytes: GIF, width: 1, height: 1 }], (outcome) => void ends.push(outcome));
    await waitFor(() => slots.active() === 1, 'the offer');
    expect(ends).toEqual([]);
    h.timers.advance(300_000);
    await waitFor(() => ends.length === 1, 'the end of the send');
    expect(ends).toEqual(['failed']);
    await waitFor(() => h.directIms.at(-1)?.state === 'closed', 'the end of the session');
    expect(h.directIms.at(-1)).toMatchObject({ peer: 'alice', role: 'offering', state: 'closed' });
    expect(slots.active()).toBe(0);
    expect(server.relayed()).toEqual([]);
    intake.stop();
    await intake.idle();
  });

  it('a picture for a peer that is signed off fails at once and holds no slot', async () => {
    const h = await signOn();
    const slots = new Slots();
    const intake = createDirectImIntake(h.session, {
      self: () => 'botone',
      getCfg: () => ({ channels: { oscar: { owners: ['alice'], files: { directIm: true } } } }),
      now: h.timers.now,
      timers: h.timers.api,
      log: h.logs.log,
      slots,
      admit: async () => true,
      save: async () => ({ path: '/media/inbound/none' }) as never,
      deliver: () => {},
      refuse: () => {},
      stranger: () => {},
    });
    const ends: SendOutcome[] = [];
    intake.send('alice', [{ name: 'dot.gif', bytes: GIF, width: 1, height: 1 }], (outcome) => void ends.push(outcome));
    await waitFor(() => ends.length === 1, 'the end of the send');
    expect(ends).toEqual(['failed']);
    expect(slots.active()).toBe(0);
    expect(server.relayed()).toEqual([]);
    intake.stop();
    await intake.idle();
  });

  it('reports a declined file offer', async () => {
    const h = await signOn();
    const id = await h.session.sendFiles('alice', [fileOf('notes.md', NOTES)]);
    await waitFor(() => h.transfers.length === 1, 'the offer');
    declineFrom('alice', id);
    await waitFor(() => h.transfers.at(-1)?.state === 'declined', 'the decline');
    expect(h.transfers.at(-1)).toEqual({ id, peer: 'alice', direction: 'out', state: 'declined', by: 'peer', index: 0, bytesDone: 0 });
    expect(server.relayed()).toEqual([]);
  });

  it('opens Direct IM with a peer that accepts and sends a picture', async () => {
    const h = await signOn();
    const id = await openWith(h, 'alice');
    await waitFor(() => server.peer('alice').directIms().length === 1, "the peer's session");
    expect(h.directIms).toEqual([{ id, peer: 'alice', role: 'offering', state: 'open' }]);
    await h.session.sendDirectMessage(id, { pictures: [{ name: 'dot.gif', bytes: GIF, width: 1, height: 1 }] });
    const peerSide = server.peer('alice').directIms()[0];
    await waitFor(() => (peerSide?.received().length ?? 0) === 1, 'the picture');
    expect(peerSide?.received()[0]?.attachments.map((a) => ({ name: a.name, bytes: Buffer.from(a.bytes) }))).toEqual([
      { name: 'dot.gif', bytes: Buffer.from(GIF) },
    ]);
    // The client reports the session open a second time once the peer shows the cookie.
    await waitFor(() => server.relayed().length === 1, 'the pair on the relay');
    expect(h.directIms.filter((s) => s.state === 'open')).toHaveLength(1);
  });

  it("gives the live session's id when the peer already opened one", async () => {
    const h = await signOn();
    const opening = server.peer('alice').openDirectIm('botone');
    await waitFor(() => h.directImOffers.length === 1, 'the offer');
    const offered = h.directImOffers[0]?.id ?? '';
    await h.session.acceptDirectIm(offered);
    expect((await opening).outcome).toBe('open');
    await waitFor(() => h.directIms.length === 1, 'the open session');
    expect(h.directIms).toEqual([{ id: offered, peer: 'alice', role: 'receiving', state: 'open' }]);
    expect(await h.session.openDirectIm('alice')).toBe(offered);
    expect(server.peer('alice').directIms()).toHaveLength(1);
  });

  it('delivers a message the peer sends over a session the bot opened', async () => {
    const h = await signOn();
    const id = await openWith(h, 'alice');
    await waitFor(() => server.peer('alice').directIms().length === 1, "the peer's session");
    await server.peer('alice').directIms()[0]?.sendText('thanks');
    await waitFor(() => h.directMessages.length === 1, 'the message');
    expect(h.directMessages).toEqual([{ id, from: 'alice', fromDisplay: 'alice', text: 'thanks', autoResponse: false, damaged: false, pictures: [] }]);
  });

  it('asks the dial rule before the dial of an outgoing offer', async () => {
    const h = await signOn({ lookup: async () => ['203.0.113.9'] }, { host: 'localhost', redirect: 'pin' });
    const { sink, files } = memorySink();
    server.peer('alice').acceptOffers(sink);
    const id = await h.session.sendFiles('alice', [fileOf('notes.md', NOTES)]);
    await waitFor(() => h.transfers.at(-1)?.state === 'failed', 'the end of the transfer');
    expect(h.transfers.at(-1)).toEqual({ id, peer: 'alice', direction: 'out', state: 'failed', failure: 'refused-address', index: 0, bytesDone: 0 });
    expect(server.relayed()).toEqual([]);
    expect(files).toEqual([]);
    expect(h.logs.text()).toContain("refused to dial an address that is not the server's");
  });

  it('asks the dial rule before the dial of an outgoing Direct IM', async () => {
    const h = await signOn({ lookup: async () => ['203.0.113.9'] }, { host: 'localhost', redirect: 'pin' });
    server.peer('alice').acceptDirectIm();
    const id = await h.session.openDirectIm('alice');
    await waitFor(() => h.directIms.length === 1, 'the end of the session');
    expect(h.directIms).toEqual([{ id, peer: 'alice', role: 'offering', state: 'closed', end: 'refused-address' }]);
    expect(server.relayed()).toEqual([]);
  });

  it('rejects the three calls when not signed on', async () => {
    server = await startServer({ relay: true });
    server.addUser('botone', 'botpass1');
    const h = makeSession(server, { transfers: { directIm: true, sendFile: true, maxBytes: 10 * MB } });
    const calls = [
      () => h.session.sendFiles('alice', [fileOf('notes.md', NOTES)]),
      () => h.session.openDirectIm('alice'),
      () => h.session.sendDirectMessage('alice:0000000000000001', { pictures: [{ name: 'dot.gif', bytes: GIF, width: 1, height: 1 }] }),
    ];
    for (const call of calls) {
      const err = await call().then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(OscarSendError);
      expect(err).toMatchObject({ code: 'not-online' });
    }
  });
});
