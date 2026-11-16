import { describe, expect, it } from 'vitest';
import { FILES_LIMITS, Slots } from '../../../src/inbound/media-gate.js';
import type { MediaEvent, Refusal } from '../../../src/inbound/media-gate.js';
import { createSendFileIntake } from '../../../src/inbound/send-file.js';
import type { FileOfferEvent, FileSink, OscarEvents, TransferEvent } from '../../../src/oscar/index.js';
import { flush, manualTimers } from '../rooms-fixtures.js';

const text = (s: string): Uint8Array => new TextEncoder().encode(s);
const PNG = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4);
const PDF = text('%PDF-1.7\n1 0 obj\n');
const NOTES = text('# Notes\n\nBring the cake.\n');
const BINARY = Uint8Array.of(0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00);
const MB = 1024 * 1024;

type Handler = (payload: unknown) => void;
type Sent = { name: string; bytes: Uint8Array };

function setup(sec: Record<string, unknown> = {}) {
  const handlers = new Map<string, Set<Handler>>();
  const calls: string[] = [];
  const sinks = new Map<string, FileSink>();
  const fail: { accept?: unknown; cancel?: unknown } = {};
  const session = {
    on(event: string, fn: Handler) {
      const set = handlers.get(event) ?? new Set<Handler>();
      set.add(fn);
      handlers.set(event, set);
      return () => {
        set.delete(fn);
      };
    },
    async acceptFileOffer(id: string, sink: FileSink) {
      calls.push(`accept ${id}`);
      if (fail.accept !== undefined) throw fail.accept;
      sinks.set(id, sink);
    },
    async declineFileOffer(id: string) {
      calls.push(`decline ${id}`);
    },
    async cancelTransfer(id: string) {
      calls.push(`cancel ${id}`);
      if (fail.cancel !== undefined) throw fail.cancel;
    },
  };
  const emit = <E extends keyof OscarEvents>(event: E, payload: OscarEvents[E]): void => {
    for (const fn of [...(handlers.get(event) ?? [])]) fn(payload);
  };
  const clock = manualTimers();
  const slots = new Slots();
  const delivered: MediaEvent[] = [];
  const refused: { to: string; why: Refusal }[] = [];
  const strangers: { name: string; display: string }[] = [];
  const saved: { contentType: string; name: string; maxBytes: number; size: number }[] = [];
  const warnings: string[] = [];
  const state = {
    cfg: { channels: { oscar: { owners: ['alice'], allowFrom: ['bob'], files: { sendFile: true }, chain: { roster: [{ screenName: 'botone' }, { screenName: 'bottwo' }] }, ...sec } } } as unknown,
    admit: true,
    saveError: undefined as unknown,
  };
  const intake = createSendFileIntake(session as never, {
    self: () => 'BotOne',
    getCfg: () => state.cfg,
    now: clock.now,
    timers: clock.timers,
    log: { debug() {}, info() {}, warn: (msg: string) => void warnings.push(msg), error() {} },
    slots,
    admit: async () => state.admit,
    save: async (p) => {
      if (state.saveError !== undefined) throw state.saveError;
      saved.push({ contentType: p.contentType, name: p.name, maxBytes: p.maxBytes, size: p.bytes.byteLength });
      return { path: `/media/inbound/${saved.length}` };
    },
    deliver: (ev) => void delivered.push(ev),
    refuse: (to, why) => void refused.push({ to, why }),
    stranger: (name, display) => void strangers.push({ name, display }),
  });
  const offer = async (from: string, over: Partial<FileOfferEvent> = {}): Promise<string> => {
    const name = from.toLowerCase().replace(/ /g, '');
    const id = over.id ?? `${name}-1`;
    emit('fileOffer', { id, from: name, fromDisplay: from, count: 1, totalBytes: 100, name: 'notes.md', folder: false, ...over });
    await intake.idle();
    return id;
  };
  const sinkOf = (id: string): FileSink => {
    const sink = sinks.get(id);
    if (!sink) throw new Error(`no sink for ${id}`);
    return sink;
  };
  // Runs the sink as the session does: a rejection stops the transfer.
  const feed = async (id: string, files: Sent[], declared?: number): Promise<'ok' | Error> => {
    let index = 0;
    for (const file of files) {
      try {
        const writer = await sinkOf(id).begin({ name: file.name, bytes: declared ?? file.bytes.byteLength, modifiedAt: 0, index, count: files.length });
        try {
          for (let at = 0; at < file.bytes.byteLength; at += 7) await writer.write(file.bytes.subarray(at, at + 7));
          await writer.finish();
        } catch (err) {
          await writer.abort();
          throw err;
        }
      } catch (err) {
        return err as Error;
      }
      index += 1;
    }
    return 'ok';
  };
  const transfer = async (id: string, peer: string, over: Partial<TransferEvent> = {}): Promise<void> => {
    emit('transfer', { id, peer, direction: 'in', state: 'done', index: 0, bytesDone: 0, ...over });
    await intake.idle();
  };
  const receive = async (from: string, files: Sent[], over: Partial<FileOfferEvent> = {}): Promise<string> => {
    const total = files.reduce((sum, f) => sum + f.bytes.byteLength, 0);
    const id = await offer(from, { count: files.length, totalBytes: total, name: files[0]?.name ?? '', ...over });
    await feed(id, files);
    await transfer(id, from.toLowerCase());
    return id;
  };
  return { session, emit, calls, sinks, fail, clock, slots, delivered, refused, strangers, saved, warnings, state, intake, offer, feed, transfer, receive, sinkOf };
}

