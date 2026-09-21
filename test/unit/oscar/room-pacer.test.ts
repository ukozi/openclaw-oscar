import { describe, expect, it } from 'vitest';
import { CHAT_MSG_TO_HOST, FAMILY_CHAT } from '../../../src/oscar/constants.js';
import { createRoomPacer } from '../../../src/oscar/rate.js';
import { fakeRateChange, fakeRateParamsReply } from '../../fake/oscar-rooms.js';

function replyMapping(classId: number, mapped: boolean): Uint8Array {
  const head = Buffer.alloc(32);
  head.writeUInt16BE(1, 0);
  head.writeUInt16BE(classId, 2);
  [80, 3000, 2000, 1500, 1000, 6000, 6000].forEach((level, i) => head.writeUInt32BE(level, 4 + i * 4));
  const groups = Buffer.alloc(mapped ? 8 : 4);
  groups.writeUInt16BE(classId, 0);
  groups.writeUInt16BE(mapped ? 1 : 0, 2);
  if (mapped) {
    groups.writeUInt16BE(FAMILY_CHAT, 4);
    groups.writeUInt16BE(CHAT_MSG_TO_HOST, 6);
  }
  return Buffer.concat([head, groups]);
}

describe('room pacer', () => {
  it('lets a fresh room send at once', () => {
    const pacer = createRoomPacer(() => 0);
    pacer.seed(fakeRateParamsReply());
    expect(pacer.waitMs()).toBe(0);
  });

  it('waits once the room has spent its allowance', () => {
    const pacer = createRoomPacer(() => 0);
    pacer.seed(fakeRateParamsReply());
    for (let i = 0; i < 100; i++) pacer.sent();
    expect(pacer.waitMs()).toBeGreaterThan(0);
  });

  it('reports limited and clear for the room send class', () => {
    const pacer = createRoomPacer(() => 0);
    pacer.seed(fakeRateParamsReply());
    expect(pacer.notice(fakeRateChange(3, 2))).toBe('limited');
    expect(pacer.notice(fakeRateChange(4, 2))).toBe('clear');
  });

  it('ignores a notice about another class', () => {
    const pacer = createRoomPacer(() => 0);
    pacer.seed(fakeRateParamsReply());
    expect(pacer.notice(fakeRateChange(3, 3))).toBeNull();
  });

  it('follows the class the reply maps the room send to', () => {
    const pacer = createRoomPacer(() => 0);
    pacer.seed(replyMapping(4, true));
    expect(pacer.notice(fakeRateChange(3, 4))).toBe('limited');
    expect(pacer.notice(fakeRateChange(3, 2))).toBeNull();
  });

  it('falls back to the room send class when the reply maps nothing', () => {
    const pacer = createRoomPacer(() => 0);
    pacer.seed(replyMapping(4, false));
    expect(pacer.notice(fakeRateChange(3, 2))).toBe('limited');
    expect(pacer.notice(fakeRateChange(3, 4))).toBeNull();
  });
});
