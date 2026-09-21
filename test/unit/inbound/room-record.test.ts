import { describe, expect, it, vi } from 'vitest';

vi.mock('openclaw/plugin-sdk/channel-inbound', () => ({ runChannelInboundEvent: vi.fn() }));

import type { HistoryEntry } from 'openclaw/plugin-sdk/reply-history';
import { ROOM_HISTORY_LIMIT, recordRoomLine } from '../../../src/inbound/room.js';
import type { InboundRunner, RoomLineRecord } from '../../../src/inbound/room.js';
import { channelInbound, createInboundKernel, sdk } from '../../fake/openclaw.js';
import { KEY } from '../rooms-fixtures.js';

function record(historyMap: Map<string, HistoryEntry[]>, n: number, text = `line ${n}`): RoomLineRecord {
  return {
    accountId: 'botone',
    historyKey: KEY,
    historyMap,
    messageId: `m${n}`,
    timestamp: 1000 + n,
    senderLabel: 'bob (approved)',
    text,
  };
}

describe('recordRoomLine', () => {
  it('records through a drop admission and never resolves a turn', async () => {
    const kernel = createInboundKernel();
    const history = new Map<string, HistoryEntry[]>();
    await recordRoomLine(record(history, 1), kernel.run as unknown as InboundRunner);
    expect(kernel.calls).toEqual([
      {
        channel: 'oscar',
        accountId: 'botone',
        messageId: 'm1',
        admission: 'drop',
        reason: 'room-record',
        recordHistory: true,
        historyKey: KEY,
        historyLimit: 50,
      },
    ]);
    expect(kernel.dispatched).toEqual([]);
    expect(history.get(KEY)).toEqual([{ sender: 'bob (approved)', body: 'line 1', timestamp: 1001, messageId: 'm1' }]);
  });

  it('keeps a window of 50', async () => {
    const kernel = createInboundKernel();
    const history = new Map<string, HistoryEntry[]>();
    for (let n = 0; n < 53; n += 1) await recordRoomLine(record(history, n), kernel.run as unknown as InboundRunner);
    const entries = history.get(KEY) ?? [];
    expect(ROOM_HISTORY_LIMIT).toBe(50);
    expect(entries).toHaveLength(50);
    expect(entries[0]?.body).toBe('line 3');
    expect(entries[49]?.body).toBe('line 52');
  });

  it('records nothing for an empty line', async () => {
    const kernel = createInboundKernel();
    const history = new Map<string, HistoryEntry[]>();
    await recordRoomLine(record(history, 1, '   '), kernel.run as unknown as InboundRunner);
    expect(history.get(KEY) ?? []).toEqual([]);
  });

  it('the shared fake runner honours the drop as well', async () => {
    sdk.reset();
    const history = new Map<string, HistoryEntry[]>();
    await recordRoomLine(record(history, 1), channelInbound.runChannelInboundEvent as unknown as InboundRunner);
    expect(history.get(KEY)).toHaveLength(1);
    expect(sdk.inbound).toEqual([]);
  });
});
