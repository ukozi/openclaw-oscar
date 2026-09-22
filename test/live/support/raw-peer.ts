import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as net from 'node:net';
import * as tls from 'node:tls';
import { connectUpstream } from './source.js';

export type RawSnac = { family: number; subtype: number; requestId: number; body: Buffer; at: number };
export type RawIm = { from: string; text: string; autoResponse: boolean };
export type RawUserInfo = { online: boolean; away: string | null; flags: number };
export type RawPeerOptions = {
  host: string; port: number; screenName: string; password: string;
  tls?: boolean; caFile?: string; multiConn?: 0x00 | 0x01 | 0x03;
};

const CHAT_CAPABILITY = Buffer.from('748F2420628711D18222444553540000', 'hex');
const MD5_SUFFIX = 'AOL Instant Messenger (SM)';

function tlv(tag: number, value: Buffer | string): Buffer {
  const v = typeof value === 'string' ? Buffer.from(value, 'latin1') : value;
  const h = Buffer.alloc(4);
  h.writeUInt16BE(tag, 0);
  h.writeUInt16BE(v.length, 2);
  return Buffer.concat([h, v]);
}

function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n, 0);
  return b;
}

function parseTlvs(buf: Buffer, count = Infinity): { tlvs: Map<number, Buffer>; rest: Buffer } {
  const tlvs = new Map<number, Buffer>();
  let at = 0;
  for (let i = 0; i < count && at + 4 <= buf.length; i += 1) {
    const tag = buf.readUInt16BE(at);
    const len = buf.readUInt16BE(at + 2);
    if (!tlvs.has(tag)) tlvs.set(tag, buf.subarray(at + 4, at + 4 + len));
    at += 4 + len;
  }
  return { tlvs, rest: buf.subarray(at) };
}

function normalize(name: string): string {
  return name.replace(/ /g, '').toLowerCase();
}

class Conn {
  readonly snacs: RawSnac[] = [];
  closed = false;
  signoff: Map<number, Buffer> | null = null;
  private readonly socket: net.Socket;
  private pending = Buffer.alloc(0);
  private seq = Math.floor(Math.random() * 0x7000);
  private nextRequest = 1;
  private readonly waiters: { match: (s: RawSnac) => boolean; resolve: (s: RawSnac) => void }[] = [];
  private signonSeen: (() => void) | null = null;

  constructor(socket: net.Socket) {
    this.socket = socket;
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('close', () => { this.closed = true; });
    socket.on('error', () => { this.closed = true; });
  }

  static async open(opts: RawPeerOptions, host: string, port: number): Promise<Conn> {
    const socket = opts.tls
      ? tls.connect({ host, port, servername: host, ...(opts.caFile ? { ca: readFileSync(opts.caFile) } : {}) })
      : await connectUpstream(host, port);
    return new Promise((resolve, reject) => {
      const conn = new Conn(socket);
      socket.once('error', reject);
      conn.signonSeen = () => resolve(conn);
    });
  }

  private onData(chunk: Buffer): void {
    this.pending = Buffer.concat([this.pending, chunk]);
    while (this.pending.length >= 6 && this.pending.readUInt8(0) === 0x2a) {
      const size = 6 + this.pending.readUInt16BE(4);
      if (this.pending.length < size) return;
      const channel = this.pending.readUInt8(1);
      const payload = Buffer.from(this.pending.subarray(6, size));
      this.pending = this.pending.subarray(size);
      if (channel === 1) this.signonSeen?.();
      if (channel === 4) this.signoff = parseTlvs(payload).tlvs;
      if (channel === 2 && payload.length >= 10) this.onSnac(payload);
    }
  }

  private onSnac(payload: Buffer): void {
    const flags = payload.readUInt16BE(4);
    let body = payload.subarray(10);
    // flag 0x8000: the body starts with a length-prefixed block that is not part of the SNAC body
    if (flags & 0x8000 && body.length >= 2) body = body.subarray(2 + body.readUInt16BE(0));
    const snac: RawSnac = {
      family: payload.readUInt16BE(0), subtype: payload.readUInt16BE(2),
      requestId: payload.readUInt32BE(6), body: Buffer.from(body), at: Date.now(),
    };
    this.snacs.push(snac);
    const at = this.waiters.findIndex((w) => w.match(snac));
    if (at !== -1) this.waiters.splice(at, 1)[0]?.resolve(snac);
  }

