import net from 'node:net';
import { waitFor } from 'open-oscar-client-kit/testing';
import {
  ByteReader,
  ByteWriter,
  FlapDecoder,
  decodeSnac,
  decodeTlvs,
  encodeFlap,
  encodeSignonPayload,
  encodeSnac,
  encodeTlvs,
  findTlv,
  strongHash,
  tlv,
} from 'open-oscar-client-kit/wire';
import type { FlapFrame, Snac, Tlv } from 'open-oscar-client-kit/wire';

export { ManualTimers, captureLog, settle, tick, waitFor } from 'open-oscar-client-kit/testing';
export type { LogLine } from 'open-oscar-client-kit/testing';
export { imSends, makeSession, stopAllSessions } from './session-harness.js';
export type { Harness } from './session-harness.js';

export class RawClient {
  readonly frames: FlapFrame[] = [];
  closed = false;
  private readonly decoder = new FlapDecoder();
  private seq = 0;
  private taken = 0;

  private constructor(private readonly socket: net.Socket) {
    socket.on('data', (chunk: Buffer) => this.frames.push(...this.decoder.push(new Uint8Array(chunk))));
    socket.on('error', () => {});
    socket.on('close', () => {
      const last = this.decoder.end();
      if (last) this.frames.push(last);
      this.closed = true;
    });
  }

  static async connect(port: number): Promise<RawClient> {
    const socket = net.connect({ host: '127.0.0.1', port });
    const client = new RawClient(socket);
    await client.nextFrame();
    return client;
  }

  async nextFrame(): Promise<FlapFrame> {
    await waitFor(() => this.frames.length > this.taken || this.closed, 'a frame');
    const frame = this.frames[this.taken];
    if (!frame) throw new Error('connection closed with no frame');
    this.taken++;
    return frame;
  }

  async nextSnac(): Promise<Snac> {
    return decodeSnac((await this.nextFrame()).payload);
  }

  async untilClosed(): Promise<void> {
    await waitFor(() => this.closed, 'close');
  }

  signon(tlvs: Tlv[] = []): void {
    this.socket.write(encodeFlap(1, this.seq++, encodeSignonPayload(tlvs)));
  }

  snac(family: number, subtype: number, requestId: number, body?: Uint8Array): void {
    this.socket.write(encodeFlap(2, this.seq++, encodeSnac({ family, subtype, requestId }, body)));
  }

  close(): void {
    this.socket.destroy();
  }

  static async login(port: number, name: string, password: string): Promise<{ tlvs: Tlv[]; client: RawClient }> {
    const client = await RawClient.connect(port);
    client.signon();
    client.snac(0x17, 0x06, 1, encodeTlvs([tlv.str(0x01, name)]));
    const challenge = await client.nextSnac();
    if (challenge.subtype !== 0x07) return { tlvs: decodeTlvs(challenge.body), client };
    const key = new ByteReader(challenge.body).str16();
    client.snac(
      0x17,
      0x02,
      2,
      encodeTlvs([tlv.str(0x01, name), tlv.bytes(0x25, strongHash(password, key)), tlv.str(0x03, 'raw'), tlv.u8(0x4a, 3)]),
    );
    return { tlvs: decodeTlvs((await client.nextSnac()).body), client };
  }

  static async signOn(port: number, name: string, password: string, buddies: string[] = []): Promise<RawClient> {
    const { tlvs, client: auth } = await RawClient.login(port, name, password);
    auth.close();
    const cookie = findTlv(tlvs, 0x06);
    if (!cookie) throw new Error('login failed');
    const bos = await RawClient.connect(port);
    bos.signon([tlv.bytes(0x06, cookie)]);
    await bos.nextSnac();
    const names = new ByteWriter();
    for (const b of buddies) names.str8(b);
    bos.snac(3, 0x04, 1, names.toBytes());
    bos.snac(1, 0x02, 2);
    bos.snac(1, 0x0e, 3);
    for (;;) if ((await bos.nextSnac()).subtype === 0x0f) return bos;
  }
}
