import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('openclaw/plugin-sdk/channel-ingress-runtime', async () => (await import('../fake/openclaw.js')).channelIngressRuntime);

import { readPolicy } from '../../src/config.js';
import { IM_TIMING, admitSender, createImHandler, ingressParams, addImControlHandler } from '../../src/inbound/im.js';
import type { ImTurn } from '../../src/inbound/turn.js';
import type { ContactAttempt } from '../../src/notice.js';
import type { MediaEvent, TurnMedia } from '../../src/inbound/media-gate.js';
import type { ImEvent } from '../../src/oscar/index.js';
import { sdk } from '../fake/openclaw.js';

const log = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
const T0 = 100 * 3600_000;
const SHIPPED = { ...IM_TIMING };

function setup() {
  const turns: ImTurn[] = [];
  const contacts: ContactAttempt[] = [];
  const replays: ContactAttempt[][] = [];
  const lastReply = new Map<string, number>();
  const reached: string[] = [];
  let buddyUpdates = 0;
  let cfg: unknown = { channels: { oscar: { owners: ['Alice B', 'alice'], allowFrom: ['bob'], chain: { roster: [{ screenName: 'botone' }, { screenName: 'bottwo' }] } } } };
  const handler = createImHandler({
    accountId: 'default', self: () => 'botone', getCfg: () => cfg, now: () => Date.now(), timers: { setTimeout, clearTimeout }, log,
    admit: async (from, policy) => policy.dmPolicy !== 'disabled' && policy.allowFrom.includes(from),
    dispatch: async (turn) => { turns.push(turn); },
    contact: (a) => contacts.push(a),
    replayed: (list) => replays.push(list),
    lastReplyAt: (peer) => lastReply.get(peer),
    contacted: (peer) => reached.push(peer),
    updateBuddies: () => { buddyUpdates += 1; },
  });
  const im = (from: string, text: string, patch: Partial<ImEvent> = {}): ImEvent => ({
    from, fromDisplay: from, text, cookie: 0n, autoResponse: false, offline: false, system: false, ...patch,
  });
  const settle = async (ms: number) => { await handler.idle(); await vi.advanceTimersByTimeAsync(ms); await handler.idle(); };
  return { handler, turns, contacts, replays, lastReply, reached, im, settle, setCfg: (next: unknown) => { cfg = next; }, buddyUpdates: () => buddyUpdates };
}

beforeEach(() => {
  sdk.reset();
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  Object.assign(IM_TIMING, { debounceMs: 2000, replyCooldownMs: 2000, replaySettleMs: 3000, dedupeMs: 60_000, replayMaxAgeMs: 4 * 3600_000 });
});
const removers: (() => void)[] = [];
const control = (accountId: string, fn: Parameters<typeof addImControlHandler>[1]): (() => void) => {
  const off = addImControlHandler(accountId, fn);
  removers.push(off);
  return off;
};
afterEach(() => {
  for (const off of removers.splice(0)) off();
  vi.useRealTimers();
});

describe('timing', () => {
  it('ships the intervals the spec fixes', () => {
    expect(SHIPPED).toEqual({ debounceMs: 2000, replyCooldownMs: 2000, replaySettleMs: 3000, dedupeMs: 60_000, replayMaxAgeMs: 4 * 3600_000 });
  });
});

