import { describe, expect, it } from 'vitest';
import { FILES_LIMITS, Slots } from '../../../src/inbound/media-gate.js';
import type { OscarEvents, OutgoingFile, TransferEvent } from '../../../src/oscar/index.js';
import type { OutFile } from '../../../src/sending/plan.js';
import { createFileSender } from '../../../src/sending/send-file.js';
import type { SendOutcome } from '../../../src/sending/send-file.js';
import { flush, manualTimers } from '../rooms-fixtures.js';

const text = (s: string): Uint8Array => new TextEncoder().encode(s);
const NOTES = text('# Notes\n\nBring the cake.\n');
const file = (name: string, bytes: Uint8Array = NOTES): OutFile => ({ name, bytes });

type Handler = (payload: unknown) => void;
type Call = { id: string; to: string; files: OutgoingFile[] };

function setup() {
  const handlers = new Map<string, Set<Handler>>();
  const sent: Call[] = [];
  const cancelled: string[] = [];
  const fail: { send?: unknown; cancel?: unknown } = {};
  let hold: Promise<void> | undefined;
  const session = {
    on(event: string, fn: Handler) {
      const set = handlers.get(event) ?? new Set<Handler>();
      set.add(fn);
      handlers.set(event, set);
      return () => {
        set.delete(fn);
      };
    },
    async sendFiles(to: string, files: readonly OutgoingFile[]) {
      if (fail.send !== undefined) throw fail.send;
      const id = `${to}:${sent.length + 1}`;
      sent.push({ id, to, files: [...files] });
      if (hold) await hold;
      return id;
    },
    async cancelTransfer(id: string) {
      cancelled.push(id);
      if (fail.cancel !== undefined) throw fail.cancel;
    },
  };
  const clock = manualTimers();
  const slots = new Slots();
  const warnings: string[] = [];
  const sender = createFileSender(session as never, {
    now: clock.now,
    timers: clock.timers,
    log: { debug() {}, info() {}, warn: (msg: string) => void warnings.push(msg), error() {} },
    slots,
  });
  const ends: Record<string, SendOutcome[]> = {};
  const offer = async (to: string, files: OutFile[], tag = to): Promise<'queued' | 'too-many'> => {
    const result = sender.offer(to, files, (outcome) => void (ends[tag] ??= []).push(outcome));
    await sender.idle();
    return result;
  };
  const transfer = async (id: string, state: TransferEvent['state'], over: Partial<TransferEvent> = {}): Promise<void> => {
    const peer = id.split(':')[0] ?? '';
    tell(id, state, { peer, ...over });
    await sender.idle();
  };
  const tell = (id: string, state: TransferEvent['state'], over: Partial<TransferEvent> = {}): void => {
    const payload: OscarEvents['transfer'] = { id, peer: id.split(':')[0] ?? '', direction: 'out', state, index: 0, bytesDone: 0, ...over };
    for (const fn of [...(handlers.get('transfer') ?? [])]) fn(payload);
  };
  return {
    sent,
    cancelled,
    fail,
    clock,
    slots,
    warnings,
    sender,
    ends,
    offer,
    transfer,
    tell,
    listeners: () => [...handlers.values()].reduce((sum, set) => sum + set.size, 0),
    holdSends() {
      let release = (): void => {};
      hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        hold = undefined;
        release();
      };
    },
  };
}

async function bytesOf(f: OutgoingFile): Promise<{ whole: Buffer; chunks: number[] }> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of f.read()) chunks.push(chunk);
  return { whole: Buffer.concat(chunks), chunks: chunks.map((c) => c.byteLength) };
}

