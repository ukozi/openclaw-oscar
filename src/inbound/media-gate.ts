import { readPolicy } from '../config.js';
import type { RootPolicy } from '../config.js';
import { copy } from '../copy.js';
import { normalizeName } from '../names.js';
import type { Logger } from '../oscar/index.js';
import { roleOf } from '../policy.js';

export const FILES_LIMITS = { perOffer: 3, active: 4, idleMs: 300_000, stallMs: 180_000, transferMs: 900_000, refusalCooldownMs: 60_000, textChars: 8000 };

export type Refusal = 'too-large' | 'wrong-type' | 'too-many' | 'busy' | 'busy-others' | 'damaged';
// silent: the bot itself, a teammate bot, or a listed person the host does not admit.
export type GateResult = 'allow' | 'stranger' | 'silent';
export type TransferKind = 'direct-im' | 'send-file';

export async function senderGate(p: {
  from: string;
  self: string;
  policy: RootPolicy;
  admit: (from: string, policy: RootPolicy) => Promise<boolean>;
}): Promise<GateResult> {
  const from = normalizeName(p.from);
  if (!from || from === normalizeName(p.self)) return 'silent';
  const role = roleOf(from, p.policy);
  if (role === 'bot') return 'silent';
  if (role === 'unlisted') return 'stranger';
  return (await p.admit(from, p.policy)) ? 'allow' : 'silent';
}

export class Slots {
  private readonly held = new Set<string>();

  take(peer: string, kind: TransferKind): 'ok' | 'busy' | 'busy-others' {
    const key = slotKey(peer, kind);
    if (this.held.has(key)) return 'busy';
    if (this.held.size >= FILES_LIMITS.active) return 'busy-others';
    this.held.add(key);
    return 'ok';
  }

  release(peer: string, kind: TransferKind): void {
    this.held.delete(slotKey(peer, kind));
  }

  active(): number {
    return this.held.size;
  }
}

function slotKey(peer: string, kind: TransferKind): string {
  return `${kind}:${normalizeName(peer)}`;
}

export function createRefusals(p: {
  getCfg: () => unknown;
  now: () => number;
  log: Logger;
  send: (to: string, text: string) => Promise<void>;
}): (to: string, why: Refusal) => void {
  const lastAt = new Map<string, number>();
  return (to, why) => {
    const name = normalizeName(to);
    const at = p.now();
    for (const [key, sent] of lastAt) if (at - sent >= FILES_LIMITS.refusalCooldownMs) lastAt.delete(key);
    const key = `${why}:${name}`;
    if (!name || lastAt.has(key)) return;
    lastAt.set(key, at);
    const maxMb = Math.round(readPolicy(p.getCfg()).files.maxBytes / (1024 * 1024));
    p.send(name, copy.fileRefused(why, maxMb)).catch((err: unknown) => {
      p.log.warn('refusal was not delivered', { to: name, why, error: err instanceof Error ? err.message : String(err) });
    });
  };
}

export type TurnMedia = { path: string; contentType: string; kind: 'image' | 'document'; name: string; bytes: number; via: TransferKind };
export type MediaEvent = { from: string; fromDisplay: string; text: string; media: TurnMedia[] };