describe('check order', () => {
  it.each([
    ['server notice', { from: 'oossystemmsg', system: true }, 0, 0],
    ['a real account with the notice name', { from: 'oossystemmsg', system: false }, 0, 1],
    ['own echo', { from: 'botone' }, 0, 0],
    ['roster bot chatter', { from: 'bottwo' }, 0, 0],
    ['roster bot auto-response', { from: 'bottwo', autoResponse: true }, 0, 0],
    ['auto-response from an owner', { from: 'alice', autoResponse: true }, 0, 0],
    ['auto-response from a stranger', { from: 'mallory', autoResponse: true }, 0, 0],
    ['owner', { from: 'alice' }, 1, 0],
    ['owner with spaces in config', { from: 'aliceb' }, 1, 0],
    ['approved', { from: 'bob' }, 1, 0],
    ['stranger', { from: 'mallory' }, 0, 1],
  ])('%s', async (_label, patch, wantTurns, wantContacts) => {
    const t = setup();
    t.handler.onIm(t.im('x', 'hello', patch as Partial<ImEvent>));
    await t.settle(2000);
    expect(t.turns).toHaveLength(wantTurns);
    expect(t.contacts).toHaveLength(wantContacts);
    expect(t.reached).toHaveLength(wantTurns);
  });

  it('tells the away auto-reply about each live message from someone it answers, before the debounce', async () => {
    const t = setup();
    t.handler.onIm(t.im('Bob', 'one'));
    t.handler.onIm(t.im('bob', 'two'));
    t.handler.onIm(t.im('bob', 'late', { offline: true }));
    await t.handler.idle();
    expect(t.reached).toEqual(['bob', 'bob']);
    expect(t.turns).toEqual([]);
  });

  it('drops every IM from a roster bot when no control handler is installed', async () => {
    const t = setup();
    t.handler.onIm(t.im('bottwo', '#oc hello r=2 h=abcd1234'));
    t.handler.onIm(t.im('Bot Two', 'just chatting'));
    await t.settle(2000);
    expect(t.turns).toEqual([]);
    expect(t.contacts).toEqual([]);
  });

  it('asks the control handler after the notice and own-name checks and before everything else', async () => {
    const t = setup();
    const seen: string[] = [];
    control('default', (ev) => {
      seen.push(`${ev.from}|${ev.text}`);
      return ev.text.startsWith('#oc ') ? 'handled' : 'pass';
    });
    t.handler.onIm(t.im('oossystemmsg', '#oc hello r=1 h=abcd1234', { system: true }));
    t.handler.onIm(t.im('botone', '#oc hello r=1 h=abcd1234'));
    t.handler.onIm(t.im('Bot Two', '#oc hello r=2 h=abcd1234'));
    t.handler.onIm(t.im('bottwo', 'just chatting'));
    t.handler.onIm(t.im('mallory', '#oc hello r=1 h=abcd1234'));
    t.handler.onIm(t.im('mallory', 'psst'));
    t.handler.onIm(t.im('alice', 'hello'));
    await t.settle(2000);
    expect(seen).toEqual([
      'bottwo|#oc hello r=2 h=abcd1234', 'bottwo|just chatting', 'mallory|#oc hello r=1 h=abcd1234', 'mallory|psst', 'alice|hello',
    ]);
    expect(t.contacts.map((c) => c.name)).toEqual(['mallory']);
    expect(t.turns.map((turn) => turn.from)).toEqual(['alice']);
  });

  it('keeps control handlers apart by account and forgets one that is removed', async () => {
    const t = setup();
    control('other', () => 'handled');
    const off = control('default', () => 'handled');
    off();
    t.handler.onIm(t.im('alice', 'hello'));
    await t.settle(2000);
    expect(t.turns).toHaveLength(1);
  });

  it('runs control handlers in order and stops at the first that handles the IM', async () => {
    const t = setup();
    const seen: string[] = [];
    control('default', () => {
      seen.push('first');
      return 'pass';
    });
    control('default', () => {
      seen.push('second');
      return 'handled';
    });
    control('default', () => {
      seen.push('third');
      return 'handled';
    });
    t.handler.onIm(t.im('alice', 'team private'));
    await t.settle(2000);
    expect(seen).toEqual(['first', 'second']);
    expect(t.turns).toEqual([]);
  });

  it('records a stranger as an im contact with the display name', async () => {
    const t = setup();
    t.handler.onIm(t.im('mallory', 'psst', { fromDisplay: 'Mal Lory' }));
    await t.settle(0);
    expect(t.contacts).toEqual([{ name: 'mallory', display: 'Mal Lory', kind: 'im', at: T0 }]);
  });

  it('removal takes effect on the next message', async () => {
    const t = setup();
    t.handler.onIm(t.im('bob', 'one'));
    await t.settle(2000);
    t.setCfg({ channels: { oscar: { owners: ['alice'], allowFrom: [] } } });
    t.handler.onIm(t.im('bob', 'two'));
    await t.settle(2000);
    expect(t.turns.map((x) => x.text)).toEqual(['one']);
    expect(t.contacts.map((c) => c.name)).toEqual(['bob']);
    expect(t.buddyUpdates()).toBe(1);
  });

  it('an emptied owner list closes the door at the next message', async () => {
    const t = setup();
    t.handler.onIm(t.im('bob', 'one'));
    await t.settle(2000);
    t.setCfg({ channels: { oscar: { owners: [], allowFrom: ['bob'] } } });
    t.handler.onIm(t.im('bob', 'two'));
    t.handler.onIm(t.im('alice', 'three'));
    await t.settle(2000);
    expect(t.turns.map((x) => x.text)).toEqual(['one']);
  });

  it('admits nobody when dmPolicy is disabled', async () => {
    const t = setup();
    t.setCfg({ channels: { oscar: { owners: ['alice'], dmPolicy: 'disabled' } } });
    t.handler.onIm(t.im('alice', 'hi'));
    await t.settle(2000);
    expect(t.turns).toEqual([]);
  });
});

