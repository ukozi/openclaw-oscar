import * as net from 'node:net';
import { connectUpstream } from './source.js';

export type TapFrame = { conn: number; channel: number; family: number; subtype: number; payload: Buffer };

type Pair = { id: number; client: net.Socket; upstream: net.Socket | null; pending: Buffer };

// 0x04/0x06 is SNAC header (10), cookie (8), channel (2), then the addressee with a one-byte length
export function imRecipientOf(frame: TapFrame): string | null {
  if (frame.family !== 0x04 || frame.subtype !== 0x06 || frame.payload.length < 21) return null;
  const length = frame.payload.readUInt8(20);
  if (frame.payload.length < 21 + length) return null;
  return frame.payload.subarray(21, 21 + length).toString('latin1').replace(/ /g, '').toLowerCase();
}

export function imCookieOf(frame: TapFrame): string | null {
  if (frame.family !== 0x04 || frame.subtype !== 0x06 || frame.payload.length < 18) return null;
  return frame.payload.subarray(10, 18).toString('hex');
}

export class Tap {
  readonly port: number;
  private readonly server: net.Server;
  private readonly pairs = new Set<Pair>();
  private readonly frames: TapFrame[] = [];
  private readonly drops: ((f: TapFrame) => boolean)[] = [];
  private accepted = 0;
  private frozen = false;

  private constructor(server: net.Server, port: number) {
    this.server = server;
    this.port = port;
  }

  static start(opts: { targetHost: string; targetPort: number }): Promise<Tap> {
    return new Promise((resolve, reject) => {
      let tap: Tap;
      const server = net.createServer((client) => {
        void tap.accept(client, opts.targetHost, opts.targetPort);
      });
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        tap = new Tap(server, (server.address() as net.AddressInfo).port);
        resolve(tap);
      });
    });
  }

  private async accept(client: net.Socket, host: string, port: number): Promise<void> {
    this.accepted += 1;
    const pair: Pair = { id: this.accepted, client, upstream: null, pending: Buffer.alloc(0) };
    this.pairs.add(pair);
    client.pause();
    const close = () => {
      client.destroy();
      pair.upstream?.destroy();
      this.pairs.delete(pair);
    };
    client.on('error', close);
    client.on('close', close);
    const upstream = await connectUpstream(host, port);
    if (client.destroyed) {
      upstream.destroy();
      return;
    }
    pair.upstream = upstream;
    upstream.on('error', close);
    upstream.on('close', close);
    upstream.on('data', (chunk: Buffer) => client.write(chunk));
    client.on('data', (chunk: Buffer) => this.fromClient(pair, chunk));
    if (this.frozen) upstream.pause();
    else client.resume();
  }

  private fromClient(pair: Pair, chunk: Buffer): void {
    pair.pending = Buffer.concat([pair.pending, chunk]);
    while (pair.pending.length >= 6) {
      if (pair.pending[0] !== 0x2a) {
        pair.upstream?.write(pair.pending);
        pair.pending = Buffer.alloc(0);
        return;
      }
      const size = 6 + pair.pending.readUInt16BE(4);
      if (pair.pending.length < size) return;
      const raw = pair.pending.subarray(0, size);
      pair.pending = pair.pending.subarray(size);
      const payload = Buffer.from(raw.subarray(6));
      const isSnac = raw[1] === 2 && payload.length >= 10;
      const frame: TapFrame = {
        conn: pair.id,
        channel: raw[1] ?? 0,
        family: isSnac ? payload.readUInt16BE(0) : 0,
        subtype: isSnac ? payload.readUInt16BE(2) : 0,
        payload,
      };
      this.frames.push(frame);
      const at = this.drops.findIndex((match) => match(frame));
      if (at !== -1) {
        this.drops.splice(at, 1);
        continue;
      }
      pair.upstream?.write(raw);
    }
  }

  connections(): number {
    return this.accepted;
  }

  open(): number {
    return this.pairs.size;
  }

  framesToServer(): TapFrame[] {
    return [...this.frames];
  }

  dropNext(match: (f: TapFrame) => boolean): void {
    this.drops.push(match);
  }

  freeze(): void {
    this.frozen = true;
    for (const p of this.pairs) {
      p.client.pause();
      p.upstream?.pause();
    }
  }

  thaw(): void {
    this.frozen = false;
    for (const p of this.pairs) {
      p.client.resume();
      p.upstream?.resume();
    }
  }

  severAll(): void {
    for (const p of [...this.pairs]) {
      p.client.destroy();
      p.upstream?.destroy();
    }
  }

  async stop(): Promise<void> {
    this.severAll();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
