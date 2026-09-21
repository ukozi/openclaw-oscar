import { describe, expect, it } from 'vitest';
import { createRoomPacer } from '../../../src/oscar/rate.js';
import { fakeRateChange, fakeRateParamsReply } from '../../fake/oscar-rooms.js';

describe('room pacer', () => {
  it('lets a fresh room send at once', () => {
    const pacer = createRoomPacer(() => 0);
    pacer.seed(fakeRateParamsReply());
    expect(pacer.waitMs()).toBe(0);
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
});
