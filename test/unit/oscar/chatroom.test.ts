import { describe, expect, it } from 'vitest';
import {
  ChatRoom,
  decodeRoomMessage,
  decodeRoster,
  encodeClassIds,
  encodeRoomClientOnline,
  encodeRoomSend,
  newRoomCookie,
  type ChatRoomEvents,
} from '../../../src/oscar/chatroom.js';
import {
  CHAT_MSG_TO_CLIENT,
  CHAT_MSG_TO_HOST,
  CHAT_USERS_JOINED,
  CHAT_USERS_LEFT,
  FAMILY_CHAT,
  FAMILY_OSERVICE,
  OSERVICE_CLIENT_ONLINE,
  OSERVICE_RATE_PARAMS_QUERY,
  OSERVICE_RATE_PARAMS_REPLY,
  OSERVICE_RATE_PARAMS_SUB_ADD,
  OSERVICE_RATE_PARAM_CHANGE,
} from '../../../src/oscar/constants.js';
import { encodeUserInfo } from '../../../src/oscar/snac.js';
import { decodeTlvs, encodeTlvs, findTlv, type Tlv } from '../../../src/oscar/tlv.js';
import { FakeLink, ManualClock, StubPacer, flush, quietLog, toHex, vector, vectorHex } from './room-kit.js';

const room = { exchange: 4 as const, name: 'testroom' };

function roster(...names: string[]): Uint8Array {
  return Buffer.concat(names.map((name) => Buffer.from(encodeUserInfo({ name, warning: 0, tlvs: [] }))));
}

function relay(opts: { from: string; text: string | Uint8Array; cookie?: bigint; isPublic?: boolean; encoding?: string | null }): Uint8Array {
  const head = Buffer.alloc(10);
  head.writeBigUInt64BE(opts.cookie ?? 0x55n, 0);
  head.writeUInt16BE(3, 8);
  const inner: Tlv[] = [];
  if (opts.encoding !== null) inner.push({ tag: 0x02, value: Buffer.from(opts.encoding ?? 'us-ascii') });
  inner.push({ tag: 0x01, value: typeof opts.text === 'string' ? Buffer.from(opts.text, 'utf8') : opts.text });
  const tlvs: Tlv[] = [{ tag: 0x03, value: encodeUserInfo({ name: opts.from, warning: 0, tlvs: [] }) }];
  if (opts.isPublic !== false) tlvs.push({ tag: 0x01, value: new Uint8Array(0) });
  tlvs.push({ tag: 0x05, value: encodeTlvs(inner) });
  return Buffer.concat([head, Buffer.from(encodeTlvs(tlvs))]);
}

async function joined(occupants: string[] = ['Bot One', 'alice', 'bottwo']) {
  const link = new FakeLink();
  const clock = new ManualClock();
  const pacer = new StubPacer();
  let nextCookie = 0x1000n;
  link.onRequest = (snac) =>
    snac.family === FAMILY_OSERVICE && snac.subtype === OSERVICE_RATE_PARAMS_QUERY
      ? { family: FAMILY_OSERVICE, subtype: OSERVICE_RATE_PARAMS_REPLY, body: Uint8Array.from([0x00, 0x00]) }
      : undefined;
  const chat = new ChatRoom({
    room, link, self: 'Bot One', pacer, log: quietLog, now: clock.now, timers: clock.timers,
    newCookie: () => nextCookie++,
  });
  const events: { [E in keyof ChatRoomEvents]: ChatRoomEvents[E][] } = { join: [], leave: [], message: [], rate: [], closed: [] };
  chat.on('join', (e) => events.join.push(e));
  chat.on('leave', (e) => events.leave.push(e));
  chat.on('message', (e) => events.message.push(e));
  chat.on('rate', (e) => events.rate.push(e));
  chat.on('closed', (e) => events.closed.push(e));
  const started = chat.start();
  await flush();
  link.deliver({ family: FAMILY_CHAT, subtype: CHAT_USERS_JOINED, body: roster(...occupants) });
  const names = await started;
  const sends = () => link.sentOf(FAMILY_CHAT, CHAT_MSG_TO_HOST);
  const reflect = (cookie: bigint, text = 'x') =>
    link.deliver({ family: FAMILY_CHAT, subtype: CHAT_MSG_TO_CLIENT, body: relay({ from: 'Bot One', text, cookie }) });
  return { link, clock, pacer, chat, events, names, sends, reflect };
}