describe('Send File sender', () => {
  it('offers the files and reports done', async () => {
    const s = setup();
    const big = new Uint8Array(150_000).map((_, i) => i % 251);
    expect(await s.offer('Alice', [file('notes.md'), file('big.bin', big)])).toBe('queued');
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]?.to).toBe('alice');
    expect(s.sent[0]?.files.map((f) => [f.name, f.bytes, f.modifiedAt])).toEqual([
      ['notes.md', NOTES.byteLength, Math.floor(s.clock.now() / 1000)],
      ['big.bin', 150_000, Math.floor(s.clock.now() / 1000)],
    ]);
    const second = s.sent[0]?.files[1] as OutgoingFile;
    // The client reads each file two times.
    for (let pass = 0; pass < 2; pass += 1) {
      const read = await bytesOf(second);
      expect(read.whole.equals(Buffer.from(big))).toBe(true);
      expect(read.chunks).toEqual([65_536, 65_536, 150_000 - 2 * 65_536]);
    }
    expect(s.slots.active()).toBe(1);
    await s.transfer('alice:1', 'waiting');
    await s.transfer('alice:1', 'connecting');
    await s.transfer('alice:1', 'transferring', { bytesDone: 10 });
    expect(s.ends).toEqual({});
    await s.transfer('alice:1', 'done', { index: 1, bytesDone: 150_000 });
    expect(s.ends).toEqual({ Alice: ['done'] });
    expect(s.slots.active()).toBe(0);
    expect(s.clock.pending()).toBe(0);
    expect(s.cancelled).toEqual([]);
  });

  it('reports a declined offer, a canceled one and one that timed out as failed', async () => {
    const s = setup();
    await s.offer('alice', [file('a.txt')]);
    await s.transfer('alice:1', 'declined', { by: 'peer' });
    await s.offer('bob', [file('b.txt')]);
    await s.transfer('bob:2', 'connecting');
    await s.transfer('bob:2', 'cancelled', { by: 'peer' });
    await s.offer('carol', [file('c.txt')]);
    await s.transfer('carol:3', 'failed', { failure: 'timed-out' });
    expect(s.ends).toEqual({ alice: ['failed'], bob: ['failed'], carol: ['failed'] });
    expect(s.slots.active()).toBe(0);
    expect(s.clock.pending()).toBe(0);
    // An ending told a second time changes nothing.
    await s.transfer('alice:1', 'done');
    expect(s.ends.alice).toEqual(['failed']);
  });

  it('sends the second offer to a person after the first has ended', async () => {
    const s = setup();
    expect(await s.offer('alice', [file('a.txt')], 'first')).toBe('queued');
    expect(await s.offer('Alice', [file('b.txt')], 'second')).toBe('queued');
    expect(s.sent.map((c) => c.files.map((f) => f.name))).toEqual([['a.txt']]);
    expect(s.slots.active()).toBe(1);
    await s.transfer('alice:1', 'done');
    expect(s.ends).toEqual({ first: ['done'] });
    expect(s.sent.map((c) => c.files.map((f) => f.name))).toEqual([['a.txt'], ['b.txt']]);
    await s.transfer('alice:2', 'declined');
    expect(s.ends).toEqual({ first: ['done'], second: ['failed'] });
    expect(s.slots.active()).toBe(0);
    expect(s.clock.pending()).toBe(0);
  });

  it('refuses a fourth file while three wait or move', async () => {
    const s = setup();
    expect(await s.offer('alice', [file('a.txt')], 'one')).toBe('queued');
    expect(await s.offer('alice', [file('b.txt'), file('c.txt')], 'two')).toBe('queued');
    expect(await s.offer('alice', [file('d.txt')], 'three')).toBe('too-many');
    expect(await s.offer('bob', [file('a'), file('b'), file('c'), file('d')], 'four')).toBe('too-many');
    expect(s.ends).toEqual({});
    // Another person has a count of their own.
    expect(await s.offer('bob', [file('a'), file('b'), file('c')], 'five')).toBe('queued');
    await s.transfer('alice:1', 'done');
    expect(await s.offer('alice', [file('d.txt')], 'six')).toBe('queued');
    expect(await s.offer('alice', [file('e.txt')], 'seven')).toBe('too-many');
    expect(FILES_LIMITS.perSend).toBe(3);
  });

  it('asks again before a waiting offer goes out, and drops one that is no longer allowed', async () => {
    const s = setup();
    let ok = true;
    const asked: string[] = [];
    const check = (tag: string) => (): boolean => {
      asked.push(tag);
      return ok;
    };
    const end = (tag: string) => (outcome: SendOutcome): void => void (s.ends[tag] ??= []).push(outcome);
    expect(s.sender.offer('alice', [file('a.txt')], end('first'), check('first'))).toBe('queued');
    expect(s.sender.offer('alice', [file('b.txt')], end('second'), check('second'))).toBe('queued');
    expect(s.sender.offer('alice', [file('c.txt')], end('third'), () => true)).toBe('queued');
    await s.sender.idle();
    expect(asked).toEqual(['first']);
    ok = false;
    await s.transfer('alice:1', 'done');
    expect(asked).toEqual(['first', 'second']);
    // The second is dropped, with nothing offered and nothing to cancel; the third goes out.
    expect(s.ends).toEqual({ first: ['done'], second: ['failed'] });
    expect(s.sent.map((c) => c.files.map((f) => f.name))).toEqual([['a.txt'], ['c.txt']]);
    expect(s.cancelled).toEqual([]);
    await s.transfer('alice:2', 'done');
    expect(s.slots.active()).toBe(0);
    expect(s.clock.pending()).toBe(0);
  });

  it('drops an offer whose check throws', async () => {
    const s = setup();
    const result = s.sender.offer('alice', [file('a.txt')], (outcome) => void (s.ends.alice ??= []).push(outcome), () => {
      throw new Error('boom');
    });
    await s.sender.idle();
    expect(result).toBe('queued');
    expect([s.sent, s.ends, s.slots.active(), s.clock.pending()]).toEqual([[], { alice: ['failed'] }, 0, 0]);
  });

  it('waits for a slot and starts when one is free', async () => {
    const s = setup();
    for (const name of ['p1', 'p2', 'p3']) s.slots.take(name, 'send-file');
    await s.offer('alice', [file('a.txt')]);
    expect(s.slots.active()).toBe(4);
    await s.offer('bob', [file('b.txt')]);
    expect(s.sent.map((c) => c.to)).toEqual(['alice']);
    expect(s.ends).toEqual({});
    await s.transfer('alice:1', 'done');
    expect(s.sent.map((c) => c.to)).toEqual(['alice', 'bob']);
    expect(s.slots.active()).toBe(4);
    await s.transfer('bob:2', 'done');
    expect(s.ends).toEqual({ alice: ['done'], bob: ['done'] });
    expect(s.clock.pending()).toBe(0);
  });

  it('gives up on an offer that waits too long for a slot', async () => {
    const s = setup();
    for (const name of ['p1', 'p2', 'p3', 'p4']) s.slots.take(name, 'direct-im');
    await s.offer('alice', [file('a.txt')]);
    expect(s.sent).toEqual([]);
    s.clock.advance(FILES_LIMITS.transferMs - 1);
    expect(s.ends).toEqual({});
    s.clock.advance(1);
    expect(s.ends).toEqual({ alice: ['failed'] });
    expect(s.slots.active()).toBe(4);
    expect(s.clock.pending()).toBe(0);
    expect(s.cancelled).toEqual([]);
    // The person's count is free again.
    expect(await s.offer('alice', [file('a'), file('b'), file('c')], 'again')).toBe('queued');
  });

  it('cancels a transfer that stalls, and one that runs too long', async () => {
    const s = setup();
    await s.offer('alice', [file('a.txt')]);
    await s.transfer('alice:1', 'connecting');
    s.clock.advance(FILES_LIMITS.stallMs - 1);
    expect(s.cancelled).toEqual([]);
    s.clock.advance(1);
    await s.sender.idle();
    expect(s.cancelled).toEqual(['alice:1']);
    expect(s.ends).toEqual({ alice: ['failed'] });
    expect(s.slots.active()).toBe(0);
    expect(s.clock.pending()).toBe(0);
    // The ending the client tells after the cancel is not counted again.
    await s.transfer('alice:1', 'cancelled', { by: 'self' });
    expect(s.ends.alice).toEqual(['failed']);

    await s.offer('bob', [file('b.txt')]);
    await s.transfer('bob:2', 'transferring');
    const step = FILES_LIMITS.stallMs - 1000;
    for (let at = step; at < FILES_LIMITS.transferMs; at += step) {
      s.clock.advance(step);
      await s.transfer('bob:2', 'transferring', { bytesDone: at });
    }
    expect(s.cancelled).toEqual(['alice:1']);
    s.clock.advance(step);
    await s.sender.idle();
    expect(s.cancelled).toEqual(['alice:1', 'bob:2']);
    expect(s.ends.bob).toEqual(['failed']);
    expect(s.slots.active()).toBe(0);
    expect(s.clock.pending()).toBe(0);
  });

  it('starts no stall timer while the offer waits for an answer', async () => {
    const s = setup();
    await s.offer('alice', [file('a.txt')]);
    expect(s.clock.pending()).toBe(0);
    await s.transfer('alice:1', 'waiting');
    expect(s.clock.pending()).toBe(0);
    s.clock.advance(FILES_LIMITS.transferMs * 2);
    expect(s.cancelled).toEqual([]);
    expect(s.ends).toEqual({});
    await s.transfer('alice:1', 'connecting');
    expect(s.clock.pending()).toBe(2);
  });

  it('gives the slot back on every ending', async () => {
    const endings: [TransferEvent['state'], Partial<TransferEvent>][] = [
      ['done', {}],
      ['declined', { by: 'peer' }],
      ['cancelled', { by: 'peer' }],
      ['failed', { failure: 'peer-closed' }],
      ['failed', { failure: 'refused-address' }],
    ];
    for (const [state, over] of endings) {
      const s = setup();
      await s.offer('alice', [file('a.txt')]);
      await s.transfer('alice:1', 'transferring');
      expect(s.slots.active()).toBe(1);
      await s.transfer('alice:1', state, over);
      expect(s.slots.active()).toBe(0);
      expect(s.clock.pending()).toBe(0);
      expect(s.ends.alice).toHaveLength(1);
    }
  });

  it('counts an ending the session tells before the id of the transfer', async () => {
    const s = setup();
    const release = s.holdSends();
    const result = s.sender.offer('alice', [file('a.txt')], (outcome) => void (s.ends.alice ??= []).push(outcome));
    expect(result).toBe('queued');
    await flush();
    s.tell('bob:9', 'done');
    s.tell('alice:9', 'done');
    s.tell('alice:1', 'declined', { by: 'peer' });
    expect(s.ends).toEqual({});
    release();
    await s.sender.idle();
    expect(s.ends).toEqual({ alice: ['failed'] });
    expect(s.slots.active()).toBe(0);
  });

  it('reports a sendFiles call that rejects as failed', async () => {
    const s = setup();
    s.fail.send = new Error('not-online');
    await s.offer('alice', [file('a.txt')], 'first');
    expect(s.ends).toEqual({ first: ['failed'] });
    expect(s.slots.active()).toBe(0);
    expect(s.clock.pending()).toBe(0);
    expect(s.warnings).toHaveLength(1);
    s.fail.send = undefined;
    await s.offer('alice', [file('b.txt')], 'second');
    expect(s.sent.map((c) => c.files[0]?.name)).toEqual(['b.txt']);
  });

  it('reports failed once when the callback of an ending throws', async () => {
    const s = setup();
    s.sender.offer('alice', [file('a.txt')], () => {
      throw new Error('boom');
    });
    await s.sender.idle();
    await s.offer('alice', [file('b.txt')], 'second');
    await s.transfer('alice:1', 'done');
    expect(s.sent).toHaveLength(2);
    expect(s.slots.active()).toBe(1);
  });

  it('stops with nothing left running', async () => {
    const s = setup();
    for (const name of ['p1', 'p2']) s.slots.take(name, 'send-file');
    await s.offer('alice', [file('a.txt')], 'moving');
    await s.transfer('alice:1', 'transferring');
    await s.offer('alice', [file('b.txt')], 'behind');
    await s.offer('bob', [file('c.txt')], 'waiting');
    await s.offer('carol', [file('d.txt')], 'no slot');
    expect(s.clock.pending()).toBeGreaterThan(0);
    s.sender.stop();
    await s.sender.idle();
    expect(s.cancelled.sort()).toEqual(['alice:1', 'bob:2']);
    expect(s.slots.active()).toBe(2);
    expect(s.clock.pending()).toBe(0);
    expect(s.listeners()).toBe(0);
    expect(s.ends).toEqual({});
    expect(s.sent).toHaveLength(2);
    expect(s.sender.offer('alice', [file('e.txt')], () => {})).toBe('too-many');
  });

  it('cancels a transfer whose id comes after the stop', async () => {
    const s = setup();
    const release = s.holdSends();
    s.sender.offer('alice', [file('a.txt')], (outcome) => void (s.ends.alice ??= []).push(outcome));
    await flush();
    s.sender.stop();
    expect(s.slots.active()).toBe(0);
    release();
    await s.sender.idle();
    expect(s.cancelled).toEqual(['alice:1']);
    expect(s.ends).toEqual({});
  });
});
