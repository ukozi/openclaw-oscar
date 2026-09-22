// SDK 2026.9.x publishes plugin-sdk/pair-loop-guard-runtime without a types entry.
// The runtime is unchanged, so declare the surface this plugin uses.
declare module 'openclaw/plugin-sdk/pair-loop-guard-runtime' {
  export type PairLoopGuardSettings = {
    enabled: boolean;
    maxEventsPerWindow: number;
    windowMs: number;
    cooldownMs: number;
  };

  export type PairLoopGuardConfig = {
    enabled?: boolean;
    maxEventsPerWindow?: number;
    windowSeconds?: number;
    cooldownSeconds?: number;
  };

  export type PairLoopGuardResult = { suppressed: false } | { suppressed: true; cooldownUntilMs: number };

  export type PairLoopGuardSnapshotEntry = {
    key: string;
    recentCount: number;
    cooldownUntilMs: number;
  };

  export type PairLoopGuard = {
    recordAndCheck: (params: {
      scopeId: string;
      conversationId: string;
      senderId: string;
      receiverId: string;
      settings: PairLoopGuardSettings;
      nowMs?: number;
    }) => PairLoopGuardResult;
    clear: () => void;
    snapshot: () => PairLoopGuardSnapshotEntry[];
  };

  export function resolvePairLoopGuardSettings(params: {
    config?: PairLoopGuardConfig;
    defaultsConfig?: PairLoopGuardConfig;
    defaultEnabled: boolean;
  }): PairLoopGuardSettings;

  export function createPairLoopGuard(params?: { pruneIntervalMs?: number }): PairLoopGuard;
}
