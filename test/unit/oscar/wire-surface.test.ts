import { describe, expect, it } from 'vitest';
import * as constants from '../../../src/oscar/constants.js';
import { encodeServiceRequest } from '../../../src/oscar/bos.js';
import { openConnection } from '../../../src/oscar/connection.js';
import { RateGovernor, decodeRateParamChange, decodeRateParamsReply } from '../../../src/oscar/rate.js';
import { OscarSessionImpl } from '../../../src/oscar/session.js';
import { decodeUserInfo, encodeUserInfo } from '../../../src/oscar/snac.js';
import { fromWireText, guardRoll, isAscii, normalizeScreenName, toAsciiEntities } from '../../../src/oscar/text.js';
import { decodeTlvBlock, decodeTlvs, encodeTlvBlock, encodeTlvs, findTlv, type Tlv } from '../../../src/oscar/tlv.js';
import { OscarSendError, type ServiceGrant, type SnacLink } from '../../../src/oscar/types.js';

const USER_INFO_ALICE = '05416c6963650000000300030004886e09000001000200100006000400000000';

const asLink = (conn: Awaited<ReturnType<typeof openConnection>>): SnacLink => conn;
const asResolver = (session: OscarSessionImpl): ((family: number, roomInfo?: Uint8Array) => Promise<ServiceGrant>) =>
  (family, roomInfo) => session.resolveService(family, roomInfo);
const asInviteSource = (session: OscarSessionImpl): ((fn: (icbmBody: Uint8Array) => void) => () => void) =>
  (fn) => session.onChannel2(fn);

describe('the wire helpers rooms are built on', () => {
  it.each([
    ['FAMILY_OSERVICE', 0x0001],
    ['FAMILY_ICBM', 0x0004],
    ['OSERVICE_ERR', 0x0001],
    ['OSERVICE_CLIENT_ONLINE', 0x0002],
    ['OSERVICE_HOST_ONLINE', 0x0003],
    ['OSERVICE_RATE_PARAMS_QUERY', 0x0006],
    ['OSERVICE_RATE_PARAMS_REPLY', 0x0007],
    ['OSERVICE_RATE_PARAMS_SUB_ADD', 0x0008],
    ['OSERVICE_RATE_PARAM_CHANGE', 0x000a],
    ['ICBM_MSG_TO_CLIENT', 0x0007],
  ])('constant %s is %i', (name, value) => {
    expect((constants as Record<string, unknown>)[name]).toBe(value);
  });

  it('has the chat capability as 16 bytes', () => {
    expect(Buffer.from(constants.CAP_CHAT).toString('hex')).toBe('748f2420628711d18222444553540000');
  });

  it('round-trips a TLV rest block and a counted block', () => {
    const tlvs: Tlv[] = [{ tag: 0x00d3, value: Buffer.from('testroom') }, { tag: 0x0001, value: new Uint8Array(0) }];
    expect(decodeTlvs(encodeTlvs(tlvs)).map((t) => t.tag)).toEqual([0x00d3, 0x0001]);
    const block = encodeTlvBlock(tlvs);
    expect(Buffer.from(block).readUInt16BE(0)).toBe(2);
    const decoded = decodeTlvBlock(block, 0);
    expect(decoded.next).toBe(block.length);
    expect(Buffer.from(findTlv(decoded.tlvs, 0x00d3) ?? []).toString()).toBe('testroom');
    expect(findTlv(decoded.tlvs, 0x0099)).toBeUndefined();
  });

  it('throws on a TLV cut short instead of returning part of it', () => {
    expect(() => decodeTlvs(Uint8Array.from([0x00, 0x01, 0x00, 0x05, 0x41]))).toThrow();
  });

  it('reads and writes a user info block', () => {
    const bytes = Uint8Array.from(Buffer.from(USER_INFO_ALICE, 'hex'));
    const { info, next } = decodeUserInfo(bytes, 0);
    expect(info.name).toBe('Alice');
    expect(info.warning).toBe(0);
    expect(info.tlvs.map((t) => t.tag)).toEqual([0x0003, 0x0001, 0x0006]);
    expect(next).toBe(bytes.length);
    expect(Buffer.from(encodeUserInfo(info)).toString('hex')).toBe(USER_INFO_ALICE);
  });

  it('normalises names and converts text the way rooms need', () => {
    expect(normalizeScreenName('Bot One')).toBe('botone');
    expect(isAscii('plain')).toBe(true);
    expect(toAsciiEntities('café \u{1F600}')).toBe('caf&#233; &#128512;');
    expect(fromWireText(Buffer.from('café', 'utf8'), undefined)).toBe('café');
    expect(fromWireText(Uint8Array.from([0x63, 0x61, 0x66, 0xe9]), undefined)).toBe('café');
    expect(fromWireText(Buffer.from('<B>hi</B> &#233;<BR>x', 'ascii'), 'us-ascii')).toBe('hi é\nx');
    expect(fromWireText(Buffer.from('café', 'utf16le').swap16(), 'unicode-2-0')).toBe('café');
  });

  it('builds a send error from its code', () => {
    const err = new OscarSendError('closed');
    expect(err.code).toBe('closed');
    expect(err).toBeInstanceOf(Error);
  });

  it('has a governor with the five calls the room pacer makes', () => {
    const governor = new RateGovernor({ now: () => 0 });
    for (const method of ['seed', 'notice', 'waitMs', 'sent', 'dropped'] as const) expect(typeof governor[method]).toBe('function');
    expect(typeof decodeRateParamsReply).toBe('function');
    expect(typeof decodeRateParamChange).toBe('function');
  });

  it('has the two session hooks rooms are wired to, with the shapes rooms use', () => {
    expect(typeof OscarSessionImpl.prototype.resolveService).toBe('function');
    expect(typeof OscarSessionImpl.prototype.onChannel2).toBe('function');
    expect(typeof asResolver).toBe('function');
    expect(typeof asInviteSource).toBe('function');
  });

  it('builds the one service request body, room info and TLV 0x8C included', () => {
    const roomInfo = Uint8Array.from(Buffer.from('00040c342d302d74657374726f6f6d0000', 'hex'));
    expect(Buffer.from(encodeServiceRequest(0x000e, { useSsl: true, roomInfo })).toString('hex')).toBe(
      '000e0001001100040c342d302d74657374726f6f6d0000008c0000',
    );
    expect(Buffer.from(encodeServiceRequest(0x000d, { useSsl: false })).toString('hex')).toBe('000d');
  });

  it('guards a room line against the dice command with one leading space', () => {
    expect(guardRoll('//roll')).toBe(' //roll');
    expect(guardRoll('&#47;/roll')).toBe(' &#47;/roll');
    expect(guardRoll('<B>//roll</B>')).toBe('<B> //roll</B>');
    expect(guardRoll('hello')).toBe('hello');
  });

  it('opens connections through one function', () => {
    expect(typeof openConnection).toBe('function');
    expect(typeof asLink).toBe('function');
  });
});