  flap(channel: number, payload: Buffer): void {
    const h = Buffer.alloc(6);
    h.writeUInt8(0x2a, 0);
    h.writeUInt8(channel, 1);
    this.seq = (this.seq + 1) & 0xffff;
    h.writeUInt16BE(this.seq, 2);
    h.writeUInt16BE(payload.length, 4);
    this.socket.write(Buffer.concat([h, payload]));
  }

  snac(family: number, subtype: number, body: Buffer): number {
    const h = Buffer.alloc(10);
    const requestId = this.nextRequest;
    this.nextRequest += 1;
    h.writeUInt16BE(family, 0);
    h.writeUInt16BE(subtype, 2);
    h.writeUInt32BE(requestId, 6);
    this.flap(2, Buffer.concat([h, body]));
    return requestId;
  }

  wait(match: (s: RawSnac) => boolean, ms: number, what: string): Promise<RawSnac> {
    const seen = this.snacs.find(match);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`raw peer: no ${what} within ${ms} ms`)), ms);
      this.waiters.push({ match, resolve: (s) => { clearTimeout(timer); resolve(s); } });
    });
  }

  close(): void {
    if (!this.closed) this.flap(4, Buffer.alloc(0));
    this.socket.destroy();
  }

  destroy(): void {
    this.socket.destroy();
  }
}

export class RawPeer {
  readonly screenName: string;
  private readonly bos: Conn;

  private constructor(screenName: string, bos: Conn) {
    this.screenName = screenName;
    this.bos = bos;
  }

  static async login(opts: RawPeerOptions): Promise<{ host: string; port: number; cookie: Buffer }> {
    const auth = await Conn.open(opts, opts.host, opts.port);
    try {
      auth.flap(1, Buffer.from([0, 0, 0, 1]));
      auth.snac(0x17, 0x06, tlv(0x01, opts.screenName));
      const challenge = await auth.wait((s) => s.family === 0x17 && (s.subtype === 0x07 || s.subtype === 0x03), 10_000, 'login challenge');
      if (challenge.subtype === 0x03) throw new Error(`raw peer: login refused before the challenge for ${opts.screenName}`);
      const key = challenge.body.subarray(2, 2 + challenge.body.readUInt16BE(0));
      const inner = createHash('md5').update(opts.password, 'latin1').digest();
      const hash = createHash('md5').update(key).update(inner).update(MD5_SUFFIX, 'latin1').digest();
      auth.snac(0x17, 0x02, Buffer.concat([
        tlv(0x01, opts.screenName), tlv(0x25, hash), tlv(0x4a, Buffer.from([opts.multiConn ?? 0x03])), tlv(0x03, 'rawpeer'),
      ]));
      const reply = await auth.wait((s) => s.family === 0x17 && s.subtype === 0x03, 10_000, 'login reply');
      const { tlvs } = parseTlvs(reply.body);
      const code = tlvs.get(0x08);
      if (code) throw new Error(`raw peer: login failed for ${opts.screenName} with code 0x${code.readUInt16BE(0).toString(16)}`);
      const address = (tlvs.get(0x05) ?? Buffer.alloc(0)).toString('latin1');
      const cookie = tlvs.get(0x06);
      if (!cookie) throw new Error('raw peer: login reply carried no cookie');
      const [host, port] = address.split(':');
      return { host: host ?? opts.host, port: Number(port ?? opts.port), cookie: Buffer.from(cookie) };
    } finally {
      auth.destroy();
    }
  }

  static async signOn(opts: RawPeerOptions): Promise<RawPeer> {
    const { cookie } = await RawPeer.login(opts);
    // always dial the configured address: the harness owns routing, the advertised host may be a tap
    const bos = await Conn.open(opts, opts.host, opts.port);
    bos.flap(1, Buffer.concat([Buffer.from([0, 0, 0, 1]), tlv(0x06, cookie)]));
    await bos.wait((s) => s.family === 0x01 && s.subtype === 0x03, 10_000, 'HostOnline');
    bos.snac(0x02, 0x04, tlv(0x05, CHAT_CAPABILITY));
    bos.snac(0x13, 0x07, Buffer.alloc(0));
    bos.snac(0x01, 0x02, Buffer.alloc(0));
    const peer = new RawPeer(opts.screenName, bos);
    await peer.userInfo(opts.screenName);
    return peer;
  }

