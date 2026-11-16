import { describe, expect, it } from 'vitest';
import { parseAimHtml } from 'open-oscar-client-kit/client';
import { htmlToText } from 'open-oscar-client-kit/wire';
import type { DirectMessage, FileOfferNotice, IncomingIm, Invite, RoomMessage, TransferStatus } from 'open-oscar-client-kit/model';
import {
  toDirectImOfferEvent,
  toDirectMessageEvent,
  toFileOfferEvent,
  toImEvent,
  toInviteEvent,
  toRoomMessageEvent,
  toTransferEvent,
} from '../../../src/oscar/events.js';

const LINK = '<A HREF="https://example.com">x</A> &amp; <B>y</B>';

function im(over: { html?: string; cookie?: string } & Partial<Omit<IncomingIm, 'wire'>> = {}): IncomingIm {
  const { html = 'hello', cookie = '0123456789abcdef', ...rest } = over;
  return {
    from: 'Alice Smith',
    body: [{ text: 'not this' }],
    autoResponse: false,
    at: 1_000,
    offline: false,
    serverNotice: false,
    wire: { cookie, html },
    ...rest,
  };
}

function line(over: Partial<RoomMessage> = {}): RoomMessage {
  return {
    roomId: 'r1',
    from: 'Alice Smith',
    body: [{ text: 'not this' }],
    at: 2_000,
    whisper: false,
    fromServer: false,
    wire: { cookie: '00000000000000ff', html: LINK },
    ...over,
  };
}

describe('toImEvent', () => {
  it("builds the text from the wire HTML by the plugin's rule, links included", () => {
    expect(toImEvent(im({ html: LINK })).text).toBe(htmlToText(LINK));
  });

  it('normalises the sender and keeps the name as it came', () => {
    const e = toImEvent(im());
    expect(e.from).toBe('alicesmith');
    expect(e.fromDisplay).toBe('Alice Smith');
  });

  it('reads the cookie back as a bigint', () => {
    expect(toImEvent(im({ cookie: '00000000000000ff' })).cookie).toBe(255n);
    expect(toImEvent(im({ cookie: 'ffffffffffffffff' })).cookie).toBe(0xffffffffffffffffn);
  });

  it('marks a notice from the system sender with cookie 0 as system', () => {
    expect(toImEvent(im({ from: 'OOSSystemMsg', serverNotice: true, cookie: '0000000000000000' })).system).toBe(true);
  });

  it('does not mark it when the cookie is not 0', () => {
    expect(toImEvent(im({ from: 'oossystemmsg', serverNotice: true, cookie: '0000000000000001' })).system).toBe(false);
  });

  it('does not mark the system sender when the kit did not call it a notice', () => {
    // a user-info block or a send time: an account that took the name
    expect(toImEvent(im({ from: 'oossystemmsg', serverNotice: false, cookie: '0000000000000000' })).system).toBe(false);
  });

  it('does not mark an IM from another name the kit calls a notice', () => {
    expect(toImEvent(im({ from: 'Alice Smith', serverNotice: true, cookie: '0000000000000000' })).system).toBe(false);
  });

  it('sets sentAt only on an offline message', () => {
    const live = toImEvent(im({ at: 5_000 }));
    expect(live.offline).toBe(false);
    expect('sentAt' in live).toBe(false);
    const stored = toImEvent(im({ at: 7_000, offline: true }));
    expect(stored.offline).toBe(true);
    expect(stored.sentAt).toBe(7_000);
  });

  it('carries the auto-response flag', () => {
    expect(toImEvent(im({ autoResponse: true })).autoResponse).toBe(true);
    expect(toImEvent(im()).autoResponse).toBe(false);
  });

  it('throws on an IM with no wire detail', () => {
    const { wire: _wire, ...bare } = im();
    expect(() => toImEvent(bare)).toThrow();
  });
});

describe('toRoomMessageEvent', () => {
  const room = { exchange: 4 as const, name: 'lobby' };

  it('maps a room line, a whisper and a line the server wrote', () => {
    expect(toRoomMessageEvent(room, line())).toEqual({
      room,
      from: 'alicesmith',
      fromDisplay: 'Alice Smith',
      text: htmlToText(LINK),
      cookie: 255n,
      whisper: false,
      serverGenerated: false,
    });
    expect(toRoomMessageEvent(room, line({ whisper: true })).whisper).toBe(true);
    const server = toRoomMessageEvent(room, line({ from: 'OnlineHost', fromServer: true }));
    expect(server.serverGenerated).toBe(true);
    expect(server.from).toBe('onlinehost');
  });

  it('throws on a line with no wire detail', () => {
    const { wire: _wire, ...bare } = line();
    expect(() => toRoomMessageEvent(room, bare)).toThrow();
  });
});

describe('toInviteEvent', () => {
  const invite = (over: Partial<Invite> = {}): Invite => ({
    id: 'alicesmith:00000000000000ff',
    from: 'Alice Smith',
    room: { exchange: 4, name: 'Late Night' },
    text: [{ text: 'not this' }],
    at: 3_000,
    wire: { html: LINK },
    ...over,
  });

  it("lowercases the invited room's name and carries the invite id", () => {
    expect(toInviteEvent(invite())).toEqual({
      from: 'alicesmith',
      fromDisplay: 'Alice Smith',
      room: { exchange: 4, name: 'late night' },
      roomCookie: 'alicesmith:00000000000000ff',
      text: htmlToText(LINK),
    });
  });

  it('throws on an invite with no wire detail', () => {
    const { wire: _wire, ...bare } = invite();
    expect(() => toInviteEvent(bare)).toThrow();
  });
});

