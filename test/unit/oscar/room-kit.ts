import { readFileSync } from 'node:fs';
import type { LinkClose, Logger, SnacIn, SnacLink } from '../../../src/oscar/types.js';

type VectorFile = { source: string; vectors: Record<string, { struct: string; hex: string }> };
const vectorFile = JSON.parse(
  readFileSync(new URL('../../vectors/rooms.json', import.meta.url), 'utf8'),
) as VectorFile;

export const vectorSource = vectorFile.source;

export function vectorHex(name: string): string {
  const entry = vectorFile.vectors[name];
  if (!entry) throw new Error(`no vector named ${name}`);
  return entry.hex;
}

export function vector(name: string): Uint8Array {
  return Uint8Array.from(Buffer.from(vectorHex(name), 'hex'));
}

export function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

export const quietLog: Logger = { debug() {}, info() {}, warn() {}, error() {} };

export const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export type SentSnac = { family: number; subtype: number; body: Uint8Array; requestId: number };
export type Scripted = { family: number; subtype: number; body?: Uint8Array } | 'drop' | undefined;

export class FakeLink implements SnacLink {
  readonly sent: SentSnac[] = [];
  closed = false;
  onRequest: ((snac: SentSnac) => Scripted) | null = null;
  onSend: ((snac: SentSnac) => void) | null = null;
  private nextId = 1;
  private readonly snacFns = new Set<(snac: SnacIn) => void>();
  private readonly closeFns = new Set<(info: LinkClose) => void>();
  private readonly waiting = new Map<number, { resolve: (snac: SnacIn) => void; reject: (err: Error) => void }>();

  send(family: number, subtype: number, body: Uint8Array): number {
    const requestId = this.nextId++;
    const snac = { family, subtype, body, requestId };
    this.sent.push(snac);
    this.onSend?.(snac);
    return requestId;
  }

  request(family: number, subtype: number, body: Uint8Array): Promise<SnacIn> {
    const requestId = this.send(family, subtype, body);
    return new Promise<SnacIn>((resolve, reject) => {
      if (this.closed) {
        reject(new Error('link closed'));
        return;
      }
      this.waiting.set(requestId, { resolve, reject });
      const scripted = this.onRequest?.({ family, subtype, body, requestId });
      if (scripted === 'drop') queueMicrotask(() => this.drop());
      else if (scripted) queueMicrotask(() => this.deliver({ ...scripted, requestId }));
    });
  }

  onSnac(fn: (snac: SnacIn) => void): () => void {
    this.snacFns.add(fn);
    return () => {
      this.snacFns.delete(fn);
    };
  }

  onClose(fn: (info: LinkClose) => void): () => void {
    this.closeFns.add(fn);
    return () => {
      this.closeFns.delete(fn);
    };
  }

  close(): void {
    this.drop(true);
  }

  deliver(snac: { family: number; subtype: number; body?: Uint8Array; requestId?: number }): void {
    const full: SnacIn = {
      family: snac.family,
      subtype: snac.subtype,
      requestId: snac.requestId ?? 0,
      body: snac.body ?? new Uint8Array(0),
    };
    const waiter = this.waiting.get(full.requestId);
    if (waiter) {
      this.waiting.delete(full.requestId);
      waiter.resolve(full);
    }
    for (const fn of [...this.snacFns]) fn(full);
  }

  drop(clean = false): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiting.values()) waiter.reject(new Error('link closed'));
    this.waiting.clear();
    for (const fn of [...this.closeFns]) fn({ clean });
  }

  sentOf(family: number, subtype: number): SentSnac[] {
    return this.sent.filter((s) => s.family === family && s.subtype === subtype);
  }
}
