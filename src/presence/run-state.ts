export const RUN_HEARTBEAT_MS = 60_000;

export type RunStatusPatch = { activeRuns: number; busy: boolean; lastRunActivityAt?: number };

export function createRunStateMachine(params: {
  setStatus?: (patch: RunStatusPatch) => void;
  abortSignal?: AbortSignal;
  heartbeatMs?: number;
  now?: () => number;
}): { isActive(): boolean; onRunStart(): void; onRunEnd(): void; deactivate(): void } {
  const heartbeatMs = params.heartbeatMs ?? RUN_HEARTBEAT_MS;
  const now = params.now ?? Date.now;
  let activeRuns = 0;
  let active = !params.abortSignal?.aborted;
  let beat: ReturnType<typeof setInterval> | null = null;

  const publish = (): void => {
    if (active) params.setStatus?.({ activeRuns, busy: activeRuns > 0, lastRunActivityAt: now() });
  };
  const stopBeat = (): void => {
    if (beat) clearInterval(beat);
    beat = null;
  };
  const deactivate = (): void => {
    active = false;
    stopBeat();
  };

  if (active) {
    params.abortSignal?.addEventListener('abort', deactivate, { once: true });
    params.setStatus?.({ activeRuns: 0, busy: false });
  }

  return {
    isActive: () => active,
    onRunStart() {
      activeRuns += 1;
      publish();
      if (beat || !active) return;
      beat = setInterval(publish, heartbeatMs);
      beat.unref?.();
    },
    onRunEnd() {
      activeRuns = Math.max(0, activeRuns - 1);
      if (activeRuns === 0) stopBeat();
      publish();
    },
    deactivate,
  };
}
