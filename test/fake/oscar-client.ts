import type { Logger, TimerApi } from '../../src/oscar/types.js';

// Manual time outruns real sockets. After each fired timer, give loopback I/O a moment to land.
export function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 2));
}

export async function waitFor(cond: () => boolean, what = 'condition', timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export class ManualTimers {
  private t = 1_800_000_000_000;
  private nextId = 1;
  private readonly queue = new Map<number, { at: number; fn: () => void }>();

  readonly api: TimerApi = {
    setTimeout: ((fn: () => void, ms?: number) => {
      const id = this.nextId++;
      this.queue.set(id, { at: this.t + (ms ?? 0), fn });
      return id;
    }) as unknown as typeof setTimeout,
    clearTimeout: ((id?: number) => {
      if (id !== undefined) this.queue.delete(id);
    }) as unknown as typeof clearTimeout,
  };

  now = (): number => this.t;

  pending(): number[] {
    return [...this.queue.values()].map((e) => e.at - this.t).sort((a, b) => a - b);
  }

  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | undefined;
      for (const entry of this.queue) {
        if (entry[1].at <= end && (!next || entry[1].at < next[1].at)) next = entry;
      }
      if (!next) break;
      this.queue.delete(next[0]);
      this.t = Math.max(this.t, next[1].at);
      next[1].fn();
      await tick();
    }
    this.t = end;
    await tick();
  }
}

export type LogLine = { level: keyof Logger; msg: string; fields?: Record<string, unknown> | undefined };

export function captureLog(): { log: Logger; lines: LogLine[]; text: () => string } {
  const lines: LogLine[] = [];
  const at = (level: keyof Logger) => (msg: string, fields?: Record<string, unknown>) => {
    lines.push({ level, msg, fields });
  };
  return {
    log: { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') },
    lines,
    text: () =>
      lines
        .map((l) => `${l.level} ${l.msg} ${JSON.stringify(l.fields ?? {}, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`)
        .join('\n'),
  };
}