describe('dedupe', () => {
  it('drops a repeated non-zero cookie inside 60 s and lets it through after', async () => {
    const t = setup();
    t.handler.onIm(t.im('alice', 'a', { cookie: 9n }));
    t.handler.onIm(t.im('alice', 'a', { cookie: 9n }));
    t.handler.onIm(t.im('bob', 'a', { cookie: 9n }));
    await t.settle(2000);
    expect(t.turns.map((x) => [x.from, x.text])).toEqual([['alice', 'a'], ['bob', 'a']]);
    await vi.advanceTimersByTimeAsync(60_000);
    t.handler.onIm(t.im('alice', 'a', { cookie: 9n }));
    await t.settle(2000);
    expect(t.turns).toHaveLength(3);
  });

  it('never dedupes cookie 0', async () => {
    const t = setup();
    t.handler.onIm(t.im('alice', 'first'));
    t.handler.onIm(t.im('alice', 'second'));
    await t.settle(2000);
    expect(t.turns.map((x) => x.text)).toEqual(['first\nsecond']);
  });
});

describe('debounce', () => {
  it('joins a burst and restarts the clock on every line', async () => {
    const t = setup();
    t.handler.onIm(t.im('alice', 'one'));
    await t.settle(1500);
    t.handler.onIm(t.im('alice', 'two'));
    await t.settle(1999);
    expect(t.turns).toEqual([]);
    await t.settle(1);
    expect(t.turns).toHaveLength(1);
    expect(t.turns[0]).toMatchObject({ from: 'alice', text: 'one\ntwo' });
  });

  it('keeps peers apart', async () => {
    const t = setup();
    t.handler.onIm(t.im('alice', 'a'));
    t.handler.onIm(t.im('bob', 'b'));
    await t.settle(2000);
    expect(t.turns.map((x) => x.from).sort()).toEqual(['alice', 'bob']);
  });

  it('flushes the burst first and then sends a slash line alone, at once', async () => {
    const t = setup();
    t.handler.onIm(t.im('alice', 'hold on'));
    t.handler.onIm(t.im('alice', '/new'));
    await t.settle(0);
    expect(t.turns.map((x) => x.text)).toEqual(['hold on', '/new']);
  });
});

describe('loop guard', () => {
  it('holds even a slash line until two seconds after the last reply', async () => {
    const t = setup();
    t.lastReply.set('alice', T0 - 500);
    t.handler.onIm(t.im('alice', '/status'));
    await t.settle(1499);
    expect(t.turns).toEqual([]);
    await t.settle(1);
    expect(t.turns.map((x) => x.text)).toEqual(['/status']);
  });

  it('never glues a held slash line to the next message', async () => {
    const t = setup();
    t.lastReply.set('alice', T0 - 500);
    t.handler.onIm(t.im('alice', '/status'));
    t.handler.onIm(t.im('alice', 'and another thing'));
    await t.settle(4000);
    expect(t.turns.map((x) => x.text)).toEqual(['/status', 'and another thing']);
  });

  it('drops the fourth identical body in a row and recovers on a new one', async () => {
    const t = setup();
    for (let i = 0; i < 5; i += 1) {
      t.handler.onIm(t.im('bob', 'ping'));
      await t.settle(2000);
    }
    expect(t.turns).toHaveLength(3);
    t.handler.onIm(t.im('bob', 'pong'));
    await t.settle(2000);
    t.handler.onIm(t.im('bob', 'ping'));
    await t.settle(2000);
    expect(t.turns.map((x) => x.text)).toEqual(['ping', 'ping', 'ping', 'pong', 'ping']);
  });

  it('does not count slash lines as repeats', async () => {
    const t = setup();
    for (let i = 0; i < 5; i += 1) {
      t.handler.onIm(t.im('alice', '/status'));
      await t.settle(2000);
    }
    expect(t.turns).toHaveLength(5);
  });
});