  received(): RawSnac[] {
    return [...this.bos.snacs];
  }

  receivedSince(t: number, family?: number): RawSnac[] {
    return this.bos.snacs.filter((s) => s.at >= t && (family === undefined || s.family === family));
  }

  kicked(): boolean {
    const code = this.bos.signoff?.get(0x09);
    return this.bos.closed || (code !== undefined && code.length > 0 && code.readUInt8(0) === 1);
  }

  ims(): RawIm[] {
    const out: RawIm[] = [];
    for (const s of this.bos.snacs) {
      if (s.family !== 0x04 || s.subtype !== 0x07 || s.body.readUInt16BE(8) !== 1) continue;
      const nameLen = s.body.readUInt8(10);
      const from = s.body.subarray(11, 11 + nameLen).toString('latin1');
      const count = s.body.readUInt16BE(11 + nameLen + 2);
      const afterInfo = parseTlvs(s.body.subarray(11 + nameLen + 4), count).rest;
      const { tlvs } = parseTlvs(afterInfo);
      const data = tlvs.get(0x02);
      if (!data) continue;
      let at = 0;
      let text = '';
      while (at + 4 <= data.length) {
        const id = data.readUInt8(at);
        const len = data.readUInt16BE(at + 2);
        const frag = data.subarray(at + 4, at + 4 + len);
        if (id === 1) {
          const charset = frag.readUInt16BE(0);
          const raw = frag.subarray(4);
          text = charset === 2 ? Buffer.from(raw).swap16().toString('utf16le') : raw.toString(charset === 3 ? 'latin1' : 'utf8');
        }
        at += 4 + len;
      }
      out.push({ from: normalize(from), text, autoResponse: tlvs.has(0x04) });
    }
    return out;
  }

  sendIm(to: string, text: string): void {
    const message = Buffer.concat([u16(0), u16(0), Buffer.from(text, 'latin1')]);
    const fragments = Buffer.concat([
      Buffer.from([5, 1]), u16(3), Buffer.from([1, 1, 2]),
      Buffer.from([1, 1]), u16(message.length), message,
    ]);
    this.bos.snac(0x04, 0x06, Buffer.concat([
      randomBytes(8), u16(1), Buffer.from([to.length]), Buffer.from(to, 'latin1'), tlv(0x02, fragments),
    ]));
  }

  sendInvite(to: string, room: { exchange: 4 | 5; name: string }, text = 'Join me in this chat.'): void {
    const cookie = `${room.exchange}-0-${room.name}`;
    const roomInfo = Buffer.concat([u16(room.exchange), Buffer.from([cookie.length]), Buffer.from(cookie, 'latin1'), u16(0)]);
    const rendezvous = Buffer.concat([
      u16(0), randomBytes(8), CHAT_CAPABILITY,
      tlv(0x0a, u16(1)), tlv(0x0c, text), tlv(0x0d, 'us-ascii'), tlv(0x0e, 'en'), tlv(0x2711, roomInfo),
    ]);
    this.bos.snac(0x04, 0x06, Buffer.concat([
      randomBytes(8), u16(2), Buffer.from([to.length]), Buffer.from(to, 'latin1'), tlv(0x05, rendezvous),
    ]));
  }

  async userInfo(name: string): Promise<RawUserInfo> {
    const requestId = this.bos.snac(0x02, 0x05, Buffer.concat([u16(0x0002), Buffer.from([name.length]), Buffer.from(name, 'latin1')]));
    const reply = await this.bos.wait(
      (s) => s.family === 0x02 && s.requestId === requestId && (s.subtype === 0x06 || s.subtype === 0x01), 10_000, `user info for ${name}`,
    );
    if (reply.subtype === 0x01) return { online: false, away: null, flags: 0 };
    const nameLen = reply.body.readUInt8(0);
    const count = reply.body.readUInt16BE(1 + nameLen + 2);
    const info = parseTlvs(reply.body.subarray(1 + nameLen + 4), count);
    const flags = info.tlvs.get(0x01)?.readUInt16BE(0) ?? 0;
    const away = parseTlvs(info.rest).tlvs.get(0x04);
    return { online: true, away: away ? away.toString('latin1') : null, flags };
  }

  signOff(): void {
    this.bos.close();
  }
}
