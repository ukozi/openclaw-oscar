import { rosterHash } from '../config.js';
import type { RootPolicy } from '../config.js';
import { roleOf } from '../policy.js';
import { rosterNames } from './route.js';
import type { Clock } from './types.js';

const HELLO = /^#oc hello r=(\d{1,2}) h=([0-9a-f]{8})$/;
const RESEND_MS = 30_000;

export function helloLine(rank: number, hash: string): string {
  return `#oc hello r=${rank} h=${hash}`;
}

export function parseHello(text: string): { rank: number; hash: string } | null {
  const m = HELLO.exec(text);
  return m ? { rank: Number(m[1]), hash: m[2] ?? '' } : null;
}

export type HelloDeps = { self(): string; policy(): RootPolicy; send(to: string, line: string): void; now?: Clock };

export class HelloExchange {
  private readonly now: Clock;
  private readonly peers = new Map<string, { rank: number; hash: string }>();
  private readonly seen = new Set<string>();
  private readonly sent = new Map<string, { hash: string; at: number }>();
  private readonly claimed = new Set<string>();
  private lastHash: string | null = null;

  constructor(private readonly deps: HelloDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  onPeerSeen(name: string): void {
    const self = this.deps.self();
    if (name === self || !rosterNames(this.deps.policy()).includes(name)) return;
    this.seen.add(name);
    if (self < name) this.greet(name, false);
  }

  onRoomJoined(occupants: Iterable<string>): void {
    for (const name of occupants) this.onPeerSeen(name);
  }

  checkHash(): void {
    const mine = this.myHash();
    const changed = this.lastHash !== null && this.lastHash !== mine;
    this.lastHash = mine;
    if (!changed) return;
    const roster = rosterNames(this.deps.policy());
    for (const name of this.seen) if (roster.includes(name)) this.greet(name, true);
  }

  onIm(from: string, text: string): 'handled' | 'pass' {
    const role = roleOf(from, this.deps.policy());
    const parsed = parseHello(text);
    if (role === 'bot') {
      if (parsed) {
        this.peers.set(from, parsed);
        this.seen.add(from);
        if (from < this.deps.self()) this.greet(from, true);
      }
      return 'handled';
    }
    if (role === 'unlisted' && parsed) {
      this.claimed.add(from);
      return 'handled';
    }
    return 'pass';
  }

  hashOf(name: string): string | undefined {
    return this.peers.get(name)?.hash;
  }

  mismatchedIn(occupants: Iterable<string>): string[] {
    const mine = this.myHash();
    const out: string[] = [];
    for (const name of occupants) {
      const theirs = this.peers.get(name)?.hash;
      if (theirs !== undefined && theirs !== mine) out.push(name);
    }
    return out;
  }

  mismatches(): { peer: string; theirs: string; mine: string }[] {
    const mine = this.myHash();
    return [...this.peers].filter(([, p]) => p.hash !== mine).map(([peer, p]) => ({ peer, theirs: p.hash, mine }));
  }

  claims(): string[] {
    return [...this.claimed];
  }

  private myHash(): string {
    return rosterHash(this.deps.policy().chain);
  }

  private greet(name: string, force: boolean): void {
    const hash = this.myHash();
    const last = this.sent.get(name);
    if (!force && last && last.hash === hash && this.now() - last.at < RESEND_MS) return;
    this.sent.set(name, { hash, at: this.now() });
    if (this.lastHash === null) this.lastHash = hash;
    const rank = rosterNames(this.deps.policy()).indexOf(this.deps.self()) + 1;
    this.deps.send(name, helloLine(rank, hash));
  }
}
