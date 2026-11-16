import { describe, expect, it } from 'vitest';
import { copy } from '../../../src/copy.js';
import { FILES_LIMITS, Slots, createRefusals, offerRule, senderGate } from '../../../src/inbound/media-gate.js';
import { policyFixture } from '../rooms-fixtures.js';

const yes = async (): Promise<boolean> => true;
const no = async (): Promise<boolean> => false;

describe('senderGate', () => {
  it('allows an owner and an approved person', async () => {
    const policy = policyFixture();
    expect(await senderGate({ from: 'Alice', self: 'BotOne', policy, admit: yes })).toBe('allow');
    expect(await senderGate({ from: 'bob', self: 'BotOne', policy, admit: yes })).toBe('allow');
  });

  it('calls an unlisted sender a stranger, also under dmPolicy open', async () => {
    expect(await senderGate({ from: 'mallory', self: 'BotOne', policy: policyFixture(), admit: yes })).toBe('stranger');
    expect(await senderGate({ from: 'mallory', self: 'BotOne', policy: policyFixture({ dmPolicy: 'open' }), admit: yes })).toBe('stranger');
  });

  it("is silent for a teammate bot and for the bot's own name", async () => {
    const policy = policyFixture({ teammates: ['bottwo'] });
    expect(await senderGate({ from: 'Bot Two', self: 'BotOne', policy, admit: yes })).toBe('silent');
    expect(await senderGate({ from: 'bot one', self: 'BotOne', policy, admit: yes })).toBe('silent');
    expect(await senderGate({ from: '', self: 'BotOne', policy, admit: yes })).toBe('silent');
  });

  it('is silent for an approved person the host does not admit', async () => {
    const asked: string[] = [];
    const admit = async (from: string): Promise<boolean> => {
      asked.push(from);
      return false;
    };
    expect(await senderGate({ from: 'Bob', self: 'BotOne', policy: policyFixture(), admit })).toBe('silent');
    expect(asked).toEqual(['bob']);
    expect(await senderGate({ from: 'alice', self: 'BotOne', policy: policyFixture(), admit: no })).toBe('silent');
  });

  it('does not ask the host about a stranger', async () => {
    let asked = 0;
    const admit = async (): Promise<boolean> => {
      asked += 1;
      return true;
    };
    await senderGate({ from: 'mallory', self: 'BotOne', policy: policyFixture(), admit });
    expect(asked).toBe(0);
  });
});

describe('Slots', () => {
  it('gives one transfer per person and four in total', () => {
    const slots = new Slots();
    expect(slots.take('alice', 'send-file')).toBe('ok');
    expect(slots.take('Alice', 'send-file')).toBe('busy');
    expect(slots.take('bob', 'send-file')).toBe('ok');
    expect(slots.take('carol', 'send-file')).toBe('ok');
    expect(slots.take('dave', 'send-file')).toBe('ok');
    expect(slots.active()).toBe(FILES_LIMITS.active);
    expect(slots.take('erin', 'send-file')).toBe('busy-others');
    expect(slots.take('alice', 'send-file')).toBe('busy');
    slots.release('ALICE', 'send-file');
    expect(slots.active()).toBe(3);
    expect(slots.take('erin', 'send-file')).toBe('ok');
  });

  it('counts a Direct IM session and a transfer of one person apart', () => {
    const slots = new Slots();
    expect(slots.take('alice', 'direct-im')).toBe('ok');
    expect(slots.take('alice', 'send-file')).toBe('ok');
    expect(slots.take('alice', 'direct-im')).toBe('busy');
    expect(slots.active()).toBe(2);
    slots.release('alice', 'direct-im');
    slots.release('alice', 'direct-im');
    expect(slots.active()).toBe(1);
  });

  it('counts a file the bot sends apart from one it takes, within the same four', () => {
    const slots = new Slots();
    expect(slots.take('alice', 'send-file')).toBe('ok');
    expect(slots.take('alice', 'send-file-out')).toBe('ok');
    expect(slots.take('Alice', 'send-file-out')).toBe('busy');
    expect(slots.take('bob', 'send-file-out')).toBe('ok');
    expect(slots.take('carol', 'direct-im')).toBe('ok');
    expect(slots.take('dave', 'send-file-out')).toBe('busy-others');
    slots.release('alice', 'send-file-out');
    expect(slots.take('dave', 'send-file-out')).toBe('ok');
  });
});

