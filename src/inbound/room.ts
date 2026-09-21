import { runChannelInboundEvent } from 'openclaw/plugin-sdk/channel-inbound';
import type { HistoryEntry } from 'openclaw/plugin-sdk/reply-history';

export const ROOM_HISTORY_LIMIT = 50;

export type InboundRunner = typeof runChannelInboundEvent;

export type RoomLineRecord = {
  accountId: string;
  historyKey: string;
  historyMap: Map<string, HistoryEntry[]>;
  messageId: string;
  timestamp: number;
  senderLabel: string;
  text: string;
};

export async function recordRoomLine(line: RoomLineRecord, run: InboundRunner = runChannelInboundEvent): Promise<void> {
  await run<RoomLineRecord>({
    channel: 'oscar',
    accountId: line.accountId,
    raw: line,
    adapter: {
      ingest: (raw) => ({ id: raw.messageId, timestamp: raw.timestamp, rawText: raw.text, textForAgent: raw.text }),
      preflight: () => ({
        admission: { kind: 'drop', reason: 'room-record', recordHistory: true },
        message: { rawBody: line.text, bodyForAgent: line.text, senderLabel: line.senderLabel },
        history: { key: line.historyKey, limit: ROOM_HISTORY_LIMIT, historyMap: line.historyMap },
      }),
      resolveTurn: () => {
        throw new Error('a recorded room line never resolves a turn');
      },
    },
  });
}
