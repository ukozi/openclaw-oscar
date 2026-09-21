import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('openclaw/plugin-sdk/reply-chunking', async () => (await import('../fake/openclaw.js')).replyChunking);
vi.mock('openclaw/plugin-sdk/channel-reply-pipeline', async () => (await import('../fake/openclaw.js')).channelReplyPipeline);

import { toAsciiEntities, toWireHtml } from '../../src/oscar/text.js';
import { ROOM_WIRE_MAX, sendRoomHtml, sendRoomLine, splitWireHtml } from '../../src/outbound.js';
import { applyRoomReady, clearRuntime, setRuntime } from '../../src/runtime.js';
import { KEY, ROOM, fakeSession, makeRt } from './rooms-fixtures.js';

const LINK = '<A HREF="http://example.net/a/b/c">link</A>';

function balanced(chunk: string): boolean {
  const opens = chunk.match(/</g)?.length ?? 0;
  const closes = chunk.match(/>/g)?.length ?? 0;
  return opens === closes && !/&#?[A-Za-z0-9]*$/.test(chunk);
}

afterEach(() => {
  clearRuntime('botone');
});

describe('splitWireHtml', () => {
  it('returns one chunk for a short message and none for an empty one', () => {
    expect(splitWireHtml('hello <B>there</B>', 900)).toEqual(['hello <B>there</B>']);
    expect(splitWireHtml('   ', 900)).toEqual([]);
  });

  it('keeps every chunk within the limit', () => {
    const html = Array.from({ length: 400 }, (_, i) => `word${i}`).join(' ');
    const chunks = splitWireHtml(html, 100);
    expect(chunks.length).toBeGreaterThan(20);
    expect(chunks.every((chunk) => chunk.length <= 100)).toBe(true);
    expect(chunks.join(' ')).toBe(html);
  });

  it('never splits an entity or a tag', () => {
    const html = `${'&#233;'.repeat(40)}${LINK}${'&#128512;'.repeat(30)}`;
    const chunks = splitWireHtml(html, 64);
    expect(chunks.length).toBeGreaterThan(5);
    expect(chunks.every(balanced)).toBe(true);
    expect(chunks.join('')).toBe(html);
  });

  it('keeps a link in one piece, tags and text together', () => {
    for (let pad = 20; pad < 64; pad += 1) {
      const chunks = splitWireHtml(`${'x'.repeat(pad)}${LINK}${'y'.repeat(40)}`, 64);
      expect(chunks.filter((chunk) => chunk.includes(LINK))).toHaveLength(1);
      expect(chunks.every((chunk) => chunk.length <= 64)).toBe(true);
    }
  });

  it('cuts at the last break in reach and hard only when there is none', () => {
    const html = `${'a'.repeat(30)} ${'b'.repeat(20)}<BR>${'c'.repeat(40)}`;
    expect(splitWireHtml(html, 64)).toEqual([`${'a'.repeat(30)} ${'b'.repeat(20)}<BR>`, 'c'.repeat(40)]);
    expect(splitWireHtml('d'.repeat(100), 64)).toEqual(['d'.repeat(63), 'd'.repeat(37)]);
  });

  it('a chunk that would start with //roll gets a leading space', () => {
    expect(splitWireHtml(`${'x'.repeat(60)} //roll`, 64)).toEqual(['x'.repeat(60), ' //roll']);
    expect(splitWireHtml('//roll-dice4', 900)).toEqual([' //roll-dice4']);
    expect(splitWireHtml('<B>//roll</B>', 900)).toEqual(['<B> //roll</B>']);
    expect(splitWireHtml('&#47;/roll', 900)).toEqual([' &#47;/roll']);
    expect(splitWireHtml('see //roll', 900)).toEqual(['see //roll']);
  });

  it('keeps the space toWireHtml put in front of //roll, and adds it where a cut makes a new start', () => {
    expect(splitWireHtml(toWireHtml('//roll'), 900)).toEqual([' //roll']);
    expect(splitWireHtml(toWireHtml('**//roll**'), 900)).toEqual(['<B> //roll</B>']);
    const cut = splitWireHtml(toWireHtml(`${'y'.repeat(50)}\n//roll-sides8`), 64);
    expect(cut).toEqual([`${'y'.repeat(50)}<BR>`, ' //roll-sides8']);
    const afterTag = splitWireHtml(toWireHtml(`${'y'.repeat(60)}\n//roll-sides8`), 64);
    expect(afterTag).toEqual(['y'.repeat(60), '<BR> //roll-sides8']);
    expect([...cut, ...afterTag].every((chunk) => chunk.length <= 64)).toBe(true);
  });

  it('refuses a limit too small to be real', () => {
    expect(() => splitWireHtml('hello', 10)).toThrow(RangeError);
  });
});

