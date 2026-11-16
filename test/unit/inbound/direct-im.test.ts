import { describe, expect, it } from 'vitest';
import { createDirectImIntake } from '../../../src/inbound/direct-im.js';
import { FILES_LIMITS, Slots } from '../../../src/inbound/media-gate.js';
import type { MediaEvent, Refusal } from '../../../src/inbound/media-gate.js';
import { directImLimits } from '../../../src/oscar/index.js';
import type { DirectImEnd, DirectMessageEvent, OscarEvents } from '../../../src/oscar/index.js';
import type { Picture } from '../../../src/sending/plan.js';
import type { SendOutcome } from '../../../src/sending/send-file.js';
import { flush, manualTimers } from '../rooms-fixtures.js';

const PNG = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4);
const GIF = Uint8Array.from([...'GIF89a'].map((c) => c.charCodeAt(0)).concat([1, 0, 1, 0]));
const TEXT = Uint8Array.from([...'just words'].map((c) => c.charCodeAt(0)));
const MB = 1024 * 1024;

type Handler = (payload: unknown) => void;

function setup(sec: Record<string, unknown> = {}) {
  const handlers = new Map<string, Set<Handler>>();
  const calls: string[] = [];
  const fail: { accept?: unknown; close?: unknown; open?: unknown; send?: unknown } = {};
  const sent: { id: string; names: string[] }[] = [];
  const ends: SendOutcome[] = [];
  let opened = 0;
  const session = {
    on(event: string, fn: Handler) {
      const set = handlers.get(event) ?? new Set<Handler>();
      set.add(fn);
      handlers.set(event, set);
      return () => {
        set.delete(fn);
      };
    },
    async acceptDirectIm(id: string) {
      calls.push(`accept ${id}`);
      if (fail.accept !== undefined) throw fail.accept;
    },
    async declineDirectIm(id: string) {
      calls.push(`decline ${id}`);
    },
    async closeDirectIm(id: string) {
      calls.push(`close ${id}`);
      if (fail.close !== undefined) throw fail.close;
    },
    async openDirectIm(to: string) {
      calls.push(`open ${to}`);
      if (fail.open !== undefined) throw fail.open;
      if (state.openAs !== undefined) return state.openAs;
      opened += 1;
      return `${to}-out-${opened}`;
    },
    async sendDirectMessage(id: string, message: { pictures: readonly Picture[] }) {
      if (state.holdSend) await state.holdSend;
      if (fail.send !== undefined) throw fail.send;
      sent.push({ id, names: message.pictures.map((p) => p.name) });
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
    cfg: { channels: { oscar: { owners: ['alice'], allowFrom: ['bob'], files: { directIm: true }, chain: { roster: [{ screenName: 'botone' }, { screenName: 'bottwo' }] }, ...sec } } } as unknown,
    admit: true,
    saveError: undefined as unknown,
    hold: undefined as Promise<void> | undefined,
    holdSend: undefined as Promise<void> | undefined,
    openAs: undefined as string | undefined,
  };
  const intake = createDirectImIntake(session as never, {
    self: () => 'BotOne',
    getCfg: () => state.cfg,
    now: clock.now,
    timers: clock.timers,
    log: { debug() {}, info() {}, warn: (msg: string) => void warnings.push(msg), error() {} },
    slots,
    admit: async () => {
      if (state.hold) await state.hold;
      return state.admit;
    },
    save: async (p) => {
      if (state.hold) await state.hold;
      if (state.saveError !== undefined) throw state.saveError;
      saved.push({ contentType: p.contentType, name: p.name, maxBytes: p.maxBytes, size: p.bytes.byteLength });
      return { path: `/media/inbound/${saved.length}` };
    },
    deliver: (ev) => void delivered.push(ev),
    refuse: (to, why) => void refused.push({ to, why }),
    stranger: (name, display) => void strangers.push({ name, display }),
  });
  const offer = async (from: string, id = `${from.toLowerCase()}-1`): Promise<string> => {
    emit('directImOffer', { id, from: from.toLowerCase().replace(/ /g, ''), fromDisplay: from });
    await intake.idle();
    return id;
  };
  const message = async (id: string, over: Partial<DirectMessageEvent> = {}): Promise<void> => {
    emit('directMessage', { id, from: 'alice', fromDisplay: 'Alice', text: '', autoResponse: false, damaged: false, pictures: [], ...over });
    await intake.idle();
  };
  const closed = async (id: string, peer: string, end: DirectImEnd = 'peer-closed', by?: 'self' | 'peer', role: 'offering' | 'receiving' = 'receiving'): Promise<void> => {
    emit('directIm', { id, peer, role, state: 'closed', end, ...(by ? { by } : {}) });
    await intake.idle();
  };
  // Hands over pictures by name, as the reply of a turn does.
  const give = async (to: string, ...names: string[]): Promise<void> => {
    intake.send(to, names.map((name) => ({ name, bytes: GIF, width: 1, height: 1 })), (outcome) => void ends.push(outcome));
    await intake.idle();
  };
  const opens = async (id: string, peer: string, role: 'offering' | 'receiving' = 'offering'): Promise<void> => {
    emit('directIm', { id, peer, role, state: 'open' });
    await intake.idle();
  };
  return { session, emit, calls, fail, clock, slots, delivered, refused, strangers, saved, warnings, state, intake, offer, message, closed, sent, ends, give, opens };
}

describe('Direct IM intake', () => {
  it("accepts an owner's offer and delivers the picture with its text", async () => {
    const s = setup();
    const id = await s.offer('Alice');
    expect(s.calls).toEqual([`accept ${id}`]);
    expect(s.slots.active()).toBe(1);
    s.emit('directIm', { id, peer: 'alice', role: 'receiving', state: 'open' });
    await s.message(id, { text: 'look at this', pictures: [{ name: 'C:\\pics\\cat.png', bytes: PNG }] });
    expect(s.saved).toEqual([{ contentType: 'image/png', name: 'cat.png', maxBytes: 10 * MB, size: PNG.byteLength }]);
    expect(s.delivered).toEqual([
      {
        from: 'alice',
        fromDisplay: 'Alice',
        text: 'look at this',
        media: [{ path: '/media/inbound/1', contentType: 'image/png', kind: 'image', name: 'cat.png', bytes: PNG.byteLength, via: 'direct-im' }],
      },
    ]);
    expect(s.refused).toEqual([]);
    expect(s.strangers).toEqual([]);
  });

  it('accepts an approved person and delivers text that comes alone', async () => {
    const s = setup();
    const id = await s.offer('Bob');
    expect(s.calls).toEqual([`accept ${id}`]);
    await s.message(id, { from: 'bob', fromDisplay: 'Bob', text: 'hello' });
    expect(s.delivered).toEqual([{ from: 'bob', fromDisplay: 'Bob', text: 'hello', media: [] }]);
    await s.message(id, { from: 'bob', fromDisplay: 'Bob', text: '' });
    expect(s.delivered).toHaveLength(1);
  });

  it('keeps the order of the messages of one session', async () => {
    const s = setup();
    const id = await s.offer('Alice');
    s.emit('directMessage', { id, from: 'alice', fromDisplay: 'Alice', text: 'one', autoResponse: false, damaged: false, pictures: [{ name: 'a.png', bytes: PNG }] });
    s.emit('directMessage', { id, from: 'alice', fromDisplay: 'Alice', text: 'two', autoResponse: false, damaged: false, pictures: [] });
    await s.intake.idle();
    expect(s.delivered.map((d) => d.text)).toEqual(['one', 'two']);
  });

  it('sends a stranger nothing and reports the attempt', async () => {
    const s = setup();
    const id = await s.offer('Mallory');
    expect(s.calls).toEqual([]);
    expect(s.strangers).toEqual([{ name: 'mallory', display: 'Mallory' }]);
    expect(s.refused).toEqual([]);
    expect(s.slots.active()).toBe(0);
    expect(s.clock.pending()).toBe(0);
    await s.message(id, { from: 'mallory', fromDisplay: 'Mallory', text: 'hi', pictures: [{ name: 'a.png', bytes: PNG }] });
    expect(s.delivered).toEqual([]);
    expect(s.saved).toEqual([]);
  });

  it('sends a stranger nothing under dmPolicy open', async () => {
    const s = setup({ dmPolicy: 'open', dangerouslyAllowOpenDm: true });
    await s.offer('Mallory');
    expect(s.calls).toEqual([]);
    expect(s.strangers).toHaveLength(1);
  });

  it('sends a teammate bot nothing, with no notice', async () => {
    const s = setup();
    await s.offer('BotTwo');
    expect(s.calls).toEqual([]);
    expect(s.strangers).toEqual([]);
    expect(s.refused).toEqual([]);
  });

  it('sends nothing to an approved person the host does not admit', async () => {
    const s = setup();
    s.state.admit = false;
    await s.offer('Bob');
    expect(s.calls).toEqual([]);
    expect(s.strangers).toEqual([]);
  });

  it('while the setting is off, declines an allowed sender and sends a stranger nothing', async () => {
    const s = setup({ files: { directIm: false } });
    const a = await s.offer('Alice');
    await s.offer('Mallory');
    expect(s.calls).toEqual([`decline ${a}`]);
    expect(s.strangers).toEqual([]);
    expect(s.refused).toEqual([]);
    expect(s.slots.active()).toBe(0);
  });

  it('declines the oldest unanswered offer once more than the limit wait', async () => {
    const s = setup();
    const max = FILES_LIMITS.ignoredOffers;
    for (let i = 0; i < max; i++) await s.offer('Mallory', `m-${i}`);
    expect(s.calls).toEqual([]);
    await s.closed('m-0', 'mallory', 'timed-out');
    await s.closed('m-1', 'mallory', 'cancelled', 'peer');
    await s.offer('Mallory', 'm-a');
    await s.offer('Mallory', 'm-b');
    expect(s.calls).toEqual([]);
    await s.offer('Mallory', 'm-c');
    expect(s.calls).toEqual(['decline m-2']);
    expect(s.strangers).toHaveLength(max + 3);
  });

  it('declines a fifth session and tells the sender that others are sending', async () => {
    const s = setup({ allowFrom: ['bob', 'carol', 'dave', 'erin'] });
    for (const name of ['Alice', 'Bob', 'Carol', 'Dave']) await s.offer(name);
    expect(s.slots.active()).toBe(4);
    const id = await s.offer('Erin');
    expect(s.calls.at(-1)).toBe(`decline ${id}`);
    expect(s.refused).toEqual([{ to: 'erin', why: 'busy-others' }]);
    expect(s.slots.active()).toBe(4);
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
    s.emit('directImOffer', { id: 'a-1', from: 'alice', fromDisplay: 'Alice' });
    s.emit('directIm', { id: 'a-1', peer: 'alice', role: 'receiving', state: 'closed', end: 'cancelled', by: 'peer' });
    await s.intake.idle();
    expect(s.calls).toEqual(['accept a-1']);
    expect(s.slots.active()).toBe(0);
    expect(s.clock.pending()).toBe(0);
  });

  it('refuses a picture that is not an image', async () => {
    const s = setup();
    const id = await s.offer('Alice');
    await s.message(id, { text: 'two things', pictures: [{ name: 'notes.png', bytes: TEXT }, { name: 'b.gif', bytes: GIF }, { name: 'c.png', bytes: TEXT }] });
    expect(s.refused).toEqual([{ to: 'alice', why: 'wrong-type' }]);
    expect(s.delivered).toHaveLength(1);
    expect(s.delivered[0]?.text).toBe('two things');
    expect(s.delivered[0]?.media.map((m) => [m.name, m.contentType])).toEqual([['b.gif', 'image/gif']]);
  });

  it('refuses a picture over the limit', async () => {
    const s = setup({ files: { directIm: true, maxMb: 1 } });
    const id = await s.offer('Alice');
    const big = new Uint8Array(MB + 1);
    big.set(PNG);
    await s.message(id, { pictures: [{ name: 'big.png', bytes: big }] });
    expect(s.refused).toEqual([{ to: 'alice', why: 'too-large' }]);
    expect(s.delivered).toEqual([]);
    expect(s.saved).toEqual([]);
  });

  it('refuses more than three pictures in one message', async () => {
    const s = setup();
    const id = await s.offer('Alice');
    const pictures = [1, 2, 3, 4].map((n) => ({ name: `${n}.png`, bytes: PNG }));
    await s.message(id, { text: 'all of these', pictures });
    expect(s.refused).toEqual([{ to: 'alice', why: 'too-many' }]);
    expect(s.saved).toEqual([]);
    expect(s.delivered).toEqual([{ from: 'alice', fromDisplay: 'Alice', text: 'all of these', media: [] }]);
    await s.message(id, { pictures: pictures.slice(0, FILES_LIMITS.perOffer) });
    expect(s.delivered[1]?.media).toHaveLength(3);
  });

  it('refuses a damaged message', async () => {
    const s = setup();
    const id = await s.offer('Alice');
    await s.message(id, { text: 'half', damaged: true, pictures: [{ name: 'a.png', bytes: PNG }] });
    expect(s.refused).toEqual([{ to: 'alice', why: 'damaged' }]);
    expect(s.delivered).toEqual([]);
    expect(s.saved).toEqual([]);
  });

  it('drops an auto-response', async () => {
    const s = setup();
    const id = await s.offer('Alice');
    await s.message(id, { text: 'away', autoResponse: true, pictures: [{ name: 'a.png', bytes: PNG }] });
    expect(s.delivered).toEqual([]);
    expect(s.refused).toEqual([]);
    expect(s.saved).toEqual([]);
  });

  it('drops a picture the store does not keep and delivers the rest', async () => {
    const s = setup();
    const id = await s.offer('Alice');
    s.state.saveError = new Error('disk full');
    await s.message(id, { text: 'see', pictures: [{ name: 'a.png', bytes: PNG }] });
    expect(s.delivered).toEqual([{ from: 'alice', fromDisplay: 'Alice', text: 'see', media: [] }]);
    expect(s.warnings).toContain('a Direct IM picture was not saved');
  });

  it('ignores a message of a session it did not accept', async () => {
    const s = setup();
    await s.message('other-9', { text: 'hi', pictures: [{ name: 'a.png', bytes: PNG }] });
    expect(s.delivered).toEqual([]);
    expect(s.saved).toEqual([]);
  });

  it('closes an idle session after five minutes and frees its slot', async () => {
    const s = setup();
    const id = await s.offer('Alice');
    s.clock.advance(FILES_LIMITS.idleMs - 1000);
    await s.message(id, { text: 'still here' });
    s.clock.advance(FILES_LIMITS.idleMs - 1);
    expect(s.calls).toEqual([`accept ${id}`]);
    s.clock.advance(1);
    await flush();
    expect(s.calls).toEqual([`accept ${id}`, `close ${id}`]);
    expect(s.slots.active()).toBe(0);
    expect(s.clock.pending()).toBe(0);
    await s.closed(id, 'alice', 'closed', 'self');
    expect(s.refused).toEqual([]);
    const next = await s.offer('Alice', 'alice-2');
    expect(s.calls.at(-1)).toBe(`accept ${next}`);
  });

  it('drops a message whose session went idle while the sender was checked', async () => {
    const s = setup();
    const id = await s.offer('Alice');
    let release = (): void => {};
    s.state.hold = new Promise<void>((resolve) => (release = resolve));
    s.emit('directMessage', { id, from: 'alice', fromDisplay: 'Alice', text: 'late', autoResponse: false, damaged: false, pictures: [{ name: 'a.png', bytes: PNG }] });
    await flush();
    s.clock.advance(FILES_LIMITS.idleMs);
    await flush();
    expect(s.calls).toEqual([`accept ${id}`, `close ${id}`]);
    release();
    await s.intake.idle();
    expect(s.delivered).toEqual([]);
    expect(s.saved).toEqual([]);
    expect(s.slots.active()).toBe(0);
    expect(s.clock.pending()).toBe(0);
  });

  it('cuts text longer than an IM can carry', async () => {
    const s = setup();
    const id = await s.offer('Bob');
    await s.message(id, { from: 'bob', fromDisplay: 'Bob', text: 'a'.repeat(FILES_LIMITS.textChars + 500), pictures: [{ name: 'a.png', bytes: PNG }] });
    expect(s.delivered[0]?.text).toBe('a'.repeat(FILES_LIMITS.textChars));
    expect(s.delivered[0]?.media).toHaveLength(1);
    expect(s.warnings).toContain('the text of a Direct IM was cut');
    await s.message(id, { from: 'bob', fromDisplay: 'Bob', text: `${'a'.repeat(FILES_LIMITS.textChars - 1)}\u{1f600}` });
    expect(s.delivered[1]?.text).toBe('a'.repeat(FILES_LIMITS.textChars - 1));
    await s.message(id, { from: 'bob', fromDisplay: 'Bob', text: 'b'.repeat(FILES_LIMITS.textChars) });
    expect(s.delivered[2]?.text).toHaveLength(FILES_LIMITS.textChars);
    expect(s.warnings).toHaveLength(2);
  });

  it('closes the session of a sender who is no longer allowed', async () => {
    const s = setup();
    const id = await s.offer('Bob');
    s.state.cfg = { channels: { oscar: { owners: ['alice'], allowFrom: [], files: { directIm: true } } } };
    await s.message(id, { from: 'bob', fromDisplay: 'Bob', text: 'look', pictures: [{ name: 'a.png', bytes: PNG }] });
    expect(s.calls).toEqual([`accept ${id}`, `close ${id}`]);
    expect(s.delivered).toEqual([]);
    expect(s.saved).toEqual([]);
    expect(s.strangers).toEqual([]);
    expect(s.slots.active()).toBe(0);
    expect(s.clock.pending()).toBe(0);
  });

  it('tells the sender when the session ended because a message was too large', async () => {
    const s = setup();
    const id = await s.offer('Alice');
    await s.closed(id, 'alice', 'too-large', 'peer');
    expect(s.refused).toEqual([{ to: 'alice', why: 'too-large' }]);
    expect(s.slots.active()).toBe(0);
    expect(s.clock.pending()).toBe(0);
  });

  it('still tells the sender when a message was too large after one that arrived', async () => {
    const s = setup();
    const id = await s.offer('Alice');
    await s.message(id, { pictures: [{ name: 'a.png', bytes: PNG }] });
    await s.closed(id, 'alice', 'too-large', 'peer');
    expect(s.delivered).toHaveLength(1);
    expect(s.refused).toEqual([{ to: 'alice', why: 'too-large' }]);
  });

  it('says nothing when the session ended at its total after a picture that arrived', async () => {
    const s = setup({ files: { directIm: true, maxMb: 1 } });
    const id = await s.offer('Alice');
    const big = new Uint8Array(MB);
    big.set(PNG);
    const { maxSessionBytes } = directImLimits(MB);
    const count = Math.ceil(maxSessionBytes / MB);
    for (let n = 0; n < count; n += 1) await s.message(id, { pictures: [{ name: 'a.png', bytes: big }] });
    await s.closed(id, 'alice', 'too-large', 'peer');
    expect(s.delivered).toHaveLength(count);
    expect(s.refused).toEqual([]);
    expect(s.slots.active()).toBe(0);
    expect(s.clock.pending()).toBe(0);
  });

  it('closes a session that brings a message after the setting went off', async () => {
    const s = setup();
    const id = await s.offer('Alice');
    s.state.cfg = { channels: { oscar: { owners: ['alice'], files: { directIm: false } } } };
    await s.message(id, { text: 'hello', pictures: [{ name: 'a.png', bytes: PNG }] });
    expect(s.calls).toEqual([`accept ${id}`, `close ${id}`]);
    expect(s.delivered).toEqual([]);
    expect(s.saved).toEqual([]);
    expect(s.refused).toEqual([]);
    expect(s.slots.active()).toBe(0);
  });

  it('frees the slot on every other ending without a message', async () => {
    for (const end of ['peer-closed', 'refused-address', 'signed-off', 'timed-out', 'bad-frame'] as const) {
      const s = setup();
      const id = await s.offer('Alice');
      await s.closed(id, 'alice', end);
      expect(s.refused).toEqual([]);
      expect(s.slots.active()).toBe(0);
      expect(s.clock.pending()).toBe(0);
    }
  });

  it('clears its timers on stop', async () => {
    const s = setup();
    const a = await s.offer('Alice');
    await s.offer('Bob');
    expect(s.clock.pending()).toBe(2);
    s.intake.stop();
    expect(s.clock.pending()).toBe(0);
    expect(s.slots.active()).toBe(0);
    await s.message(a, { text: 'late', pictures: [{ name: 'a.png', bytes: PNG }] });
    await s.offer('Alice', 'alice-2');
    expect(s.delivered).toEqual([]);
    expect(s.calls).toEqual([`accept ${a}`, 'accept bob-1']);
  });
});

describe('Direct IM intake, stopped part way', () => {
  it('delivers nothing that was still being saved at stop', async () => {
    const s = setup();
    const id = await s.offer('Alice');
    let release = (): void => {};
    s.emit('directMessage', { id, from: 'alice', fromDisplay: 'Alice', text: 'late', autoResponse: false, damaged: false, pictures: [{ name: 'a.txt', bytes: TEXT }, { name: 'a.png', bytes: PNG }] });
    await flush();
    s.state.hold = new Promise<void>((resolve) => (release = resolve));
    s.emit('directMessage', { id, from: 'alice', fromDisplay: 'Alice', text: 'later', autoResponse: false, damaged: false, pictures: [{ name: 'b.txt', bytes: TEXT }, { name: 'b.png', bytes: PNG }] });
    await flush();
    s.intake.stop();
    release();
    await flush();
    expect(s.delivered.map((d) => d.text)).toEqual(['late']);
    expect(s.refused).toHaveLength(1);
  });

  it('accepts no offer that was still being checked at stop', async () => {
    const s = setup();
    let release = (): void => {};
    s.state.hold = new Promise<void>((resolve) => (release = resolve));
    s.emit('directImOffer', { id: 'a-1', from: 'alice', fromDisplay: 'Alice' });
    await flush();
    s.intake.stop();
    release();
    await flush();
    expect(s.calls).toEqual([]);
    expect(s.slots.active()).toBe(0);
    expect(s.clock.pending()).toBe(0);
  });
});

describe('Direct IM intake, sending', () => {
  const OUT = 'alice-out-1';

  it('sends pictures in the session the person opened', async () => {
    const s = setup();
    const id = await s.offer('Alice');
    await s.opens(id, 'alice', 'receiving');
    await s.give('Alice', 'a.gif', 'b.gif');
    expect(s.sent).toEqual([{ id, names: ['a.gif', 'b.gif'] }]);
    expect(s.ends).toEqual(['done']);
    expect(s.calls).toEqual([`accept ${id}`]);
    expect(s.slots.active()).toBe(1);
  });

  it('waits for a session the person opened that is not open yet', async () => {
    const s = setup();
    const id = await s.offer('Alice');
    await s.give('alice', 'a.gif');
    expect(s.sent).toEqual([]);
    await s.opens(id, 'alice', 'receiving');
    expect(s.sent).toEqual([{ id, names: ['a.gif'] }]);
    expect(s.ends).toEqual(['done']);
    expect(s.calls).toEqual([`accept ${id}`]);
  });

  it('uses the session of an offer that was still being checked', async () => {
    const s = setup();
    let release = (): void => {};
    s.state.hold = new Promise<void>((resolve) => (release = resolve));
    s.emit('directImOffer', { id: 'a-1', from: 'alice', fromDisplay: 'Alice' });
    s.intake.send('alice', [{ name: 'a.gif', bytes: GIF, width: 1, height: 1 }], (outcome) => void s.ends.push(outcome));
    await flush();
    release();
    await s.intake.idle();
    expect(s.calls).toEqual(['accept a-1']);
    await s.opens('a-1', 'alice', 'receiving');
    expect(s.sent).toEqual([{ id: 'a-1', names: ['a.gif'] }]);
    expect(s.slots.active()).toBe(1);
  });

  it('opens a session, waits for it and sends', async () => {
    const s = setup();
    await s.give('Alice', 'a.gif');
    expect(s.calls).toEqual(['open alice']);
    expect(s.slots.active()).toBe(1);
    expect(s.sent).toEqual([]);
    expect(s.ends).toEqual([]);
    await s.opens(OUT, 'alice');
    expect(s.sent).toEqual([{ id: OUT, names: ['a.gif'] }]);
    expect(s.ends).toEqual(['done']);
    await s.give('alice', 'b.gif');
    expect(s.sent[1]).toEqual({ id: OUT, names: ['b.gif'] });
    expect(s.ends).toEqual(['done', 'done']);
    expect(s.calls).toEqual(['open alice']);
  });

  it('sends what was given while the session was opening, in order', async () => {
    const s = setup();
    await s.give('alice', 'a.gif', 'b.gif');
    await s.give('alice', 'c.gif');
    await s.give('alice', 'd.gif');
    expect(s.calls).toEqual(['open alice']);
    expect(s.slots.active()).toBe(1);
    await s.opens(OUT, 'alice');
    expect(s.sent).toEqual([
      { id: OUT, names: ['a.gif', 'b.gif', 'c.gif'] },
      { id: OUT, names: ['d.gif'] },
    ]);
    expect(s.ends).toEqual(['done', 'done', 'done']);
  });

  it('puts no more than three pictures in one message', async () => {
    const s = setup();
    await s.give('alice', 'a.gif', 'b.gif', 'c.gif', 'd.gif');
    await s.opens(OUT, 'alice');
    expect(s.sent.map((m) => m.names)).toEqual([['a.gif', 'b.gif', 'c.gif'], ['d.gif']]);
    expect(s.ends).toEqual(['done']);
  });

  it('keeps the pictures of one message within the size limit', async () => {
    const s = setup({ files: { directIm: true, maxMb: 1 } });
    const big = (name: string, size: number): Picture => {
      const bytes = new Uint8Array(size);
      bytes.set(GIF);
      return { name, bytes, width: 1, height: 1 };
    };
    const end = (outcome: SendOutcome): void => void s.ends.push(outcome);
    s.intake.send('alice', [big('a.gif', 600 * 1024), big('b.gif', 600 * 1024), big('c.gif', 100 * 1024)], end);
    s.intake.send('alice', [big('d.gif', 300 * 1024)], end);
    s.intake.send('alice', [big('e.gif', MB)], end);
    await s.intake.idle();
    await s.opens(OUT, 'alice');
    expect(s.sent.map((m) => m.names)).toEqual([['a.gif'], ['b.gif', 'c.gif', 'd.gif'], ['e.gif']]);
    expect(s.ends).toEqual(['done', 'done', 'done']);
  });

  it("accepts the person's offer that came while the bot was opening a session", async () => {
    const s = setup();
    let release = (): void => {};
    s.state.hold = new Promise<void>((resolve) => (release = resolve));
    s.state.openAs = 'a-1';
    s.intake.send('alice', [{ name: 'a.gif', bytes: GIF, width: 1, height: 1 }], (outcome) => void s.ends.push(outcome));
    await flush();
    s.emit('directImOffer', { id: 'a-1', from: 'alice', fromDisplay: 'Alice' });
    release();
    await s.intake.idle();
    expect(s.calls).toEqual(['open alice', 'accept a-1']);
    expect(s.slots.active()).toBe(1);
    await s.opens('a-1', 'alice', 'receiving');
    expect(s.sent).toEqual([{ id: 'a-1', names: ['a.gif'] }]);
    expect(s.ends).toEqual(['done']);
  });

  it('reports failed when the person declines, and when nobody answers', async () => {
    for (const [end, by] of [['declined', 'peer'], ['timed-out', undefined], ['refused-address', undefined], ['signed-off', undefined]] as const) {
      const s = setup();
      await s.give('alice', 'a.gif');
      await s.give('alice', 'b.gif');
      await s.closed(OUT, 'alice', end, by, 'offering');
      expect(s.ends).toEqual(['failed', 'failed']);
      expect(s.sent).toEqual([]);
      expect(s.refused).toEqual([]);
      expect(s.slots.active()).toBe(0);
      expect(s.clock.pending()).toBe(0);
    }
  });

  it('stops waiting on its own when no ending comes', async () => {
    const s = setup();
    await s.give('alice', 'a.gif');
    s.clock.advance(FILES_LIMITS.idleMs - 1);
    expect(s.ends).toEqual([]);
    s.clock.advance(1);
    await flush();
    expect(s.calls).toEqual(['open alice', `close ${OUT}`]);
    expect(s.ends).toEqual(['failed']);
    expect(s.slots.active()).toBe(0);
    await s.closed(OUT, 'alice', 'closed', 'self', 'offering');
    expect(s.ends).toEqual(['failed']);
  });

  it('reports failed when no slot is free', async () => {
    const s = setup({ allowFrom: ['bob', 'carol', 'dave', 'erin'] });
    for (const name of ['Alice', 'Bob', 'Carol', 'Dave']) await s.offer(name);
    await s.give('erin', 'a.gif');
    expect(s.ends).toEqual(['failed']);
    expect(s.calls.some((c) => c.startsWith('open'))).toBe(false);
    expect(s.slots.active()).toBe(4);
    expect(s.refused).toEqual([]);
  });

  it('reports failed when the session cannot be opened, and frees the slot', async () => {
    const s = setup();
    s.fail.open = new Error('not-online');
    await s.give('alice', 'a.gif');
    expect(s.ends).toEqual(['failed']);
    expect(s.slots.active()).toBe(0);
    expect(s.clock.pending()).toBe(0);
  });

  it('reports failed when the send rejects', async () => {
    const s = setup();
    await s.give('alice', 'a.gif');
    s.fail.send = new Error('the connection ended');
    await s.opens(OUT, 'alice');
    expect(s.ends).toEqual(['failed']);
    expect(s.sent).toEqual([]);
    expect(s.warnings).toHaveLength(1);
    s.fail.send = undefined;
    await s.give('alice', 'b.gif');
    expect(s.ends).toEqual(['failed', 'done']);
  });

  it('reports failed when the session ends while the pictures go out', async () => {
    const s = setup();
    await s.give('alice', 'a.gif');
    await s.opens(OUT, 'alice');
    let release = (): void => {};
    s.state.holdSend = new Promise<void>((resolve) => (release = resolve));
    s.intake.send('alice', [1, 2, 3, 4].map((n) => ({ name: `${n}.gif`, bytes: GIF, width: 1, height: 1 })), (outcome) => void s.ends.push(outcome));
    await flush();
    s.emit('directIm', { id: OUT, peer: 'alice', role: 'offering', state: 'closed', end: 'peer-closed' });
    await flush();
    release();
    await s.intake.idle();
    expect(s.sent.map((m) => m.names)).toEqual([['a.gif'], ['1.gif', '2.gif', '3.gif']]);
    expect(s.ends).toEqual(['done', 'failed']);
    expect(s.clock.pending()).toBe(0);
  });

  it('sends nothing to anyone who may not send to the bot', async () => {
    const s = setup();
    await s.give('Mallory', 'a.gif');
    await s.give('BotTwo', 'a.gif');
    await s.give('BotOne', 'a.gif');
    s.state.admit = false;
    await s.give('Bob', 'a.gif');
    expect(s.ends).toEqual(['failed', 'failed', 'failed', 'failed']);
    expect(s.calls).toEqual([]);
    expect(s.slots.active()).toBe(0);
    expect(s.strangers).toEqual([]);
  });

  it('sends nothing while the setting is off', async () => {
    const s = setup({ files: { directIm: false } });
    await s.give('alice', 'a.gif');
    expect(s.ends).toEqual(['failed']);
    expect(s.calls).toEqual([]);
  });

  it("accepts the person's unanswered offer in place of a new one", async () => {
    const s = setup();
    s.state.admit = false;
    await s.offer('Bob');
    s.state.admit = true;
    s.state.openAs = 'bob-1';
    await s.give('bob', 'a.gif');
    expect(s.calls).toEqual(['open bob', 'accept bob-1']);
    expect(s.slots.active()).toBe(1);
    await s.opens('bob-1', 'bob', 'receiving');
    expect(s.sent).toEqual([{ id: 'bob-1', names: ['a.gif'] }]);
    expect(s.ends).toEqual(['done']);
  });

  it('takes a picture the person sends back over a session the bot opened', async () => {
    const s = setup();
    await s.give('alice', 'a.gif');
    await s.opens(OUT, 'alice');
    await s.message(OUT, { text: 'and this one', pictures: [{ name: 'cat.png', bytes: PNG }] });
    expect(s.delivered).toEqual([
      {
        from: 'alice',
        fromDisplay: 'Alice',
        text: 'and this one',
        media: [{ path: '/media/inbound/1', contentType: 'image/png', kind: 'image', name: 'cat.png', bytes: PNG.byteLength, via: 'direct-im' }],
      },
    ]);
    await s.message(OUT, { pictures: [{ name: 'words.png', bytes: TEXT }] });
    expect(s.refused).toEqual([{ to: 'alice', why: 'wrong-type' }]);
  });

  it('closes a session the bot opened after it sat idle', async () => {
    const s = setup();
    await s.give('alice', 'a.gif');
    s.clock.advance(FILES_LIMITS.idleMs - 1000);
    await s.opens(OUT, 'alice');
    s.clock.advance(FILES_LIMITS.idleMs - 1000);
    await s.give('alice', 'b.gif');
    s.clock.advance(FILES_LIMITS.idleMs - 1000);
    await s.message(OUT, { text: 'thanks' });
    s.clock.advance(FILES_LIMITS.idleMs - 1);
    expect(s.calls).toEqual(['open alice']);
    s.clock.advance(1);
    await flush();
    expect(s.calls).toEqual(['open alice', `close ${OUT}`]);
    expect(s.ends).toEqual(['done', 'done']);
    expect(s.slots.active()).toBe(0);
    expect(s.clock.pending()).toBe(0);
    await s.give('alice', 'c.gif');
    expect(s.calls.at(-1)).toBe('open alice');
  });

  it('counts the start and the end of a send as activity', async () => {
    const s = setup();
    await s.give('alice', 'a.gif');
    await s.opens(OUT, 'alice');
    s.clock.advance(FILES_LIMITS.idleMs - 1000);
    let release = (): void => {};
    s.state.holdSend = new Promise<void>((resolve) => (release = resolve));
    s.intake.send('alice', [{ name: 'b.gif', bytes: GIF, width: 1, height: 1 }], (outcome) => void s.ends.push(outcome));
    await flush();
    s.clock.advance(FILES_LIMITS.idleMs - 1000);
    await flush();
    expect(s.calls).toEqual(['open alice']);
    release();
    await s.intake.idle();
    expect(s.ends).toEqual(['done', 'done']);
    s.clock.advance(FILES_LIMITS.idleMs - 1);
    await flush();
    expect(s.calls).toEqual(['open alice']);
    s.clock.advance(1);
    await flush();
    expect(s.calls).toEqual(['open alice', `close ${OUT}`]);
  });

  it('closes a session the bot opened when the person is no longer allowed', async () => {
    const s = setup();
    await s.give('bob', 'a.gif');
    await s.opens('bob-out-1', 'bob');
    s.state.cfg = { channels: { oscar: { owners: ['alice'], allowFrom: [], files: { directIm: true } } } };
    await s.message('bob-out-1', { from: 'bob', fromDisplay: 'Bob', text: 'look', pictures: [{ name: 'a.png', bytes: PNG }] });
    expect(s.calls).toEqual(['open bob', 'close bob-out-1']);
    expect(s.delivered).toEqual([]);
    expect(s.saved).toEqual([]);
    expect(s.slots.active()).toBe(0);
    expect(s.clock.pending()).toBe(0);
  });

  it('gives the slot back when a session the bot opened ends', async () => {
    for (const end of ['peer-closed', 'closed', 'cancelled', 'signed-off', 'bad-frame', 'too-large'] as const) {
      const s = setup();
      await s.give('alice', 'a.gif');
      await s.opens(OUT, 'alice');
      expect(s.slots.active()).toBe(1);
      await s.closed(OUT, 'alice', end, undefined, 'offering');
      expect(s.slots.active()).toBe(0);
      expect(s.clock.pending()).toBe(0);
      expect(s.ends).toEqual(['done']);
    }
  });

  it('tells nothing at stop, and reports failed after it', async () => {
    const s = setup();
    await s.give('alice', 'a.gif');
    await s.give('bob', 'b.gif');
    s.intake.stop();
    expect(s.ends).toEqual([]);
    expect(s.slots.active()).toBe(0);
    expect(s.clock.pending()).toBe(0);
    await s.opens(OUT, 'alice');
    expect(s.sent).toEqual([]);
    await s.give('alice', 'c.gif');
    expect(s.ends).toEqual(['failed']);
    expect(s.calls).toEqual(['open alice', 'open bob']);
  });

  it('closes a session whose id came after stop', async () => {
    const s = setup();
    let release = (): void => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const open = s.session.openDirectIm;
    s.session.openDirectIm = async (to: string) => {
      const id = await open(to);
      await held;
      return id;
    };
    s.intake.send('alice', [{ name: 'a.gif', bytes: GIF, width: 1, height: 1 }], (outcome) => void s.ends.push(outcome));
    await flush();
    s.intake.stop();
    release();
    await flush();
    expect(s.calls).toEqual(['open alice', `close ${OUT}`]);
    expect(s.slots.active()).toBe(0);
    expect(s.clock.pending()).toBe(0);
    expect(s.ends).toEqual([]);
  });
});
