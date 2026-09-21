import type { ChannelBotLoopProtectionFacts } from 'openclaw/plugin-sdk/channel-inbound';
import { createPairLoopGuard, resolvePairLoopGuardSettings } from 'openclaw/plugin-sdk/pair-loop-guard-runtime';

export const ROOM_SENDER = '*room*';

export function botLoopFacts(accountId: string, roomKey: string, sender: string, self: string, nowMs: number): ChannelBotLoopProtectionFacts {
  return { scopeId: accountId, conversationId: roomKey, senderId: sender, receiverId: self, defaultEnabled: true, nowMs };
}

export class RoomLoopGuard {
  private readonly guard = createPairLoopGuard();
  private readonly settings = resolvePairLoopGuardSettings({ defaultEnabled: true });

  allow(accountId: string, roomKey: string, self: string, nowMs: number): boolean {
    const result = this.guard.recordAndCheck({
      scopeId: accountId, conversationId: roomKey, senderId: ROOM_SENDER, receiverId: self, settings: this.settings, nowMs,
    });
    return !result.suppressed;
  }

  clear(): void {
    this.guard.clear();
  }
}