describe('room codecs', () => {
  it('encodes a public send with TLVs 0x01, 0x06 and 0x05', () => {
    expect(toHex(encodeRoomSend({ cookie: 0x0102030405060708n, text: 'hi &#233;' }))).toBe(vectorHex('roomSendPublic'));
  });

  it('encodes a whisper with TLV 0x02 and no TLV 0x01', () => {
    expect(toHex(encodeRoomSend({ cookie: 0x0102030405060708n, text: '#oc took k', whisperTo: 'bottwo' }))).toBe(vectorHex('roomSendWhisper'));
  });

  it('subscribes to rate classes 1 to 5', () => {
    expect(toHex(encodeClassIds([1, 2, 3, 4, 5]))).toBe(vectorHex('rateSubAdd'));
  });

  it('decodes a public relay', () => {
    const msg = decodeRoomMessage(vector('roomRelayPublic'));
    expect(msg).toMatchObject({ cookie: 0x1112131415161718n, isPublic: true, encoding: 'us-ascii' });
    expect(msg?.sender.name).toBe('Alice');
    expect(Buffer.from(msg?.text ?? []).toString()).toBe('<B>hello</B> room');
  });

  it('marks a relay without TLV 0x01 as not public', () => {
    expect(decodeRoomMessage(vector('roomRelayWhisper'))?.isPublic).toBe(false);
  });

  it('decodes a relay from a TOC occupant: cookie 0 and no encoding', () => {
    const msg = decodeRoomMessage(vector('roomRelayToc'));
    expect(msg?.cookie).toBe(0n);
    expect(msg?.encoding).toBeUndefined();
  });

  it.each([
    ['a short body', new Uint8Array(4)],
    ['no sender', Buffer.concat([Buffer.alloc(10), Buffer.from(encodeTlvs([{ tag: 0x05, value: encodeTlvs([{ tag: 0x01, value: Buffer.from('x') }]) }]))])],
    ['no text', Buffer.concat([Buffer.alloc(10), Buffer.from(encodeTlvs([{ tag: 0x03, value: encodeUserInfo({ name: 'a', warning: 0, tlvs: [] }) }, { tag: 0x05, value: new Uint8Array(0) }]))])],
  ])('returns null for %s', (_label, body) => {
    expect(decodeRoomMessage(body)).toBeNull();
  });

  it('names the two room food groups when it goes online', () => {
    expect(toHex(encodeRoomClientOnline())).toBe('0001000101100629000e000101100629');
  });

  it('decodes a roster of user info blocks', () => {
    expect(decodeRoster(vector('usersJoined')).map((u) => u.name)).toEqual(['Alice', 'Bot One']);
  });

  it('never makes cookie 0', () => {
    for (let i = 0; i < 1000; i++) expect(newRoomCookie()).not.toBe(0n);
  });
});