describe('sendRoomHtml', () => {
  it('sends ASCII chunks in order as replies', async () => {
    const fake = fakeSession();
    setRuntime(makeRt(fake.session));
    const html = toWireHtml(`héllo ${'word '.repeat(400)}`);
    const receipts = await sendRoomHtml('botone', ROOM, html, 900);
    const sent = fake.calls.sendRoom;
    expect(receipts).toHaveLength(sent.length);
    expect(sent.length).toBeGreaterThan(2);
    expect(sent.map((call) => call.html)).toEqual(splitWireHtml(toAsciiEntities(html), 900));
    expect(sent.every((call) => call.html.length <= 900 && /^[\x20-\x7e\n]*$/.test(call.html))).toBe(true);
    expect(sent.every((call) => call.priority === 'reply' && call.room === ROOM)).toBe(true);
  });

  it('never chunks above the room limit the server advertises', async () => {
    const fake = fakeSession();
    setRuntime(makeRt(fake.session));
    await sendRoomHtml('botone', ROOM, 'word '.repeat(600), 2000);
    expect(fake.calls.sendRoom.length).toBeGreaterThan(2);
    expect(fake.calls.sendRoom.every((call) => call.html.length <= 1024)).toBe(true);
    expect(ROOM_WIRE_MAX).toBe(1024);
  });

  it('notes its own public line as the last bot line, and a whisper not at all', async () => {
    const fake = fakeSession();
    const rt = makeRt(fake.session);
    applyRoomReady(rt, ROOM, ['botone', 'alice'], 'botone', 1);
    setRuntime(rt);
    await sendRoomLine('botone', ROOM, '#oc took alice:1f', { whisperTo: 'alice', priority: 'control' });
    expect(rt.rooms.get(KEY)?.lastBotLine).toBeUndefined();
    const before = Date.now();
    await sendRoomHtml('botone', ROOM, 'hello', 900);
    expect(rt.rooms.get(KEY)?.lastBotLine?.from).toBe('botone');
    expect(rt.rooms.get(KEY)?.lastBotLine?.at).toBeGreaterThanOrEqual(before);
    const state = rt.rooms.get(KEY);
    if (state) delete state.lastBotLine;
    await sendRoomLine('botone', ROOM, 'on it');
    expect(rt.rooms.get(KEY)?.lastBotLine?.from).toBe('botone');
  });

  it('stops at the first failed chunk', async () => {
    const fake = fakeSession();
    const rt = makeRt(fake.session);
    let n = 0;
    rt.session.sendRoom = async () => {
      n += 1;
      if (n === 2) throw Object.assign(new Error('limited'), { code: 'rate-limited' });
      return { id: `r${n}`, storedOffline: false };
    };
    setRuntime(rt);
    await expect(sendRoomHtml('botone', ROOM, 'word '.repeat(400), 200)).rejects.toThrow('limited');
    expect(n).toBe(2);
  });

  it('rejects with not-online when the account is not running', async () => {
    await expect(sendRoomHtml('botone', ROOM, 'hi', 900)).rejects.toMatchObject({ code: 'not-online' });
    await expect(sendRoomLine('botone', ROOM, 'hi')).rejects.toMatchObject({ code: 'not-online' });
  });
});

describe('sendRoomLine', () => {
  it('converts markdown, keeps it ASCII and sends one message', async () => {
    const fake = fakeSession();
    setRuntime(makeRt(fake.session));
    await sendRoomLine('botone', ROOM, 'café **now**');
    expect(fake.calls.sendRoom).toEqual([
      { room: ROOM, html: toAsciiEntities(toWireHtml('café **now**')), whisperTo: undefined, priority: 'reply' },
    ]);
  });

  it('whispers with the given priority', async () => {
    const fake = fakeSession();
    setRuntime(makeRt(fake.session));
    await sendRoomLine('botone', ROOM, '#oc took alice:1f', { whisperTo: 'bottwo', priority: 'control' });
    expect(fake.calls.sendRoom[0]).toMatchObject({ whisperTo: 'bottwo', priority: 'control', html: '#oc took alice:1f' });
  });
});
