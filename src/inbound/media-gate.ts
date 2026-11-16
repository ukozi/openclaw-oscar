import type { RootPolicy } from '../config.js';
import { normalizeName } from '../names.js';
import { roleOf } from '../policy.js';

export const FILES_LIMITS = { perOffer: 3, active: 4, idleMs: 300_000, stallMs: 180_000, transferMs: 900_000, refusalCooldownMs: 60_000 };

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

export type TurnMedia = { path: string; contentType: string; kind: 'image' | 'document'; name: string; bytes: number; via: TransferKind };
export type MediaEvent = { from: string; fromDisplay: string; text: string; media: TurnMedia[] };
