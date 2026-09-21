export class OscarDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OscarDecodeError';
  }
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

export function fromHex(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex.replace(/\s+/g, ''), 'hex'));
}

export class ByteWriter {
  private readonly parts: Uint8Array[] = [];

  u8(v: number): this {
    this.parts.push(Uint8Array.of(v & 0xff));
    return this;
  }

  u16(v: number): this {
    this.parts.push(Uint8Array.of((v >>> 8) & 0xff, v & 0xff));
    return this;
  }

  u32(v: number): this {
    this.parts.push(Uint8Array.of((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff));
    return this;
  }

  u64(v: bigint): this {
    const out = new Uint8Array(8);
    new DataView(out.buffer).setBigUint64(0, BigInt.asUintN(64, v));
    this.parts.push(out);
    return this;
  }

  bytes(v: Uint8Array): this {
    this.parts.push(v);
    return this;
  }

  str8(s: string): this {
    const b = Buffer.from(s, 'utf8');
    if (b.length > 0xff) throw new RangeError('string longer than 255 bytes');
    return this.u8(b.length).bytes(b);
  }

  str16(s: string): this {
    const b = Buffer.from(s, 'utf8');
    if (b.length > 0xffff) throw new RangeError('string longer than 65535 bytes');
    return this.u16(b.length).bytes(b);
  }

  toBytes(): Uint8Array {
    return concatBytes(this.parts);
  }
}

export class ByteReader {
  private at = 0;
  private readonly view: DataView;

  constructor(
    private readonly buf: Uint8Array,
    start = 0,
  ) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    if (start < 0 || start > buf.length) throw new OscarDecodeError('offset outside the buffer');
    this.at = start;
  }

  get remaining(): number {
    return this.buf.length - this.at;
  }

  get offset(): number {
    return this.at;
  }

  private need(n: number): void {
    if (n < 0 || this.remaining < n) {
      throw new OscarDecodeError(`need ${n} bytes, have ${this.remaining}`);
    }
  }

  u8(): number {
    this.need(1);
    const v = this.view.getUint8(this.at);
    this.at += 1;
    return v;
  }

  u16(): number {
    this.need(2);
    const v = this.view.getUint16(this.at);
    this.at += 2;
    return v;
  }

  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.at);
    this.at += 4;
    return v;
  }

  u64(): bigint {
    this.need(8);
    const v = this.view.getBigUint64(this.at);
    this.at += 8;
    return v;
  }

  bytes(n: number): Uint8Array {
    this.need(n);
    const v = this.buf.subarray(this.at, this.at + n);
    this.at += n;
    return v;
  }

  rest(): Uint8Array {
    return this.bytes(this.remaining);
  }

  str8(): string {
    return Buffer.from(this.bytes(this.u8())).toString('utf8');
  }

  str16(): string {
    return Buffer.from(this.bytes(this.u16())).toString('utf8');
  }
}
