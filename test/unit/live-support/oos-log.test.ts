import { describe, expect, it } from 'vitest';
import { freePorts, imRecipient, mentions, parseRequestLine } from '../../live/support/oos.js';

const sent = 'time=2026-09-20T23:29:14.089-04:00 level=TRACE msg="client request" svc=OSCAR request.food_group=ICBM request.sub_group=ICBMChannelMsgToHost request.snac_frame="{FoodGroup:4 SubGroup:6 Flags:0 RequestID:5}" request.snac_payload="{Cookie:12181822210123701755 ChannelID:1 ScreenName:Mal Lory TLVRestBlock:{TLVList:[{Tag:2 Value:[5 1 0 3 1 1 2 1 1 0 9 0 0 0 0 114 101 112 108 121]}]}}" screenName=botone ip=127.0.0.1:65240';
const answered = 'time=2026-09-20T23:27:56.190-04:00 level=TRACE msg="client request -> server response" svc=OSCAR request.food_group=Locate request.sub_group=LocateUserInfoQuery request.snac_frame="{FoodGroup:2 SubGroup:5 Flags:0 RequestID:4}" request.snac_payload="{Type:2 ScreenName:alice}" response.food_group=Locate response.sub_group=LocateUserInfoReply response.snac_frame="{FoodGroup:2 SubGroup:6 Flags:0 RequestID:4}" response.snac_payload="{TLVUserInfo:{ScreenName:alice WarningLevel:0 TLVBlock:{TLVList:[{Tag:1 Value:[0 17]}]}} LocateInfo:{TLVList:[]}}" screenName=alice ip=127.0.0.1:65116';
// a BOS connection logs what it forwards to the client without a screenName attribute
const forwarded = 'time=2026-09-20T23:29:13.986-04:00 level=TRACE msg="client request" svc=OSCAR request.food_group=ICBM request.sub_group=ICBMChannelMsgToClient request.snac_frame="{FoodGroup:4 SubGroup:7 Flags:0 RequestID:2147483648}" request.snac_payload="{Cookie:3824965288633437877 ChannelID:1 TLVUserInfo:{ScreenName:mallory WarningLevel:0 TLVBlock:{TLVList:[{Tag:1 Value:[0 17]}]}} TLVRestBlock:{TLVList:[{Tag:2 Value:[5 1 0 3 1 1 2 1 1 0 8 0 0 0 0 112 115 115 116]}]}}" ip=127.0.0.1:65240';
const forwardedWithName = forwarded.replace(' ip=', ' screenName=botone ip=');
const typing = 'time=2026-09-20T22:00:00.000Z level=TRACE msg="client request" svc=OSCAR request.food_group=ICBM request.sub_group=ICBMClientEvent request.snac_frame="{FoodGroup:4 SubGroup:20 Flags:0 RequestID:9}" request.snac_payload="{Cookie:0 ChannelID:1 ScreenName:alice Event:2}" screenName="bot one" ip=127.0.0.1:53412';
const bytesOnly = 'time=2026-09-20T22:00:00.000Z level=TRACE msg="client request" svc=OSCAR request.snac_frame="{FoodGroup:3 SubGroup:4 Flags:0 RequestID:9}" request.snac_payload="{TLVList:[{Tag:1 Value:[109 97 108 108 111 114 121]}]}" screenName=botone';
const bytesAsTyped = bytesOnly.replace('109 97 108 108 111 114 121', '77 97 108 32 76 111 114 121');

describe('server log reader', () => {
  it('reads a client request with its sender and SNAC numbers', () => {
    expect(parseRequestLine(sent)).toEqual({ screenName: 'botone', family: 4, subtype: 6, line: sent });
  });

  it('reads a request the server answered', () => {
    expect(parseRequestLine(answered)).toMatchObject({ screenName: 'alice', family: 2, subtype: 5 });
  });

  it('ignores SNACs the server forwarded to the client', () => {
    expect(parseRequestLine(forwarded)).toBeNull();
    expect(parseRequestLine(forwardedWithName)).toBeNull();
  });

  it('reads who an IM was addressed to', () => {
    expect(imRecipient(sent)).toBe('mallory');
    expect(imRecipient(answered)).toBeNull();
    expect(imRecipient(forwarded)).toBeNull();
  });

  it('normalises a quoted screen name', () => {
    expect(parseRequestLine(typing)?.screenName).toBe('botone');
  });

  it('ignores lines that are not client requests', () => {
    expect(parseRequestLine('time=x level=INFO msg="user signed on" screenName=botone')).toBeNull();
  });

  it('finds a name written with spaces, in capitals, or as decimal bytes', () => {
    expect(mentions(sent, 'mallory')).toBe(true);
    expect(mentions(bytesOnly, 'mallory')).toBe(true);
    expect(mentions(bytesAsTyped, 'mallory')).toBe(true);
    expect(mentions(bytesOnly.replace('[109 ', '[1109 '), 'mallory')).toBe(false);
    expect(mentions(typing, 'mallory')).toBe(false);
  });

  it('hands out distinct free ports', async () => {
    const ports = await freePorts(4);
    expect(new Set(ports).size).toBe(4);
  });
});