describe('room sign-on', () => {
  it('queries rates, subscribes, then goes online, in that order', async () => {
    const { link, pacer, names } = await joined();
    expect(link.sent.slice(0, 3).map((s) => [s.family, s.subtype])).toEqual([
      [FAMILY_OSERVICE, OSERVICE_RATE_PARAMS_QUERY],
      [FAMILY_OSERVICE, OSERVICE_RATE_PARAMS_SUB_ADD],
      [FAMILY_OSERVICE, OSERVICE_CLIENT_ONLINE],
    ]);
    expect(toHex(link.sent[1]!.body)).toBe(vectorHex('rateSubAdd'));
    expect(pacer.seeded).not.toBeNull();
    expect(names).toEqual(['botone', 'alice', 'bottwo']);
  });

  it('waits for the roster that lists itself', async () => {
    const link = new FakeLink();
    const clock = new ManualClock();
    link.onRequest = () => ({ family: FAMILY_OSERVICE, subtype: OSERVICE_RATE_PARAMS_REPLY });
    const chat = new ChatRoom({ room, link, self: 'botone', pacer: new StubPacer(), log: quietLog, now: clock.now, timers: clock.timers });
    const joins: string[] = [];
    chat.on('join', (e) => joins.push(e.name));
    let done = false;
    const started = chat.start().then((names) => {
      done = true;
      return names;
    });
    await flush();
    link.deliver({ family: FAMILY_CHAT, subtype: CHAT_USERS_JOINED, body: roster('mallory') });
    await flush();
    expect(done).toBe(false);
    link.deliver({ family: FAMILY_CHAT, subtype: CHAT_USERS_JOINED, body: roster('alice', 'mallory', 'botone') });
    expect(await started).toEqual(['mallory', 'alice', 'botone']);
    expect(joins).toEqual([]);
  });

  it('refuses a send before the roster arrives', async () => {
    const link = new FakeLink();
    const clock = new ManualClock();
    link.onRequest = () => ({ family: FAMILY_OSERVICE, subtype: OSERVICE_RATE_PARAMS_REPLY });
    const chat = new ChatRoom({ room, link, self: 'botone', pacer: new StubPacer(), log: quietLog, now: clock.now, timers: clock.timers });
    const started = chat.start();
    const failed = expect(started).rejects.toMatchObject({ code: 'unavailable' });
    await flush();
    await expect(chat.send('too early')).rejects.toMatchObject({ code: 'room-not-joined' });
    expect(link.sentOf(FAMILY_CHAT, CHAT_MSG_TO_HOST)).toHaveLength(0);
    chat.close();
    await failed;
  });

  it('fails when the socket closes before the roster', async () => {
    const link = new FakeLink();
    const clock = new ManualClock();
    link.onRequest = () => 'drop';
    const chat = new ChatRoom({ room, link, self: 'botone', pacer: new StubPacer(), log: quietLog, now: clock.now, timers: clock.timers });
    await expect(chat.start()).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('fails when no roster arrives in 15 s', async () => {
    const link = new FakeLink();
    const clock = new ManualClock();
    link.onRequest = () => ({ family: FAMILY_OSERVICE, subtype: OSERVICE_RATE_PARAMS_REPLY });
    const chat = new ChatRoom({ room, link, self: 'botone', pacer: new StubPacer(), log: quietLog, now: clock.now, timers: clock.timers });
    const started = chat.start();
    const failed = expect(started).rejects.toMatchObject({ code: 'unavailable' });
    await flush();
    await clock.advance(15_000);
    await failed;
    expect(link.closed).toBe(true);
  });
});

describe('room roster', () => {
  it('reports joins and leaves after ready, never for itself, never twice', async () => {
    const { link, events, chat } = await joined();
    link.deliver({ family: FAMILY_CHAT, subtype: CHAT_USERS_JOINED, body: roster('Bob') });
    link.deliver({ family: FAMILY_CHAT, subtype: CHAT_USERS_JOINED, body: roster('Bob', 'Bot One') });
    link.deliver({ family: FAMILY_CHAT, subtype: CHAT_USERS_LEFT, body: roster('alice') });
    link.deliver({ family: FAMILY_CHAT, subtype: CHAT_USERS_LEFT, body: roster('alice') });
    expect(events.join).toEqual([{ name: 'bob', display: 'Bob' }]);
    expect(events.leave).toEqual([{ name: 'alice', display: 'alice' }]);
    expect(chat.occupants()).toEqual(['botone', 'bottwo', 'bob']);
  });
});

describe('room receive', () => {
  it('delivers a public line as decoded plain text', async () => {
    const { link, events } = await joined();
    link.deliver({ family: FAMILY_CHAT, subtype: CHAT_MSG_TO_CLIENT, body: vector('roomRelayPublic') });
    expect(events.message).toEqual([
      { from: 'alice', fromDisplay: 'Alice', text: 'hello room', cookie: 0x1112131415161718n, whisper: false, serverGenerated: false },
    ]);
  });

  it('flags a line without TLV 0x01 as a whisper', async () => {
    const { link, events } = await joined();
    link.deliver({ family: FAMILY_CHAT, subtype: CHAT_MSG_TO_CLIENT, body: vector('roomRelayWhisper') });
    expect(events.message[0]).toMatchObject({ text: 'psst', whisper: true });
  });

  it('delivers every cookie-0 line from a TOC occupant and decodes UTF-8 with no encoding TLV', async () => {
    const { link, events } = await joined();
    link.deliver({ family: FAMILY_CHAT, subtype: CHAT_MSG_TO_CLIENT, body: vector('roomRelayToc') });
    link.deliver({ family: FAMILY_CHAT, subtype: CHAT_MSG_TO_CLIENT, body: vector('roomRelayToc') });
    expect(events.message.map((m) => [m.text, m.cookie])).toEqual([['café', 0n], ['café', 0n]]);
  });

  it('falls back to Latin-1 when bytes with no encoding are not UTF-8', async () => {
    const { link, events } = await joined();
    link.deliver({ family: FAMILY_CHAT, subtype: CHAT_MSG_TO_CLIENT, body: relay({ from: 'alice', text: Uint8Array.from([0x63, 0x61, 0x66, 0xe9]), encoding: null }) });
    expect(events.message[0]?.text).toBe('café');
  });

  it('surfaces an OnlineHost line, marked as one the server wrote', async () => {
    const { link, events } = await joined();
    link.deliver({ family: FAMILY_CHAT, subtype: CHAT_MSG_TO_CLIENT, body: relay({ from: 'OnlineHost', text: 'alice rolled 2 6-sided dice: 3 4' }) });
    expect(events.message).toEqual([
      {
        from: 'onlinehost',
        fromDisplay: 'OnlineHost',
        text: 'alice rolled 2 6-sided dice: 3 4',
        cookie: 0x55n,
        whisper: false,
        serverGenerated: true,
      },
    ]);
  });

  it('takes its own receipt from a line the server rewrote into an OnlineHost line', async () => {
    const { chat, link, events, sends } = await joined();
    const receipt = chat.send('//roll');
    await flush();
    expect(sends()).toHaveLength(1);
    link.deliver({
      family: FAMILY_CHAT,
      subtype: CHAT_MSG_TO_CLIENT,
      body: relay({ from: 'OnlineHost', text: 'Bot One rolled 2 6-sided dice: 3 4', cookie: 0x1000n }),
    });
    await expect(receipt).resolves.toEqual({ id: '1000', storedOffline: false });
    // the line went out once, and nothing read the missing receipt as a rate limit
    expect(sends()).toHaveLength(1);
    expect(events.rate).toEqual([]);
    expect(events.message.map((m) => [m.from, m.serverGenerated])).toEqual([['onlinehost', true]]);
  });

  it('never surfaces its own lines', async () => {
    const { link, events } = await joined();
    link.deliver({ family: FAMILY_CHAT, subtype: CHAT_MSG_TO_CLIENT, body: relay({ from: 'bot one', text: 'echo', cookie: 0x99n }) });
    expect(events.message).toEqual([]);
  });

  it('drops a relay that does not parse', async () => {
    const { link, events } = await joined();
    link.deliver({ family: FAMILY_CHAT, subtype: CHAT_MSG_TO_CLIENT, body: new Uint8Array(3) });
    expect(events.message).toEqual([]);
  });
});

describe('room send', () => {
  it('sets TLVs 0x01 and 0x06, a non-zero cookie, and resolves on its own reflection', async () => {
    const { chat, sends, reflect } = await joined();
    const receipt = chat.send('hello');
    const body = sends()[0]!.body;
    const tlvs = decodeTlvs(body.subarray(10));
    expect(findTlv(tlvs, 0x01)).toBeDefined();
    expect(findTlv(tlvs, 0x06)).toBeDefined();
    expect(Buffer.from(body).readBigUInt64BE(0)).toBe(0x1000n);
    reflect(0x1000n);
    await expect(receipt).resolves.toEqual({ id: '1000', storedOffline: false });
  });

  it('sends the HTML it is given byte for byte, a leading space included', async () => {
    const { chat, sends, reflect } = await joined();
    const receipt = chat.send(' //roll &amp; <B> more</B> ');
    const inner = decodeTlvs(findTlv(decodeTlvs(sends()[0]!.body.subarray(10)), 0x05) ?? new Uint8Array(0));
    expect(Buffer.from(findTlv(inner, 0x01) ?? new Uint8Array(0)).toString('latin1')).toBe(' //roll &amp; <B> more</B> ');
    reflect(0x1000n);
    await receipt;
  });

  it('does not take a peer line with the same cookie as its receipt', async () => {
    const { chat, link, events, reflect } = await joined();
    let settled = false;
    const receipt = chat.send('hello').then((r) => {
      settled = true;
      return r;
    });
    link.deliver({ family: FAMILY_CHAT, subtype: CHAT_MSG_TO_CLIENT, body: relay({ from: 'alice', text: 'same cookie', cookie: 0x1000n }) });
    await flush();
    expect(settled).toBe(false);
    expect(events.message.map((m) => m.text)).toEqual(['same cookie']);
    reflect(0x1000n);
    await receipt;
  });

  it('sends non-ASCII as numeric entities in us-ascii', async () => {
    const { chat, sends } = await joined();
    void chat.send('café \u{1F600}').catch(() => undefined);
    const inner = decodeTlvs(findTlv(decodeTlvs(sends()[0]!.body.subarray(10)), 0x05) ?? new Uint8Array(0));
    expect(Buffer.from(findTlv(inner, 0x01) ?? []).toString('ascii')).toBe('caf&#233; &#128512;');
    expect(Buffer.from(findTlv(inner, 0x02) ?? []).toString('ascii')).toBe('us-ascii');
  });

  it('always nests a text TLV in TLV 0x05, even for an empty line', async () => {
    const { chat, sends } = await joined();
    void chat.send('').catch(() => undefined);
    const info = findTlv(decodeTlvs(sends()[0]!.body.subarray(10)), 0x05);
    expect(info).toBeDefined();
    expect(findTlv(decodeTlvs(info ?? new Uint8Array(0)), 0x01)).toEqual(Buffer.alloc(0));
  });

  it('rejects text over 1024 bytes after entity encoding, without sending', async () => {
    const { chat, sends } = await joined();
    await expect(chat.send('é'.repeat(171))).rejects.toMatchObject({ code: 'too-long' });
    expect(sends()).toHaveLength(0);
  });

  it('whispers with TLV 0x02 and no TLV 0x01, and takes the reflection as receipt', async () => {
    const { chat, sends, reflect } = await joined();
    const receipt = chat.send('#oc took k', { whisperTo: 'Bot Two', priority: 'control' });
    const tlvs = decodeTlvs(sends()[0]!.body.subarray(10));
    expect(findTlv(tlvs, 0x01)).toBeUndefined();
    expect(Buffer.from(findTlv(tlvs, 0x02) ?? []).toString()).toBe('Bot Two');
    reflect(0x1000n);
    await expect(receipt).resolves.toMatchObject({ id: '1000' });
  });

  it('refuses a whisper to someone who is not in the room', async () => {
    const { chat, sends } = await joined();
    await expect(chat.send('hi', { whisperTo: 'mallory' })).rejects.toMatchObject({ code: 'recipient-unavailable' });
    expect(sends()).toHaveLength(0);
  });

  it('sends one line at a time, replies before control lines before notices', async () => {
    const { chat, sends, reflect } = await joined();
    const texts = () => sends().map((s) => Buffer.from(findTlv(decodeTlvs(findTlv(decodeTlvs(s.body.subarray(10)), 0x05) ?? new Uint8Array(0)), 0x01) ?? []).toString());
    void chat.send('first');
    void chat.send('a notice', { priority: 'notice' });
    void chat.send('a control line', { priority: 'control' });
    void chat.send('a reply');
    expect(texts()).toEqual(['first']);
    reflect(0x1000n);
    reflect(0x1003n);
    reflect(0x1002n);
    reflect(0x1001n);
    await flush();
    expect(texts()).toEqual(['first', 'a reply', 'a control line', 'a notice']);
  });

  it('waits as long as the pacer says', async () => {
    const { chat, sends, pacer, clock } = await joined();
    pacer.wait = 2000;
    void chat.send('paced').catch(() => undefined);
    expect(sends()).toHaveLength(0);
    pacer.wait = 0;
    await clock.advance(1999);
    expect(sends()).toHaveLength(0);
    await clock.advance(1);
    expect(sends()).toHaveLength(1);
    expect(pacer.sentCount).toBe(1);
  });

  it('caps the queue at 50 waiting lines', async () => {
    const { chat } = await joined();
    for (let i = 0; i < 51; i++) void chat.send(`line ${i}`).catch(() => undefined);
    await expect(chat.send('one too many')).rejects.toMatchObject({ code: 'rate-limited' });
  });
});

describe('room rate limits', () => {
  it('stays silent for 120 s after a limited notice', async () => {
    const { chat, link, sends, pacer, clock, events } = await joined();
    pacer.nextNotice = 'limited';
    link.deliver({ family: FAMILY_OSERVICE, subtype: OSERVICE_RATE_PARAM_CHANGE, body: new Uint8Array(0) });
    void chat.send('held').catch(() => undefined);
    await clock.advance(119_999);
    expect(sends()).toHaveLength(0);
    await clock.advance(1);
    expect(sends()).toHaveLength(1);
    expect(events.rate).toEqual(['limited']);
  });

  it('sends again as soon as a clear notice arrives', async () => {
    const { chat, link, sends, pacer, clock, events } = await joined();
    pacer.nextNotice = 'limited';
    link.deliver({ family: FAMILY_OSERVICE, subtype: OSERVICE_RATE_PARAM_CHANGE });
    void chat.send('held').catch(() => undefined);
    await clock.advance(30_000);
    pacer.nextNotice = 'clear';
    link.deliver({ family: FAMILY_OSERVICE, subtype: OSERVICE_RATE_PARAM_CHANGE });
    expect(sends()).toHaveLength(1);
    expect(events.rate).toEqual(['limited', 'clear']);
  });

  it('ignores a notice the pacer says is about another class', async () => {
    const { link, events } = await joined();
    link.deliver({ family: FAMILY_OSERVICE, subtype: OSERVICE_RATE_PARAM_CHANGE });
    expect(events.rate).toEqual([]);
  });

  it('treats a missing reflection as a rate drop: quiet for 120 s, one retry with the same cookie, then fails', async () => {
    const { chat, sends, pacer, clock, events } = await joined();
    const receipt = chat.send('lost');
    const failed = expect(receipt).rejects.toMatchObject({ code: 'rate-limited' });
    await clock.advance(10_000);
    expect(pacer.droppedCount).toBe(1);
    expect(events.rate).toEqual(['limited']);
    await clock.advance(119_999);
    expect(sends()).toHaveLength(1);
    await clock.advance(1);
    expect(sends()).toHaveLength(2);
    expect(toHex(sends()[1]!.body)).toBe(toHex(sends()[0]!.body));
    await clock.advance(10_000);
    await failed;
    expect(sends()).toHaveLength(2);
  });

  it('takes a reflection that lands after the timeout as the receipt and does not say the line twice', async () => {
    const { chat, clock, sends, reflect } = await joined();
    const receipt = chat.send('slow');
    await clock.advance(10_000);
    reflect(0x1000n);
    await expect(receipt).resolves.toMatchObject({ id: '1000' });
    await clock.advance(120_000);
    expect(sends()).toHaveLength(1);
  });

  it('accepts a late reflection for the retried line', async () => {
    const { chat, clock, reflect } = await joined();
    const receipt = chat.send('slow');
    await clock.advance(10_000);
    await clock.advance(120_000);
    reflect(0x1000n);
    await expect(receipt).resolves.toMatchObject({ id: '1000' });
  });
});

describe('room close', () => {
  it('fails the line in flight and every queued line with closed', async () => {
    const { chat, link, events } = await joined();
    const a = chat.send('in flight');
    const b = chat.send('queued');
    const checks = [expect(a).rejects.toMatchObject({ code: 'closed' }), expect(b).rejects.toMatchObject({ code: 'closed' })];
    link.drop();
    await Promise.all(checks);
    expect(events.closed).toEqual([{ clean: false }]);
    await expect(chat.send('after')).rejects.toMatchObject({ code: 'closed' });
  });

  it('closes the socket once', async () => {
    const { chat, link, events } = await joined();
    chat.close();
    chat.close();
    expect(link.closed).toBe(true);
    expect(events.closed).toEqual([{ clean: true }]);
  });
});
