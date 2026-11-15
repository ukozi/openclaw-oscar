import { describe, expect, it } from 'vitest';
import { htmlToText } from 'open-oscar-client-kit/wire';
import type { IncomingIm, Invite, RoomMessage } from 'open-oscar-client-kit/model';
import { toImEvent, toInviteEvent, toRoomMessageEvent } from '../../../src/oscar/events.js';

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
