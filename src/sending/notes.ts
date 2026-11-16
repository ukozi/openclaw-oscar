import { readPolicy } from '../config.js';
import { copy } from '../copy.js';
import { FILES_LIMITS } from '../inbound/media-gate.js';
import { normalizeName, normalizeRoom } from '../names.js';
import type { RoomRef } from '../names.js';
import type { Logger } from '../oscar/index.js';

export type SendProblem = 'off' | 'failed' | 'too-large' | 'too-many';

// True for a key that had no line in the last minute.
function oncePerMinute(now: () => number): (key: string) => boolean {
  const lastAt = new Map<string, number>();
  return (key) => {
    const at = now();
    for (const [held, sent] of lastAt) if (at - sent >= FILES_LIMITS.refusalCooldownMs) lastAt.delete(held);
    if (lastAt.has(key)) return false;
    lastAt.set(key, at);
    return true;
  };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const maxMbOf = (cfg: unknown): number => Math.round(readPolicy(cfg).files.maxBytes / (1024 * 1024));

export function createSendNotes(p: {
  getCfg: () => unknown;
  now: () => number;
  log: Logger;
  send: (to: string, text: string) => Promise<void>;
}): (to: string, why: SendProblem, link?: string) => void {
  const fresh = oncePerMinute(p.now);
  return (to, why, link) => {
    const name = normalizeName(to);
    if (!name || !fresh(`${why}:${link ?? ''}:${name}`)) return;
    const maxMb = maxMbOf(p.getCfg());
    p.send(name, copy.fileNotSent(why, link ? { maxMb, link } : { maxMb })).catch((err: unknown) => {
      p.log.warn('file note was not delivered', { to: name, why, error: errText(err) });
    });
  };
}

export function createRoomNotes(p: {
  getCfg: () => unknown;
  now: () => number;
  log: Logger;
  send: (room: RoomRef, text: string) => Promise<void>;
}): (room: RoomRef, why: SendProblem) => void {
  const fresh = oncePerMinute(p.now);
  return (room, why) => {
    const name = normalizeRoom(room.name);
    if (!name || !fresh(`${why}:${room.exchange}:${name}`)) return;
    p.send(room, copy.fileNotSent(why, { maxMb: maxMbOf(p.getCfg()) })).catch((err: unknown) => {
      p.log.warn('file note was not delivered', { room: name, why, error: errText(err) });
    });
  };
}