describe('offline replay', () => {
  it('coalesces per sender with ages, drops the stale, rolls strangers up once', async () => {
    const t = setup();
    const ago = (s: number) => ({ offline: true, sentAt: T0 - s * 1000 });
    t.handler.onIm(t.im('alice', '/new', ago(7200)));
    t.handler.onIm(t.im('alice', 'too old', ago(4 * 3600 + 1)));
    t.handler.onIm(t.im('mallory', 'psst', ago(60)));
    t.handler.onIm(t.im('alice', 'are you there', { offline: true }));
    t.handler.onIm(t.im('trudy', 'hey', ago(30)));
    t.handler.onIm(t.im('bob', 'hello', ago(10)));
    await t.settle(2999);
    expect(t.turns).toEqual([]);
    await t.settle(1);
    expect(t.turns).toHaveLength(2);
    expect(t.turns.find((x) => x.from === 'alice')).toMatchObject({
      text: '/new\nare you there', replayed: [{ text: '/new', ageSeconds: 7200 }, { text: 'are you there', ageSeconds: null }],
    });
    expect(t.turns.find((x) => x.from === 'bob')?.replayed).toEqual([{ text: 'hello', ageSeconds: 10 }]);
    expect(t.contacts).toEqual([]);
    expect(t.replays).toHaveLength(1);
    expect(t.replays[0]?.map((c) => c.name)).toEqual(['mallory', 'trudy']);
  });
});

describe('stop', () => {
  it('drops pending work', async () => {
    const t = setup();
    t.handler.onIm(t.im('alice', 'one'));
    await t.handler.idle();
    t.handler.stop();
    await t.settle(5000);
    t.handler.onIm(t.im('alice', 'two'));
    await t.settle(5000);
    expect(t.turns).toEqual([]);
  });
});

describe('ingress call', () => {
  it('names every policy explicitly and never allows pairing', async () => {
    const policy = readPolicy({ channels: { oscar: { owners: ['Alice B'], allowFrom: ['bob'] } } });
    expect(ingressParams('botone', 'mallory', policy)).toMatchObject({
      channelId: 'oscar', accountId: 'botone', subject: { stableId: 'mallory' }, conversation: { kind: 'direct', id: 'mallory' },
      event: { kind: 'message', authMode: 'inbound', mayPair: false }, dmPolicy: 'allowlist', groupPolicy: 'disabled',
      allowFrom: ['aliceb', 'bob'], useDefaultPairingStore: false, command: false,
    });
    expect(await admitSender('botone', 'mallory', policy)).toBe(false);
    expect(await admitSender('botone', 'aliceb', policy)).toBe(true);
    expect(sdk.ingress.map((r) => r.decision)).toEqual(['block', 'allow']);
  });

  it('adds the star the host wants only under open', async () => {
    const open = readPolicy({ channels: { oscar: { owners: ['alice'], dmPolicy: 'open', dangerouslyAllowOpenDm: true } } });
    expect(ingressParams('botone', 'mallory', open).allowFrom).toEqual(['alice', '*']);
    expect(await admitSender('botone', 'mallory', open)).toBe(true);
    const unflagged = readPolicy({ channels: { oscar: { owners: ['alice'], dmPolicy: 'open' } } });
    expect(ingressParams('botone', 'mallory', unflagged)).toMatchObject({ dmPolicy: 'allowlist', allowFrom: ['alice'] });
    expect(await admitSender('botone', 'mallory', unflagged)).toBe(false);
  });

  it('normalises allowlist entries and subjects the same way', () => {
    const policy = readPolicy({});
    const normalize = ingressParams('botone', 'x', policy).identity?.normalize;
    expect(normalize?.('oscar:Alice B')).toBe('aliceb');
    expect(normalize?.('   ')).toBeNull();
  });
});

