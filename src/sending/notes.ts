import { readPolicy } from '../config.js';
import { copy } from '../copy.js';
import { FILES_LIMITS } from '../inbound/media-gate.js';
import { normalizeName } from '../names.js';
import type { Logger } from '../oscar/index.js';

export type SendProblem = 'off' | 'failed' | 'too-large' | 'too-many';

export function createSendNotes(p: {
  getCfg: () => unknown;
  now: () => number;
  log: Logger;
  send: (to: string, text: string) => Promise<void>;
}): (to: string, why: SendProblem, link?: string) => void {
  const lastAt = new Map<string, number>();
  return (to, why, link) => {
    const name = normalizeName(to);
    const at = p.now();
    for (const [key, sent] of lastAt) if (at - sent >= FILES_LIMITS.refusalCooldownMs) lastAt.delete(key);
    const key = `${why}:${link ?? ''}:${name}`;
    if (!name || lastAt.has(key)) return;
    lastAt.set(key, at);
    const maxMb = Math.round(readPolicy(p.getCfg()).files.maxBytes / (1024 * 1024));
    p.send(name, copy.fileNotSent(why, link ? { maxMb, link } : { maxMb })).catch((err: unknown) => {
      p.log.warn('file note was not delivered', { to: name, why, error: err instanceof Error ? err.message : String(err) });
    });
  };
}
