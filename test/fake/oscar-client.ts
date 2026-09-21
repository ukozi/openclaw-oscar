import net from 'node:net';
import { strongHash } from '../../src/oscar/auth.js';
import { ByteReader, ByteWriter } from '../../src/oscar/bytes.js';
import { FlapDecoder, encodeFlap, encodeSignonPayload } from '../../src/oscar/flap.js';
import type { FlapFrame } from '../../src/oscar/flap.js';
import { OscarSessionImpl } from '../../src/oscar/session.js';
import { decodeSnac, encodeSnac } from '../../src/oscar/snac.js';
import type { Snac } from '../../src/oscar/snac.js';
import { decodeTlvs, encodeTlvs, findTlv, tlv } from '../../src/oscar/tlv.js';
import type { Tlv } from '../../src/oscar/tlv.js';
import type {
  ImEvent,
  Logger,
  OscarEvents,
  OscarSessionOptions,
  RateEvent,
  SessionState,
  TimerApi,
} from '../../src/oscar/types.js';
import type { FakeOscarServer } from './oscar-server.js';

// Manual time outruns real sockets. After each fired timer, give loopback I/O a moment to land.
export function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 2));
}

export async function waitFor(cond: () => boolean, what = 'condition', timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export class ManualTimers {
  private t = 1_800_000_000_000;
  private nextId = 1;
  private readonly queue = new Map<number, { at: number; fn: () => void }>();

  readonly api: TimerApi = {
    setTimeout: ((fn: () => void, ms?: number) => {
      const id = this.nextId++;
      this.queue.set(id, { at: this.t + (ms ?? 0), fn });
      return id;
    }) as unknown as typeof setTimeout,
    clearTimeout: ((id?: number) => {
      if (id !== undefined) this.queue.delete(id);
    }) as unknown as typeof clearTimeout,
  };

  now = (): number => this.t;

  pending(): number[] {
    return [...this.queue.values()].map((e) => e.at - this.t).sort((a, b) => a - b);
  }

  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | undefined;
      for (const entry of this.queue) {
        if (entry[1].at <= end && (!next || entry[1].at < next[1].at)) next = entry;
      }
      if (!next) break;
      this.queue.delete(next[0]);
      this.t = Math.max(this.t, next[1].at);
      next[1].fn();
      await tick();
    }
    this.t = end;
    await tick();
  }
}

export type LogLine = { level: keyof Logger; msg: string; fields?: Record<string, unknown> | undefined };

export function captureLog(): { log: Logger; lines: LogLine[]; text: () => string } {
  const lines: LogLine[] = [];
  const at = (level: keyof Logger) => (msg: string, fields?: Record<string, unknown>) => {
    lines.push({ level, msg, fields });
  };
  return {
    log: { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') },
    lines,
    text: () =>
      lines
        .map((l) => `${l.level} ${l.msg} ${JSON.stringify(l.fields ?? {}, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`)
        .join('\n'),
  };
}

export type Harness = {
  session: OscarSessionImpl;
  timers: ManualTimers;
  logs: ReturnType<typeof captureLog>;
  states: SessionState[];
  ims: ImEvent[];
  presence: OscarEvents['presence'][];
  rates: RateEvent[];
  online(): Promise<void>;
  phase(phase: SessionState['phase']): Promise<SessionState>;
};

const harnesses: Harness[] = [];

export function makeSession(server: FakeOscarServer, over: Partial<OscarSessionOptions> = {}): Harness {
  const timers = new ManualTimers();
  const logs = captureLog();
  const session = new OscarSessionImpl({
    host: '127.0.0.1',
    port: server.port,
    tls: server.caFile !== undefined,
    caFile: server.caFile,
    redirect: 'auto',
    screenName: 'botone',
    getPassword: async () => 'botpass1',
    buddies: () => ['alice', 'bob'],
    log: logs.log,
    loginBudget: { take: async () => {} },
    now: timers.now,
    timers: timers.api,
    ...over,
  });
  const h: Harness = {
    session,
    timers,
    logs,
    states: [],
    ims: [],
    presence: [],
    rates: [],
    online: async () => {
      await h.phase('online');
    },
    phase: async (phase) => {
      await waitFor(() => session.getState().phase === phase, `phase ${phase} (now ${session.getState().phase})`);
      return session.getState();
    },
  };
  session.on('state', (s) => h.states.push(s));
  session.on('im', (e) => h.ims.push(e));
  session.on('presence', (e) => h.presence.push(e));
  session.on('rate', (e) => h.rates.push(e));
  harnesses.push(h);
  return h;
}

export async function stopAllSessions(): Promise<void> {
  for (const h of harnesses.splice(0)) await h.session.stop();
}

export function imSends(server: FakeOscarServer, name: string): { cookie: bigint; to: string; tlvs: Tlv[] }[] {
  return server
    .snacsFrom(name)
    .filter((s) => s.conn === 'bos' && s.family === 4 && s.subtype === 6)
    .map((s) => {
      const r = new ByteReader(s.body);
      return { cookie: r.u64(), to: (r.u16(), r.str8()), tlvs: decodeTlvs(r.rest()) };
    });
}

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

// Waits on loopback I/O, not the clock: what a session wrote before the call has reached the fake when
// this resolves. Each round is a connection to the fake and its signon frame back. Plaintext fakes only.
export async function settle(port: number, rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i++) (await RawClient.connect(port)).close();
}
