import { describe, expect, it } from 'vitest';
import { createDirectImIntake } from '../../../src/inbound/direct-im.js';
import { FILES_LIMITS, Slots } from '../../../src/inbound/media-gate.js';
import type { MediaEvent, Refusal } from '../../../src/inbound/media-gate.js';
import type { DirectImEnd, DirectMessageEvent, OscarEvents } from '../../../src/oscar/index.js';
import { flush, manualTimers } from '../rooms-fixtures.js';

const PNG = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4);
const GIF = Uint8Array.from([...'GIF89a'].map((c) => c.charCodeAt(0)).concat([1, 0, 1, 0]));
const TEXT = Uint8Array.from([...'just words'].map((c) => c.charCodeAt(0)));
const MB = 1024 * 1024;

type Handler = (payload: unknown) => void;

function setup(sec: Record<string, unknown> = {}) {
  const handlers = new Map<string, Set<Handler>>();
  const calls: string[] = [];
  const fail: { accept?: unknown; close?: unknown } = {};
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
  const closed = async (id: string, peer: string, end: DirectImEnd = 'peer-closed', by?: 'self' | 'peer'): Promise<void> => {
    emit('directIm', { id, peer, state: 'closed', end, ...(by ? { by } : {}) });
    await intake.idle();
  };
  return { session, emit, calls, fail, clock, slots, delivered, refused, strangers, saved, warnings, state, intake, offer, message, closed };
}

describe('Direct IM intake', () => {
  it("accepts an owner's offer and delivers the picture with its text", async () => {
    const s = setup();
    const id = await s.offer('Alice');
    expect(s.calls).toEqual([`accept ${id}`]);
    expect(s.slots.active()).toBe(1);
    s.emit('directIm', { id, peer: 'alice', state: 'open' });
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

  it('declines a stranger before accepting and reports the attempt', async () => {
    const s = setup();
    const id = await s.offer('Mallory');
    expect(s.calls).toEqual([`decline ${id}`]);
    expect(s.strangers).toEqual([{ name: 'mallory', display: 'Mallory' }]);
    expect(s.refused).toEqual([]);
    expect(s.slots.active()).toBe(0);
    await s.message(id, { from: 'mallory', fromDisplay: 'Mallory', text: 'hi', pictures: [{ name: 'a.png', bytes: PNG }] });
    expect(s.delivered).toEqual([]);
    expect(s.saved).toEqual([]);
  });

  it('declines a stranger under dmPolicy open', async () => {
    const s = setup({ dmPolicy: 'open', dangerouslyAllowOpenDm: true });
    const id = await s.offer('Mallory');
    expect(s.calls).toEqual([`decline ${id}`]);
    expect(s.strangers).toHaveLength(1);
  });

  it('declines a teammate bot without a notice', async () => {
    const s = setup();
    const id = await s.offer('BotTwo');
    expect(s.calls).toEqual([`decline ${id}`]);
    expect(s.strangers).toEqual([]);
    expect(s.refused).toEqual([]);
  });

  it('declines an approved person the host does not admit', async () => {
    const s = setup();
    s.state.admit = false;
    const id = await s.offer('Bob');
    expect(s.calls).toEqual([`decline ${id}`]);
    expect(s.strangers).toEqual([]);
  });

  it('declines every offer while the setting is off', async () => {
    const s = setup({ files: { directIm: false } });
    const a = await s.offer('Alice');
    const m = await s.offer('Mallory');
    expect(s.calls).toEqual([`decline ${a}`, `decline ${m}`]);
    expect(s.strangers).toEqual([]);
    expect(s.refused).toEqual([]);
    expect(s.slots.active()).toBe(0);
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
    s.emit('directIm', { id: 'a-1', peer: 'alice', state: 'closed', end: 'cancelled', by: 'peer' });
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