describe('Send File intake', () => {
  it("accepts an owner's text file and delivers it as a document", async () => {
    const s = setup();
    const id = await s.offer('Alice', { name: 'list.txt', totalBytes: NOTES.byteLength });
    expect(s.calls).toEqual([`accept ${id}`]);
    expect(s.slots.active()).toBe(1);
    await s.transfer(id, 'alice', { state: 'transferring' });
    expect(await s.feed(id, [{ name: 'list.txt', bytes: NOTES }])).toBe('ok');
    expect(s.delivered).toEqual([]);
    await s.transfer(id, 'alice', { state: 'done', bytesDone: NOTES.byteLength });
    expect(s.saved).toEqual([{ contentType: 'text/plain', name: 'list.txt', maxBytes: 10 * MB, size: NOTES.byteLength }]);
    expect(s.delivered).toEqual([
      {
        from: 'alice',
        fromDisplay: 'Alice',
        text: '',
        media: [{ path: '/media/inbound/1', contentType: 'text/plain', kind: 'document', name: 'list.txt', bytes: NOTES.byteLength, via: 'send-file' }],
      },
    ]);
    expect(s.refused).toEqual([]);
    expect(s.strangers).toEqual([]);
    expect(s.slots.active()).toBe(0);
    expect(s.clock.pending()).toBe(0);
  });

  it('accepts a Markdown file with the extension .md and one with no extension', async () => {
    const s = setup();
    await s.receive('Bob', [
      { name: 'notes.md', bytes: NOTES },
      { name: 'README', bytes: NOTES },
      { name: 'plan.markdown', bytes: NOTES },
    ]);
    expect(s.refused).toEqual([]);
    expect(s.delivered).toHaveLength(1);
    expect(s.delivered[0]?.from).toBe('bob');
    expect(s.delivered[0]?.media.map((m) => [m.name, m.contentType, m.kind])).toEqual([
      ['notes.md', 'text/markdown', 'document'],
      ['README', 'text/plain', 'document'],
      ['plan.markdown', 'text/markdown', 'document'],
    ]);
  });

  it('accepts text whatever its extension says', async () => {
    const s = setup();
    await s.receive('Alice', [
      { name: 'build.log', bytes: NOTES },
      { name: 'data.csv', bytes: text('a,b\n1,2\n') },
      { name: 'odd.xyz', bytes: NOTES },
    ]);
    expect(s.refused).toEqual([]);
    expect(s.delivered[0]?.media.map((m) => [m.name, m.contentType])).toEqual([
      ['build.log', 'text/plain'],
      ['data.csv', 'text/csv'],
      ['odd.xyz', 'text/plain'],
    ]);
  });

  it('accepts an image and a PDF', async () => {
    const s = setup();
    await s.receive('Alice', [
      { name: 'C:\\pics\\cat.png', bytes: PNG },
      { name: 'paper.pdf', bytes: PDF },
    ]);
    expect(s.refused).toEqual([]);
    expect(s.delivered[0]?.media.map((m) => [m.name, m.contentType, m.kind])).toEqual([
      ['cat.png', 'image/png', 'image'],
      ['paper.pdf', 'application/pdf', 'document'],
    ]);
  });

  it('sends a stranger nothing and reports the attempt', async () => {
    const s = setup();
    await s.offer('Mallory');
    expect(s.calls).toEqual([]);
    expect(s.strangers).toEqual([{ name: 'mallory', display: 'Mallory' }]);
    expect(s.refused).toEqual([]);
    expect(s.slots.active()).toBe(0);
    expect(s.clock.pending()).toBe(0);
    expect(s.sinks.size).toBe(0);
  });

  it('sends a stranger nothing under dmPolicy open, and nothing for a folder from a stranger', async () => {
    const s = setup({ dmPolicy: 'open', dangerouslyAllowOpenDm: true });
    await s.offer('Mallory', { folder: true, count: 9 });
    expect(s.calls).toEqual([]);
    expect(s.strangers).toHaveLength(1);
    expect(s.refused).toEqual([]);
  });

  it('sends nothing to a teammate bot or a person the host does not admit, with no notice', async () => {
    const s = setup();
    await s.offer('BotTwo');
    s.state.admit = false;
    await s.offer('Bob');
    expect(s.calls).toEqual([]);
    expect(s.strangers).toEqual([]);
    expect(s.refused).toEqual([]);
  });

  it('while the setting is off, declines an allowed sender and sends a stranger nothing', async () => {
    const s = setup({ files: { sendFile: false, directIm: true } });
    const a = await s.offer('Alice');
    await s.offer('Mallory');
    expect(s.calls).toEqual([`decline ${a}`]);
    expect(s.strangers).toEqual([]);
    expect(s.refused).toEqual([]);
  });

  it('declines the oldest unanswered offer once more than the limit wait', async () => {
    const s = setup();
    const max = FILES_LIMITS.ignoredOffers;
    for (let i = 0; i < max; i++) await s.offer('Mallory', { id: `m-${i}` });
    expect(s.calls).toEqual([]);
    await s.transfer('m-0', 'mallory', { state: 'failed', failure: 'timed-out' });
    await s.transfer('m-1', 'mallory', { state: 'cancelled', by: 'peer' });
    await s.offer('Mallory', { id: 'm-a' });
    await s.offer('Mallory', { id: 'm-b' });
    expect(s.calls).toEqual([]);
    await s.offer('Mallory', { id: 'm-c' });
    expect(s.calls).toEqual(['decline m-2']);
    expect(s.strangers).toHaveLength(max + 3);
  });

  it('declines a folder with the too-many refusal', async () => {
    const s = setup();
    const id = await s.offer('Alice', { folder: true, count: 2, name: 'docs' });
    expect(s.calls).toEqual([`decline ${id}`]);
    expect(s.refused).toEqual([{ to: 'alice', why: 'too-many' }]);
    expect(s.slots.active()).toBe(0);
  });

  it('declines four files with the too-many refusal', async () => {
    const s = setup();
    const id = await s.offer('Alice', { count: 4, totalBytes: 400 });
    expect(s.calls).toEqual([`decline ${id}`]);
    expect(s.refused).toEqual([{ to: 'alice', why: 'too-many' }]);
    const next = await s.offer('Alice', { id: 'alice-2', count: FILES_LIMITS.perOffer, totalBytes: 300 });
    expect(s.calls.at(-1)).toBe(`accept ${next}`);
  });

  it('declines an offer over the limit before accepting', async () => {
    const s = setup({ files: { sendFile: true, maxMb: 2 } });
    const one = await s.offer('Alice', { totalBytes: 2 * MB + 1 });
    expect(s.calls).toEqual([`decline ${one}`]);
    expect(s.refused).toEqual([{ to: 'alice', why: 'too-large' }]);
    const three = await s.offer('Alice', { id: 'alice-2', count: 3, totalBytes: 6 * MB + 1 });
    expect(s.calls.at(-1)).toBe(`decline ${three}`);
    expect(s.slots.active()).toBe(0);
    const fits = await s.offer('Alice', { id: 'alice-3', count: 3, totalBytes: 6 * MB });
    expect(s.calls.at(-1)).toBe(`accept ${fits}`);
  });

  it('stops a transfer whose file is larger than the offer said', async () => {
    const s = setup({ files: { sendFile: true, maxMb: 1 } });
    const id = await s.offer('Alice', { count: 2, totalBytes: 2 * MB });
    expect(await s.feed(id, [{ name: 'a.txt', bytes: NOTES }])).toBe('ok');
    expect(await s.feed(id, [{ name: 'big.txt', bytes: NOTES }], MB + 1)).toBeInstanceOf(Error);
    await s.transfer(id, 'alice', { state: 'failed', failure: 'folder-problem', index: 1 });
    expect(s.refused).toEqual([{ to: 'alice', why: 'too-large' }]);
    expect(s.delivered[0]?.media.map((m) => m.name)).toEqual(['a.txt']);
    expect(s.slots.active()).toBe(0);
  });

  it('stops a file that brings more bytes than its header said', async () => {
    const s = setup();
    const id = await s.offer('Alice');
    expect(await s.feed(id, [{ name: 'a.txt', bytes: NOTES }], 10)).toBeInstanceOf(Error);
    await s.transfer(id, 'alice', { state: 'failed', failure: 'folder-problem' });
    expect(s.refused).toEqual([{ to: 'alice', why: 'damaged' }]);
    expect(s.delivered).toEqual([]);
    expect(s.saved).toEqual([]);
  });

  it('stops a transfer at a fourth file and at a name inside a folder', async () => {
    const s = setup();
    const id = await s.offer('Alice', { count: 3, totalBytes: 300 });
    const files = ['a', 'b', 'c'].map((n) => ({ name: `${n}.txt`, bytes: NOTES }));
    expect(await s.feed(id, files)).toBe('ok');
    expect(await s.feed(id, [{ name: 'd.txt', bytes: NOTES }])).toBeInstanceOf(Error);
    await s.transfer(id, 'alice', { state: 'failed', failure: 'folder-problem', index: 3 });
    expect(s.refused).toEqual([{ to: 'alice', why: 'too-many' }]);
    expect(s.delivered[0]?.media).toHaveLength(3);

    const t = setup();
    const next = await t.offer('Alice');
    expect(await t.feed(next, [{ name: 'docs\u0001a.txt', bytes: NOTES }])).toBeInstanceOf(Error);
    await t.transfer(next, 'alice', { state: 'failed', failure: 'folder-problem' });
    expect(t.refused).toEqual([{ to: 'alice', why: 'too-many' }]);
    expect(t.delivered).toEqual([]);
  });

  it('drops a file of another type and tells the sender', async () => {
    const s = setup();
    await s.receive('Alice', [{ name: 'notes.txt', bytes: BINARY }]);
    expect(s.refused).toEqual([{ to: 'alice', why: 'wrong-type' }]);
    expect(s.delivered).toEqual([]);
    expect(s.saved).toEqual([]);
    expect(s.slots.active()).toBe(0);
  });

  it('drops an empty file as another type', async () => {
    const s = setup();
    await s.receive('Alice', [{ name: 'empty.txt', bytes: new Uint8Array(0) }]);
    expect(s.refused).toEqual([{ to: 'alice', why: 'wrong-type' }]);
    expect(s.delivered).toEqual([]);
  });

  it('delivers the good files of an offer and refuses the others once per kind', async () => {
    const s = setup();
    await s.receive('Alice', [
      { name: 'tool.exe', bytes: BINARY },
      { name: 'notes.md', bytes: NOTES },
      { name: 'other.bin', bytes: BINARY },
    ]);
    expect(s.refused).toEqual([{ to: 'alice', why: 'wrong-type' }]);
    expect(s.delivered).toHaveLength(1);
    expect(s.delivered[0]?.media.map((m) => m.name)).toEqual(['notes.md']);
    expect(s.saved).toHaveLength(1);
  });

  it('declines a second offer from the same person with the busy refusal', async () => {
    const s = setup();
    const first = await s.offer('Alice');
    const second = await s.offer('Alice', { id: 'alice-2' });
    expect(s.calls).toEqual([`accept ${first}`, `decline ${second}`]);
    expect(s.refused).toEqual([{ to: 'alice', why: 'busy' }]);
    expect(s.slots.active()).toBe(1);
    await s.transfer(second, 'alice', { state: 'declined', by: 'self' });
    expect(s.slots.active()).toBe(1);
    await s.transfer(first, 'alice');
    const third = await s.offer('Alice', { id: 'alice-3' });
    expect(s.calls.at(-1)).toBe(`accept ${third}`);
  });

  it('declines a fifth transfer with the busy-others refusal', async () => {
    const s = setup({ allowFrom: ['bob', 'carol', 'dave', 'erin'] });
    for (const name of ['Alice', 'Bob', 'Carol', 'Dave']) await s.offer(name);
    expect(s.slots.active()).toBe(4);
    const id = await s.offer('Erin');
    expect(s.calls.at(-1)).toBe(`decline ${id}`);
    expect(s.refused).toEqual([{ to: 'erin', why: 'busy-others' }]);
    expect(s.slots.active()).toBe(4);
  });

  it('tells the sender when the checksum failed', async () => {
    const s = setup();
    const id = await s.offer('Alice', { count: 2, totalBytes: 200 });
    await s.feed(id, [{ name: 'a.txt', bytes: NOTES }]);
    const writer = await s.sinkOf(id).begin({ name: 'b.txt', bytes: NOTES.byteLength, modifiedAt: 0, index: 1, count: 2 });
    await writer.write(NOTES);
    await writer.abort();
    await s.transfer(id, 'alice', { state: 'failed', failure: 'file-problem', index: 1 });
    expect(s.refused).toEqual([{ to: 'alice', why: 'damaged' }]);
    expect(s.delivered[0]?.media.map((m) => m.name)).toEqual(['a.txt']);
    expect(s.slots.active()).toBe(0);
  });

  it('cancels a transfer that has not moved for three minutes', async () => {
    const s = setup();
    const id = await s.offer('Alice', { count: 2, totalBytes: 200 });
    s.clock.advance(FILES_LIMITS.stallMs - 1000);
    await s.transfer(id, 'alice', { state: 'transferring' });
    s.clock.advance(FILES_LIMITS.stallMs - 1000);
    await s.feed(id, [{ name: 'a.txt', bytes: NOTES }]);
    s.clock.advance(FILES_LIMITS.stallMs - 1);
    expect(s.calls).toEqual([`accept ${id}`]);
    s.clock.advance(1);
    await flush();
    expect(s.calls).toEqual([`accept ${id}`, `cancel ${id}`]);
    expect(s.slots.active()).toBe(0);
    expect(s.clock.pending()).toBe(0);
    expect(s.delivered[0]?.media.map((m) => m.name)).toEqual(['a.txt']);
    expect(await s.feed(id, [{ name: 'b.txt', bytes: NOTES }])).toBeInstanceOf(Error);
    await s.transfer(id, 'alice', { state: 'cancelled', by: 'self' });
    expect(s.delivered).toHaveLength(1);
    expect(s.refused).toEqual([]);
  });

  it('cancels a transfer after fifteen minutes', async () => {
    const s = setup();
    const id = await s.offer('Alice');
    const step = FILES_LIMITS.stallMs - 1000;
    const steps = Math.floor(FILES_LIMITS.transferMs / step);
    for (let n = 0; n < steps; n += 1) {
      s.clock.advance(step);
      await s.transfer(id, 'alice', { state: 'transferring', bytesDone: n });
    }
    expect(s.calls).toEqual([`accept ${id}`]);
    s.clock.advance(FILES_LIMITS.transferMs - steps * step);
    await flush();
    expect(s.calls).toEqual([`accept ${id}`, `cancel ${id}`]);
    expect(s.slots.active()).toBe(0);
    expect(s.clock.pending()).toBe(0);
  });

  it('frees the slot when the cancel fails', async () => {
    const s = setup();
    s.fail.cancel = new Error('not-online');
    await s.offer('Alice');
    s.clock.advance(FILES_LIMITS.stallMs);
    await flush();
    expect(s.slots.active()).toBe(0);
    expect(s.warnings).toContain('a transfer was not cancelled');
  });

  it('frees the slot when the accept fails', async () => {
    const s = setup();
    s.fail.accept = new Error('not-online');
    await s.offer('Alice');
    expect(s.slots.active()).toBe(0);
    expect(s.clock.pending()).toBe(0);
  });

  it('frees the slot of an offer that ended while the sender was checked', async () => {
    const s = setup();
    s.emit('fileOffer', { id: 'a-1', from: 'alice', fromDisplay: 'Alice', count: 1, totalBytes: 100, name: 'a.txt', folder: false });
    s.emit('transfer', { id: 'a-1', peer: 'alice', direction: 'in', state: 'cancelled', by: 'peer', index: 0, bytesDone: 0 });
    await s.intake.idle();
    expect(s.calls).toEqual(['accept a-1']);
    expect(s.slots.active()).toBe(0);
    expect(s.clock.pending()).toBe(0);
  });

  it('drops the files of a sender who is no longer allowed', async () => {
    const s = setup();
    const id = await s.offer('Bob');
    await s.feed(id, [{ name: 'a.txt', bytes: NOTES }]);
    s.state.cfg = { channels: { oscar: { owners: ['alice'], allowFrom: [], files: { sendFile: true } } } };
    await s.transfer(id, 'bob');
    expect(s.delivered).toEqual([]);
    expect(s.saved).toEqual([]);
    expect(s.refused).toEqual([]);
    expect(s.strangers).toEqual([]);
    expect(s.slots.active()).toBe(0);
  });

  it('drops a file the store does not keep and delivers the rest', async () => {
    const s = setup();
    const id = await s.offer('Alice');
    await s.feed(id, [{ name: 'a.txt', bytes: NOTES }]);
    s.state.saveError = new Error('disk full');
    await s.transfer(id, 'alice');
    expect(s.delivered).toEqual([]);
    expect(s.warnings).toContain('a received file was not saved');
    expect(s.slots.active()).toBe(0);
  });

  it('keeps its own copy of each chunk', async () => {
    const s = setup();
    const id = await s.offer('Alice');
    const chunk = NOTES.slice();
    const writer = await s.sinkOf(id).begin({ name: 'a.md', bytes: chunk.byteLength, modifiedAt: 0, index: 0, count: 1 });
    await writer.write(chunk);
    chunk.fill(0);
    await writer.finish();
    await s.transfer(id, 'alice');
    expect(s.delivered[0]?.media[0]?.contentType).toBe('text/markdown');
  });

  it('leaves alone a transfer that goes out', async () => {
    const s = setup();
    const id = await s.offer('Alice');
    await s.feed(id, [{ name: 'a.txt', bytes: NOTES }]);
    await s.transfer(id, 'alice', { direction: 'out' });
    expect(s.delivered).toEqual([]);
    expect(s.slots.active()).toBe(1);
    await s.transfer(id, 'alice');
    expect(s.delivered).toHaveLength(1);
    expect(s.slots.active()).toBe(0);
  });

  it('frees the slot on every ending and clears its timers on stop', async () => {
    const endings: Partial<TransferEvent>[] = [
      { state: 'done' },
      { state: 'cancelled', by: 'peer' },
      { state: 'cancelled', by: 'self' },
      { state: 'declined', by: 'self' },
      { state: 'failed', failure: 'peer-closed' },
      { state: 'failed', failure: 'timed-out' },
      { state: 'failed', failure: 'refused-address' },
      { state: 'failed', failure: 'taken-elsewhere' },
      { state: 'failed', failure: 'signed-off' },
    ];
    for (const ending of endings) {
      const s = setup();
      const id = await s.offer('Alice');
      await s.transfer(id, 'alice', ending);
      expect(s.refused).toEqual([]);
      expect(s.slots.active()).toBe(0);
      expect(s.clock.pending()).toBe(0);
    }

    const s = setup();
    const a = await s.offer('Alice');
    await s.offer('Bob');
    expect(s.clock.pending()).toBe(4);
    await s.feed(a, [{ name: 'a.txt', bytes: NOTES }]);
    s.intake.stop();
    expect(s.clock.pending()).toBe(0);
    expect(s.slots.active()).toBe(0);
    expect(await s.feed(a, [{ name: 'b.txt', bytes: NOTES }])).toBeInstanceOf(Error);
    s.emit('transfer', { id: a, peer: 'alice', direction: 'in', state: 'done', index: 0, bytesDone: 0 });
    await s.intake.idle();
    await flush();
    expect(s.delivered).toEqual([]);
    expect(s.saved).toEqual([]);
  });
});