describe('createRefusals', () => {
  const cfg = { channels: { oscar: { owners: ['alice'], allowFrom: ['bob'], files: { sendFile: true, maxMb: 5 } } } };
  const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  function harness(send?: (to: string, text: string) => Promise<void>) {
    const clock = { at: 1_000_000 };
    const sent: { to: string; text: string }[] = [];
    const warnings: { msg: string; fields?: Record<string, unknown> }[] = [];
    const refuse = createRefusals({
      getCfg: () => cfg,
      now: () => clock.at,
      log: { debug() {}, info() {}, warn: (msg, fields) => void warnings.push({ msg, ...(fields ? { fields } : {}) }), error() {} },
      send: send ?? (async (to, text) => void sent.push({ to, text })),
    });
    return { clock, sent, warnings, refuse };
  }

  it('sends one IM for a refusal', async () => {
    const h = harness();
    h.refuse('Bob', 'too-large');
    await settle();
    expect(h.sent).toEqual([{ to: 'bob', text: copy.fileRefused('too-large', 5) }]);
  });

  it('sends the same refusal to the same person once a minute', async () => {
    const h = harness();
    h.refuse('bob', 'busy');
    h.clock.at += FILES_LIMITS.refusalCooldownMs - 1;
    h.refuse('Bob', 'busy');
    h.refuse('bob', 'wrong-type');
    h.refuse('alice', 'busy');
    await settle();
    expect(h.sent.map((m) => `${m.to}:${m.text}`)).toEqual([
      `bob:${copy.fileRefused('busy', 5)}`, `bob:${copy.fileRefused('wrong-type', 5)}`, `alice:${copy.fileRefused('busy', 5)}`,
    ]);
    h.clock.at += 1;
    h.refuse('bob', 'busy');
    await settle();
    expect(h.sent).toHaveLength(4);
    expect(h.sent[3]).toEqual({ to: 'bob', text: copy.fileRefused('busy', 5) });
  });

  it('logs a refusal that could not be sent', async () => {
    const h = harness(async () => { throw new Error('rate limited'); });
    h.refuse('bob', 'damaged');
    await settle();
    expect(h.warnings).toEqual([{ msg: 'refusal was not delivered', fields: { to: 'bob', why: 'damaged', error: 'rate limited' } }]);
  });
});

describe('offerRule', () => {
  function setup(sec: Record<string, unknown> = {}) {
    const strangers: { name: string; display: string }[] = [];
    const warnings: string[] = [];
    const state: { cfg: unknown } = { cfg: { channels: { oscar: { owners: ['alice'], allowFrom: ['bob'], chain: { roster: [{ screenName: 'botone' }, { screenName: 'bottwo' }] }, files: { directIm: true, sendFile: true }, ...sec } } } };
    const rule = offerRule({
      self: () => 'BotOne',
      getCfg: () => state.cfg,
      log: { debug() {}, info() {}, warn: (msg: string) => void warnings.push(msg), error() {} },
      stranger: (name, display) => void strangers.push({ name, display }),
    });
    return { rule, strangers, warnings, state };
  }

  it('lets the offer of an owner or an approved person through, with no notice', () => {
    const s = setup();
    expect(s.rule('send-file', 'Alice')).toBe(true);
    expect(s.rule('direct-im', 'B ob')).toBe(true);
    expect(s.strangers).toEqual([]);
  });

  it('drops the offer of a stranger and reports each attempt, also under dmPolicy open', () => {
    const s = setup({ dmPolicy: 'open', dangerouslyAllowOpenDm: true });
    expect(s.rule('send-file', 'Mallory')).toBe(false);
    expect(s.rule('direct-im', 'Mal lory')).toBe(false);
    expect(s.strangers).toEqual([{ name: 'mallory', display: 'Mallory' }, { name: 'mallory', display: 'Mal lory' }]);
  });

  it('drops the offer of a teammate bot, of the bot itself and of no name, with no notice', () => {
    const s = setup();
    expect(s.rule('send-file', 'Bot Two')).toBe(false);
    expect(s.rule('direct-im', 'botone')).toBe(false);
    expect(s.rule('send-file', '')).toBe(false);
    expect(s.strangers).toEqual([]);
  });

  it('reports a stranger only for the kind that is on', () => {
    const s = setup({ files: { directIm: true, sendFile: false } });
    expect(s.rule('send-file', 'Mallory')).toBe(false);
    expect(s.strangers).toEqual([]);
    expect(s.rule('direct-im', 'Mallory')).toBe(false);
    expect(s.strangers).toHaveLength(1);
  });

  it('reads the lists again for each offer', () => {
    const s = setup();
    expect(s.rule('send-file', 'Mallory')).toBe(false);
    s.state.cfg = { channels: { oscar: { owners: ['alice'], allowFrom: ['mallory'], files: { sendFile: true } } } };
    expect(s.rule('send-file', 'Mallory')).toBe(true);
  });

  it('drops the offer when the notice throws', () => {
    const rule = offerRule({
      self: () => 'BotOne',
      getCfg: () => ({ channels: { oscar: { owners: ['alice'], files: { sendFile: true } } } }),
      log: { debug() {}, info() {}, warn() {}, error() {} },
      stranger: () => {
        throw new Error('no notice');
      },
    });
    expect(rule('send-file', 'Mallory')).toBe(false);
  });
});
