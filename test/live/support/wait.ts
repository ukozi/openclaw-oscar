export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function until<T>(
  probe: () => T | Promise<T>,
  opts: { timeoutMs: number; everyMs?: number; what: string },
): Promise<NonNullable<T>> {
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value as NonNullable<T>;
    if (Date.now() >= deadline) throw new Error(`timed out after ${opts.timeoutMs} ms waiting for ${opts.what}`);
    await sleep(opts.everyMs ?? 100);
  }
}

export async function holds(probe: () => boolean | Promise<boolean>, opts: { forMs: number; everyMs?: number; what: string }): Promise<void> {
  const deadline = Date.now() + opts.forMs;
  while (Date.now() < deadline) {
    if (!(await probe())) throw new Error(`${opts.what} stopped holding`);
    await sleep(opts.everyMs ?? 200);
  }
}
