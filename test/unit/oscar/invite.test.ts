import { describe, expect, it } from 'vitest';
import { parseInvite } from '../../../src/oscar/bos.js';
import { vector } from './room-kit.js';

const FRAGMENT_AT = 46;

function tlv(tag: number, value: Uint8Array): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt16BE(tag, 0);
  head.writeUInt16BE(value.length, 2);
  return Buffer.concat([head, Buffer.from(value)]);
}

function withFragment(fragment: Uint8Array): Uint8Array {
  const head = Buffer.from(vector('inviteSnac').subarray(0, FRAGMENT_AT - 4));
  return Buffer.concat([head, tlv(0x0005, fragment)]);
}

function fragmentWith(inner: Buffer): Uint8Array {
  return Buffer.concat([Buffer.from(vector('inviteFragment').subarray(0, 26)), inner]);
}

const roomData = Buffer.from(vector('inviteFragment').subarray(vector('inviteFragment').length - 21));

describe('parseInvite', () => {
  it('reads the inviter, room and text from a channel 2 proposal', () => {
    expect(parseInvite(vector('inviteSnac'))).toEqual({
      from: 'alice',
      fromDisplay: 'Alice',
      room: { exchange: 4, name: 'testroom' },
      roomCookie: '4-0-testroom',
      text: 'Join me in this chat.',
    });
  });

  it('rebuilds the vector from its parts', () => {
    expect(Buffer.from(withFragment(vector('inviteFragment')))).toEqual(Buffer.from(vector('inviteSnac')));
  });

  it('skips inner TLVs it does not know', () => {
    const inner = Buffer.concat([tlv(0x7777, Buffer.from('junk')), tlv(0x000f, new Uint8Array(0)), roomData]);
    expect(parseInvite(withFragment(fragmentWith(inner)))).toMatchObject({ room: { exchange: 4, name: 'testroom' }, text: '' });
  });

  it('keeps what it found when the last inner TLV is cut off', () => {
    const inner = Buffer.concat([roomData, Buffer.from([0x00, 0x0c, 0x00, 0x40, 0x41])]);
    expect(parseInvite(withFragment(fragmentWith(inner)))).toMatchObject({ roomCookie: '4-0-testroom', text: '' });
  });

  it('keeps a room name that contains a dash', () => {
    const cookie = Buffer.from('4-0-ops-team');
    const data = tlv(0x2711, Buffer.concat([Buffer.from([0x00, 0x04, cookie.length]), cookie, Buffer.from([0x00, 0x00])]));
    expect(parseInvite(withFragment(fragmentWith(data)))).toMatchObject({ room: { exchange: 4, name: 'ops-team' }, roomCookie: '4-0-ops-team' });
  });

  it.each([
    ['a fragment under 26 bytes', withFragment(vector('inviteFragment').subarray(0, 25))],
    ['an empty fragment', withFragment(new Uint8Array(0))],
    ['a cancel', withFragment(Buffer.concat([Buffer.from([0x00, 0x01]), Buffer.from(vector('inviteFragment').subarray(2))]))],
    ['another capability', withFragment(Buffer.concat([Buffer.from(vector('inviteFragment').subarray(0, 10)), Buffer.alloc(16, 0x09), Buffer.from(vector('inviteFragment').subarray(26))]))],
    ['no room data', withFragment(fragmentWith(tlv(0x000c, Buffer.from('hi'))))],
    ['an exchange other than 4 or 5', withFragment(fragmentWith(tlv(0x2711, Buffer.concat([Buffer.from([0x00, 0x06, 0x05]), Buffer.from('6-0-x'), Buffer.from([0x00, 0x00])]))))],
    ['a cookie with no name', withFragment(fragmentWith(tlv(0x2711, Buffer.concat([Buffer.from([0x00, 0x04, 0x04]), Buffer.from('4-0-'), Buffer.from([0x00, 0x00])]))))],
    ['a channel 1 message', Buffer.concat([Buffer.from(vector('inviteSnac').subarray(0, 8)), Buffer.from([0x00, 0x01]), Buffer.from(vector('inviteSnac').subarray(10))])],
    ['a body cut inside the user info', vector('inviteSnac').subarray(0, 14)],
    ['no TLV 0x05', vector('inviteSnac').subarray(0, FRAGMENT_AT - 4)],
  ])('ignores %s', (_label, body) => {
    expect(parseInvite(body)).toBeNull();
  });
});