describe('pictures and files', () => {
  const picture = (name: string, patch: Partial<TurnMedia> = {}): TurnMedia => ({
    path: `/media/inbound/${name}`, contentType: 'image/png', kind: 'image', name, bytes: 12, via: 'direct-im', ...patch,
  });
  const files = (from: string, text: string, media: TurnMedia[]): MediaEvent => ({ from, fromDisplay: from, text, media });

  it('folds a picture into the burst of the IMs around it', async () => {
    const t = setup();
    t.handler.onIm(t.im('alice', 'look at this', { cookie: 5n }));
    t.handler.onMedia(files('alice', '', [picture('cat.png')]));
    t.handler.onIm(t.im('alice', 'and tell me what it is', { cookie: 6n }));
    await t.settle(2000);
    expect(t.turns).toHaveLength(1);
    expect(t.turns[0]).toMatchObject({ from: 'alice', text: 'look at this\nand tell me what it is', cookie: 5n, media: [picture('cat.png')] });
  });

  it('keeps the text that came with a picture and the order of the files', async () => {
    const t = setup();
    t.handler.onMedia(files('Alice', 'first', [picture('one.png')]));
    t.handler.onMedia(files('alice', '', [picture('two.png'), picture('notes.md', { contentType: 'text/markdown', kind: 'document', via: 'send-file' })]));
    await t.settle(2000);
    expect(t.turns).toHaveLength(1);
    expect(t.turns[0]?.text).toBe('first');
    expect(t.turns[0]?.media?.map((m) => m.name)).toEqual(['one.png', 'two.png', 'notes.md']);
  });

  it('runs a turn for files with no text', async () => {
    const t = setup();
    t.handler.onMedia(files('bob', '', [picture('cat.png')]));
    await t.settle(1999);
    expect(t.turns).toEqual([]);
    await t.settle(1);
    expect(t.turns).toEqual([{ from: 'bob', fromDisplay: 'bob', text: '', cookie: 0n, at: T0 + 2000, media: [picture('cat.png')] }]);
    expect(t.reached).toEqual(['bob']);
  });

  it('keeps a file out of the repeat guard', async () => {
    const t = setup();
    for (let i = 0; i < 5; i += 1) {
      t.handler.onMedia(files('alice', 'same words', [picture(`p${i}.png`)]));
      await t.settle(2000);
    }
    expect(t.turns).toHaveLength(5);
    t.handler.onIm(t.im('alice', 'same words'));
    await t.settle(2000);
    expect(t.turns).toHaveLength(6);
  });

  it('holds a file turn until the reply cooldown is over', async () => {
    const t = setup();
    t.lastReply.set('alice', T0 + 3000);
    t.handler.onMedia(files('alice', '', [picture('cat.png')]));
    await t.settle(4999);
    expect(t.turns).toEqual([]);
    await t.settle(1);
    expect(t.turns).toHaveLength(1);
  });

  it('leaves the media field off a turn that has no file', async () => {
    const t = setup();
    t.handler.onMedia(files('alice', 'typed in a Direct IM', []));
    await t.settle(2000);
    expect(t.turns).toEqual([{ from: 'alice', fromDisplay: 'alice', text: 'typed in a Direct IM', cookie: 0n, at: T0 + 2000 }]);
  });

  it('ends a turn when the next files would take it past the limit', async () => {
    const t = setup();
    for (let i = 0; i < 4; i += 1) {
      t.handler.onMedia(files('alice', `set ${i}`, [picture(`a${i}.png`), picture(`b${i}.png`)]));
      await t.settle(1000);
    }
    await t.settle(2000);
    expect(t.turns.map((turn) => turn.media?.map((m) => m.name))).toEqual([
      ['a0.png', 'b0.png'], ['a1.png', 'b1.png'], ['a2.png', 'b2.png'], ['a3.png', 'b3.png'],
    ]);
    expect(t.turns.map((turn) => turn.text)).toEqual(['set 0', 'set 1', 'set 2', 'set 3']);
  });

  it('gives no turn more files than the limit however fast they come', async () => {
    const t = setup();
    t.handler.onIm(t.im('alice', 'here they are'));
    for (let i = 0; i < 10; i += 1) t.handler.onMedia(files('alice', '', [picture(`p${i}.png`)]));
    await t.settle(2000);
    expect(t.turns.map((turn) => turn.media?.length)).toEqual([3, 3, 3, 1]);
    expect(t.turns.flatMap((turn) => turn.media ?? []).map((m) => m.name)).toEqual(Array.from({ length: 10 }, (_, i) => `p${i}.png`));
    expect(t.turns.map((turn) => turn.text)).toEqual(['here they are', '', '', '']);
  });

  it('splits one event that holds more files than the limit', async () => {
    const t = setup();
    t.handler.onMedia(files('alice', 'all of them', Array.from({ length: 7 }, (_, i) => picture(`p${i}.png`))));
    await t.settle(2000);
    expect(t.turns.map((turn) => turn.media?.length)).toEqual([3, 3, 1]);
    expect(t.turns[0]?.text).toBe('all of them');
  });

  it('lets text join a turn that is full of files', async () => {
    const t = setup();
    t.handler.onMedia(files('alice', '', [picture('a.png'), picture('b.png'), picture('c.png')]));
    t.handler.onIm(t.im('alice', 'what are these'));
    await t.settle(2000);
    expect(t.turns).toHaveLength(1);
    expect(t.turns[0]).toMatchObject({ text: 'what are these' });
    expect(t.turns[0]?.media).toHaveLength(3);
  });

  it('drops files that arrive after the stop', async () => {
    const t = setup();
    t.handler.onMedia(files('alice', '', [picture('cat.png')]));
    await t.handler.idle();
    t.handler.stop();
    t.handler.onMedia(files('alice', '', [picture('dog.png')]));
    await t.settle(5000);
    expect(t.turns).toEqual([]);
  });
});