describe('Direct IM events', () => {
  const message = (over: Partial<DirectMessage> = {}): DirectMessage => ({
    id: 'alicesmith:00000000000000aa',
    from: 'Alice Smith',
    at: 3_000,
    autoResponse: false,
    parts: [],
    attachments: [],
    unreferenced: 0,
    damaged: false,
    ...over,
  });

  it('normalises the sender of an offer and keeps the name as it came', () => {
    expect(toDirectImOfferEvent({ id: 'alicesmith:00000000000000aa', from: 'Alice Smith', at: 3_000 })).toEqual({
      id: 'alicesmith:00000000000000aa',
      from: 'alicesmith',
      fromDisplay: 'Alice Smith',
    });
  });

  it('joins the text parts of a Direct IM message and lists its pictures', () => {
    const cat = Uint8Array.of(1, 2, 3);
    const dog = Uint8Array.of(4, 5);
    const event = toDirectMessageEvent(
      message({
        parts: [
          { kind: 'text', body: [{ text: 'look at ' }, { text: 'this', bold: true }] },
          { kind: 'attachment', index: 0 },
          { kind: 'missing' },
          { kind: 'text', body: [{ text: ' and ' }, { text: 'x', link: 'https://example.com' }] },
          { kind: 'attachment', index: 1 },
        ],
        attachments: [
          { id: 1, name: 'cat.png', bytes: cat },
          { id: 2, name: 'dog.gif', bytes: dog },
        ],
      }),
    );
    expect(event).toEqual({
      id: 'alicesmith:00000000000000aa',
      from: 'alicesmith',
      fromDisplay: 'Alice Smith',
      text: 'look at this and x (https://example.com)',
      autoResponse: false,
      damaged: false,
      pictures: [
        { name: 'cat.png', bytes: cat },
        { name: 'dog.gif', bytes: dog },
      ],
    });
  });

  it('writes a link once when its text is the address', () => {
    const body = [{ text: 'https://example.com', link: 'https://example.com' }];
    expect(toDirectMessageEvent(message({ parts: [{ kind: 'text', body }] })).text).toBe('https://example.com');
  });

  it('reads the text as an IM with the same HTML reads', () => {
    for (const html of [
      '<A HREF="https://x.example/a">click <B>here</B></A> now',
      '<A HREF="http://example.com/">example.com</A>',
      'see <A HREF="https://example.com/a"><I>this</I> and <FONT COLOR="#ff0000">that</FONT></A>, then <A HREF="https://example.com/b">b</A>',
      'a &lt; b<BR>c &amp; d',
    ]) {
      const event = toDirectMessageEvent(message({ parts: [{ kind: 'text', body: parseAimHtml(html) }] }));
      expect(event.text).toBe(htmlToText(html));
    }
  });

  it('writes the address of a link with formatted text once', () => {
    const body = parseAimHtml('<A HREF="https://x.example/a">click <B>here</B></A> now');
    expect(toDirectMessageEvent(message({ parts: [{ kind: 'text', body }] })).text).toBe('click here (https://x.example/a) now');
  });

  it('leaves the address out when the text of a link is its address without the scheme', () => {
    const body = [{ text: 'example.com', link: 'http://example.com/' }];
    expect(toDirectMessageEvent(message({ parts: [{ kind: 'text', body }] })).text).toBe('example.com');
  });

  it('keeps the auto-response and damaged marks', () => {
    expect(toDirectMessageEvent(message({ autoResponse: true, damaged: true }))).toMatchObject({ autoResponse: true, damaged: true, text: '', pictures: [] });
  });
});

describe('Send File events', () => {
  const offer = (over: Partial<FileOfferNotice> = {}): FileOfferNotice => ({
    id: 'alicesmith:00000000000000bb',
    from: 'Alice Smith',
    count: 1,
    totalBytes: 1_234,
    name: 'notes.md',
    folder: null,
    at: 3_000,
    ...over,
  });
  const status = (over: Partial<TransferStatus> = {}): TransferStatus => ({
    id: 'alicesmith:00000000000000bb',
    direction: 'in',
    peer: 'Alice Smith',
    state: 'transferring',
    count: 1,
    index: 0,
    name: 'notes.md',
    bytesDone: 512,
    bytesTotal: 1_234,
    ...over,
  });

  it('maps a file offer and marks a folder offer', () => {
    expect(toFileOfferEvent(offer())).toEqual({
      id: 'alicesmith:00000000000000bb',
      from: 'alicesmith',
      fromDisplay: 'Alice Smith',
      count: 1,
      totalBytes: 1_234,
      name: 'notes.md',
      folder: false,
    });
    expect(toFileOfferEvent(offer({ count: 2, name: 'docs\\*', folder: 'docs' }))).toMatchObject({ count: 2, name: 'docs\\*', folder: true });
    expect(toFileOfferEvent(offer({ folder: '' })).folder).toBe(true);
  });

  it('maps a transfer and keeps its failure and who ended it', () => {
    expect(toTransferEvent(status())).toEqual({ id: 'alicesmith:00000000000000bb', peer: 'alicesmith', direction: 'in', state: 'transferring', index: 0, bytesDone: 512 });
    expect(toTransferEvent(status({ direction: 'out' })).direction).toBe('out');
    expect(toTransferEvent(status({ state: 'failed', failure: 'file-problem' }))).toMatchObject({ state: 'failed', failure: 'file-problem' });
    expect(toTransferEvent(status({ state: 'cancelled', by: 'peer' }))).toMatchObject({ state: 'cancelled', by: 'peer' });
    expect('failure' in toTransferEvent(status({ state: 'done' }))).toBe(false);
  });
});
