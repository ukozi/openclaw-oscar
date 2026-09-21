import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';
import { strongHash } from '../../src/oscar/auth.js';
import { decodeImFragments, encodeImFragments, newCookie } from '../../src/oscar/bos.js';
import { ByteReader, ByteWriter } from '../../src/oscar/bytes.js';
import { FlapDecoder, decodeSignonPayload, encodeFlap, encodeSignonPayload } from '../../src/oscar/flap.js';
import { decodeSnac, encodeSnac, encodeUserInfo } from '../../src/oscar/snac.js';
import type { Snac } from '../../src/oscar/snac.js';
import { fromWireText, isAscii, normalizeScreenName } from '../../src/oscar/text.js';
import { decodeTlvs, encodeTlvs, findTlv, hasTlv, tlv, tlvStr, tlvU8 } from '../../src/oscar/tlv.js';
import type { Tlv } from '../../src/oscar/tlv.js';
import type { RoomRef } from '../../src/oscar/types.js';
import { FakeRooms } from './oscar-rooms.js';
import type { FakeConn } from './oscar-rooms.js';
import { TEST_TLS_CERT, TEST_TLS_KEY } from './tls-fixture.js';

export type FakeGeneration = 'v0.24' | 'main';
export type ConnKind = 'auth' | 'bos' | 'chatnav' | 'chat';
export type SnacRecord = { family: number; subtype: number; body: Uint8Array; conn: ConnKind };
export type StartOptions = {
  generation?: FakeGeneration;
  disableAuth?: boolean;
  advertisedHost?: string;
  loginLimit?: number;
  tls?: boolean;
  sslHost?: boolean;
};

const SERVER_REQUEST_ID = 0x80000000;
const COOKIE_TTL_MS = 60_000;
const OFFLINE_CAP = 10;
const SYSTEM_NAME = 'OOS System Msg';
const BOS_FAMILIES = [0x0018, 0x0010, 0x0003, 0x0013, 0x0004, 0x0015, 0x0002, 0x0001, 0x0009, 0x000a, 0x0006, 0x0008, 0x000b];
// state/user.go:98-108 IsUIN: an all-digit screen name is an ICQ UIN.
const missingAccountError = (name: string): number => (name.length > 0 && /^\p{Nd}+$/u.test(name) ? 0x0008 : 0x0001);

const RATE_CLASSES = [
  { id: 1, window: 80, clear: 2500, alert: 2000, limit: 1500, disconnect: 800, max: 6000 },
  { id: 2, window: 80, clear: 3000, alert: 2000, limit: 1500, disconnect: 1000, max: 6000 },
  { id: 3, window: 20, clear: 5100, alert: 5000, limit: 4000, disconnect: 3000, max: 6000 },
  { id: 4, window: 20, clear: 5500, alert: 5300, limit: 4200, disconnect: 3000, max: 8000 },
  { id: 5, window: 10, clear: 5500, alert: 5300, limit: 4200, disconnect: 3000, max: 8000 },
];
const RATE_GROUPS: Record<number, [number, number][]> = {
  1: [[1, 0x02], [1, 0x04], [1, 0x06], [1, 0x08], [1, 0x0e], [1, 0x17], [1, 0x1f], [2, 0x04], [4, 0x02], [4, 0x10], [4, 0x14]],
  2: [[3, 0x04], [3, 0x05]],
  3: [[4, 0x06], [2, 0x05]],
  4: [],
  5: [],
};

function rateClassOf(family: number, subtype: number): number {
  for (const [id, pairs] of Object.entries(RATE_GROUPS)) {
    if (pairs.some(([f, s]) => f === family && s === subtype)) return Number(id);
  }
  return 0;
}

function rateRecord(id: number, current: number): Uint8Array {
  const c = RATE_CLASSES.find((r) => r.id === id) ?? RATE_CLASSES[0];
  if (!c) throw new Error('no rate class');
  return new ByteWriter().u16(c.id).u32(c.window).u32(c.clear).u32(c.alert).u32(c.limit).u32(c.disconnect).u32(current).u32(c.max).toBytes();
}

function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<BR>');
}

type User = { display: string; password: string; authKey: string; bot: boolean };
type Cookie = { name: string; service: 'bos'; flag: number; expires: number };
type Stored = { sender: string; cookie: bigint; channel: number; tlvs: Tlv[]; sentAt: number };
type Delivery = { cookie: bigint; channel: number; sender: FakeSession | null; senderName: string; tlvs: Tlv[] };

class Conn {
  kind: ConnKind = 'auth';
  name = '';
  display = '';
  readonly decoder = new FlapDecoder();
  private seq = 100;
  ignoreInput = false;

  constructor(readonly socket: net.Socket) {}

  flap(type: number, payload?: Uint8Array): void {
    if (this.socket.destroyed) return;
    this.socket.write(encodeFlap(type, this.seq, payload));
    this.seq = (this.seq + 1) & 0xffff;
  }

  snac(family: number, subtype: number, requestId: number, body?: Uint8Array): void {
    this.flap(2, encodeSnac({ family, subtype, requestId }, body));
  }

  // The real server writes this for an instance whose multi-conn flag is 0: no length field, then EOF.
  oldSignoff(): void {
    if (!this.socket.destroyed) this.socket.end(Uint8Array.of(0x2a, 0x04, this.seq >>> 8, this.seq & 0xff));
  }

  signoff(tlvs: Tlv[]): void {
    this.flap(4, encodeTlvs(tlvs));
    this.ignoreInput = true;
    this.socket.end();
  }
}

export type FakeSession = {
  ident: string;
  display: string;
  bot: boolean;
  conn: Conn | null;
  peer: FakePeer | null;
  flag: number;
  signonComplete: boolean;
  contactsInit: boolean;
  buddies: Set<string>;
  away: string | null;
  subscribed: Set<number>;
  limited: boolean;
  signonAt: number;
};

export class FakePeer {
  private readonly received: Delivery[] = [];

  constructor(
    private readonly server: FakeOscarServer,
    readonly name: string,
  ) {}

  sendIm(to: string, text: string, opts: { cookie?: bigint; charset?: 0 | 2 | 3; autoResponse?: boolean; html?: boolean } = {}): void {
    const html = opts.html ? text : escapeText(text);
    const charset = opts.charset ?? (isAscii(html) ? 0 : 2);
    let bytes: Buffer;
    if (charset === 2) {
      bytes = Buffer.from(html, 'utf16le');
      bytes.swap16();
    } else {
      // Charset 0 with non-ASCII text is what a TOC or web client produces: UTF-8 bytes labelled ASCII.
      bytes = Buffer.from(html, charset === 3 ? 'latin1' : 'utf8');
    }
    const tlvs = [tlv.bytes(0x02, encodeImFragments(charset, new Uint8Array(bytes)))];
    if (opts.autoResponse) tlvs.push(tlv.empty(0x04));
    this.server.routeIm(this.server.sessionOf(this.name), opts.cookie ?? newCookie(), 1, to, tlvs, null);
  }

  sendRaw(to: string, channel: number, tlvs: Tlv[], cookie: bigint = newCookie()): void {
    this.server.routeIm(this.server.sessionOf(this.name), cookie, channel, to, tlvs, null);
  }

  storeOfflineIm(to: string, text: string, ageSeconds: number): void {
    const tlvs = [tlv.bytes(0x02, encodeImFragments(0, new Uint8Array(Buffer.from(escapeText(text), 'utf8')))), tlv.empty(0x06)];
    this.server.store(normalizeScreenName(to), {
      sender: normalizeScreenName(this.name),
      cookie: newCookie(),
      channel: 1,
      tlvs,
      sentAt: Date.now() - ageSeconds * 1000,
    });
  }

  setAway(text: string | null): void {
    const session = this.server.sessionOf(this.name);
    if (!session) return;
    session.away = text;
    this.server.announce(session);
  }

  ims(): { from: string; text: string; storeTlv: boolean }[] {
    const stored = this.server.storedFor(this.name).map((m) => ({ cookie: m.cookie, channel: m.channel, sender: null, senderName: m.sender, tlvs: m.tlvs }));
    return [...this.received, ...stored]
      .filter((d) => d.channel === 1)
      .map((d) => ({
        from: d.senderName,
        text: decodeImFragments(findTlv(d.tlvs, 0x02) ?? new Uint8Array(0))
          .map((f) => fromWireText(f.text, f.charset))
          .join(''),
        storeTlv: hasTlv(d.tlvs, 0x06),
      }));
  }

  joinRoom(room: RoomRef): void {
    this.server.roomEngine.peerJoin(this.name, room);
  }

  leaveRoom(room: RoomRef): void {
    this.server.roomEngine.peerLeave(this.name, room);
  }

  say(room: RoomRef, text: string, opts?: { cookie?: bigint; whisperTo?: string; toc?: boolean }): void {
    this.server.roomEngine.peerSay(this.name, room, text, opts);
  }

  invite(to: string, room: RoomRef, text?: string): void {
    this.server.roomEngine.peerInvite(this.name, to, room, text);
  }

  roomLines(room: RoomRef): { from: string; text: string; whisper: boolean }[] {
    return this.server.roomEngine.peerLines(this.name, room);
  }

  deliver(d: Delivery): void {
    this.received.push(d);
  }

  signOff(): void {
    this.server.roomEngine.peerLeaveAll(this.name);
    this.server.removeSession(normalizeScreenName(this.name));
  }
}

export class FakeOscarServer {
  readonly generation: FakeGeneration;
  sslHost: boolean;
  private listenPort = 0;
  private caPath: string | undefined;
  private readonly opts: StartOptions;
  private server: net.Server | null = null;
  private readonly sockets = new Set<net.Socket>();
  private readonly users = new Map<string, User>();
  private readonly cookies = new Map<string, Cookie>();
  private readonly sessions = new Map<string, FakeSession>();
  private readonly offline = new Map<string, Stored[]>();
  private readonly heldAcks = new Map<string, (() => void)[]>();
  private readonly log = new Map<string, SnacRecord[]>();
  private readonly chatnav = new Set<Conn>();
  private limiter = { count: 0, windowStart: 0, bucp: false };
  private tmpDir: string | undefined;

  readonly roomEngine = new FakeRooms({
    generation: () => this.generation,
    advertised: () => this.advertised(),
    bosConn: (name) => this.wrap(this.sessions.get(name)?.conn ?? undefined),
    bosUserInfo: (name) => {
      const session = this.sessions.get(name);
      return session ? this.userInfo(session) : encodeUserInfo({ name, warning: 0, tlvs: [] });
    },
    sslState: (wantsSsl) => (wantsSsl && this.opts.tls && this.sslHost ? 0x02 : 0x00),
  });

  private readonly wrapped = new WeakMap<Conn, FakeConn>();

  private wrap(conn: Conn | undefined): FakeConn | undefined {
    if (!conn) return undefined;
    let out = this.wrapped.get(conn);
    if (!out) {
      out = {
        get kind() {
          return conn.kind;
        },
        get name() {
          return conn.name;
        },
        get display() {
          return conn.display;
        },
        send: (family, subtype, body, requestId = 0) => conn.snac(family, subtype, requestId, body),
        destroy: () => conn.socket.destroy(),
        // the four-byte signoff with no length field, which is how the server closes every room socket
        signoffBare: () => conn.oldSignoff(),
      };
      this.wrapped.set(conn, out);
    }
    return out;
  }

  addRoom(room: RoomRef): void {
    this.roomEngine.addRoom(room);
  }

  raceNextCreate(): void {
    this.roomEngine.raceNextCreate();
  }

  occupants(room: RoomRef): string[] {
    return this.roomEngine.occupants(room);
  }

  evictFromRoom(name: string, room: RoomRef): void {
    this.roomEngine.evict(name, room);
  }

  strayRateOnNextNav(): void {
    this.roomEngine.strayRateOnNextNav();
  }

  private constructor(opts: StartOptions) {
    this.opts = opts;
    this.generation = opts.generation ?? 'main';
    this.sslHost = opts.sslHost !== false;
  }

  static async start(opts: StartOptions = {}): Promise<FakeOscarServer> {
    const fake = new FakeOscarServer(opts);
    if (opts.tls) {
      fake.tmpDir = mkdtempSync(join(tmpdir(), 'fake-oscar-'));
      fake.caPath = join(fake.tmpDir, 'ca.pem');
      writeFileSync(fake.caPath, TEST_TLS_CERT);
    }
    await fake.listen(0);
    return fake;
  }

  get port(): number {
    return this.listenPort;
  }

  get caFile(): string | undefined {
    return this.caPath;
  }

  private listen(port: number): Promise<void> {
    const onSocket = (socket: net.Socket): void => this.accept(socket);
    this.server = this.opts.tls ? tls.createServer({ key: TEST_TLS_KEY, cert: TEST_TLS_CERT }, onSocket) : net.createServer(onSocket);
    return new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject);
      this.server?.listen(port, '127.0.0.1', () => {
        this.listenPort = (this.server?.address() as net.AddressInfo).port;
        resolve();
      });
    });
  }

  private closeListener(): Promise<void> {
    const server = this.server;
    this.server = null;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    return new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  }

  async restart(): Promise<void> {
    await this.closeListener();
    for (const [ident, session] of [...this.sessions]) if (session.conn) this.sessions.delete(ident);
    this.cookies.clear();
    this.roomEngine.reset();
    this.chatnav.clear();
    this.limiter = { count: 0, windowStart: 0, bucp: false };
    await this.listen(this.port);
  }

  async stop(): Promise<void> {
    await this.closeListener();
    if (this.tmpDir) rmSync(this.tmpDir, { recursive: true, force: true });
  }

  addUser(name: string, password: string, opts: { bot?: boolean } = {}): void {
    const ident = normalizeScreenName(name);
    this.users.set(ident, { display: name, password, authKey: `salt-${ident}`, bot: opts.bot ?? false });
  }

  peer(name: string): FakePeer {
    const ident = normalizeScreenName(name);
    const existing = this.sessions.get(ident)?.peer;
    if (existing) return existing;
    if (!this.users.has(ident)) this.addUser(name, 'peer-password');
    const peer = new FakePeer(this, name);
    const session = this.newSession(ident, null, peer, 3);
    session.signonComplete = true;
    this.sessions.set(ident, session);
    this.announce(session);
    return peer;
  }

  snacsFrom(name: string): SnacRecord[] {
    return [...(this.log.get(normalizeScreenName(name)) ?? [])];
  }

  kick(name: string): void {
    const session = this.sessions.get(normalizeScreenName(name));
    if (session?.conn) this.evict(session);
  }

  dropSocket(name: string, conn: 'bos' | 'chat', room?: RoomRef): void {
    if (conn === 'chat') {
      if (!room) throw new Error('dropSocket chat needs a room');
      this.roomEngine.dropChat(name, room);
      return;
    }
    this.sessions.get(normalizeScreenName(name))?.conn?.socket.destroy();
  }

  setRate(name: string, scope: 'bos' | RoomRef, status: 'clear' | 'limited', opts: { silent?: boolean } = {}): void {
    if (scope !== 'bos') {
      this.roomEngine.setRoomRate(name, scope, status, opts.silent === true);
      return;
    }
    const session = this.sessions.get(normalizeScreenName(name));
    if (!session) return;
    session.limited = status === 'limited';
    if (opts.silent || !session.subscribed.has(3)) return;
    const body = new ByteWriter()
      .u16(status === 'limited' ? 3 : 4)
      .bytes(rateRecord(3, status === 'limited' ? 3900 : 5100))
      .toBytes();
    // At v0.24.0 the notice goes out on whichever of the account's connections the dispatch loop is serving.
    const nav = this.generation === 'v0.24' ? [...this.chatnav].find((c) => c.name === session.ident) : undefined;
    (nav ?? session.conn)?.snac(1, 0x0a, SERVER_REQUEST_ID, body);
  }

  holdAcks(name: string): () => void {
    const ident = normalizeScreenName(name);
    const held: (() => void)[] = [];
    this.heldAcks.set(ident, held);
    return () => {
      this.heldAcks.delete(ident);
      for (const send of held) send();
    };
  }

  sessionOf(name: string): FakeSession | undefined {
    return this.sessions.get(normalizeScreenName(name));
  }

  storedFor(name: string): Stored[] {
    return this.offline.get(normalizeScreenName(name)) ?? [];
  }

  store(recipient: string, message: Stored): void {
    this.offline.set(recipient, [...(this.offline.get(recipient) ?? []), message]);
  }

  private newSession(ident: string, conn: Conn | null, peer: FakePeer | null, flag: number): FakeSession {
    const user = this.users.get(ident);
    return {
      ident,
      display: user?.display ?? ident,
      bot: user?.bot ?? false,
      conn,
      peer,
      flag,
      signonComplete: false,
      contactsInit: false,
      buddies: new Set(),
      away: null,
      subscribed: new Set(),
      limited: false,
      signonAt: Math.floor(Date.now() / 1000),
    };
  }

  private record(ident: string, snac: Snac, conn: ConnKind): void {
    this.log.set(ident, [...(this.log.get(ident) ?? []), { family: snac.family, subtype: snac.subtype, body: snac.body, conn }]);
  }

  private accept(socket: net.Socket): void {
    this.sockets.add(socket);
    socket.setNoDelay(true);
    const conn = new Conn(socket);
    let first = true;
    socket.on('error', () => {});
    socket.on('close', () => {
      this.sockets.delete(socket);
      this.chatnav.delete(conn);
      const link = this.wrapped.get(conn);
      if (link) this.roomEngine.detached(link);
      const session = this.sessions.get(conn.name);
      if (conn.kind === 'bos' && session?.conn === conn) this.removeSession(conn.name);
    });
    socket.on('data', (chunk: Buffer) => {
      if (conn.ignoreInput) return;
      try {
        for (const frame of conn.decoder.push(new Uint8Array(chunk))) {
          if (conn.ignoreInput) return;
          if (first) {
            first = false;
            this.onSignon(conn, decodeSignonPayload(frame.payload).tlvs);
          } else if (frame.type === 2) {
            this.onSnac(conn, decodeSnac(frame.payload));
          } else if (frame.type === 4) {
            socket.end();
          }
        }
      } catch {
        socket.destroy();
      }
    });
    conn.flap(1, encodeSignonPayload());
  }

  private userInfo(session: FakeSession): Uint8Array {
    const flags = 0x0010 | (session.away !== null ? 0x0020 : 0) | (session.bot ? 0x0400 : 0);
    return encodeUserInfo({ name: session.display, warning: 0, tlvs: [tlv.u16(0x01, flags), tlv.u32(0x03, session.signonAt)] });
  }

  private onSignon(conn: Conn, tlvs: Tlv[]): void {
    const cookieBytes = findTlv(tlvs, 0x06);
    if (cookieBytes) {
      this.onService(conn, cookieBytes);
      return;
    }
    const now = Date.now();
    if (now - this.limiter.windowStart > 60_000) this.limiter = { ...this.limiter, count: 0, windowStart: now };
    this.limiter.count++;
    if (this.limiter.count > (this.opts.loginLimit ?? 10)) {
      // Two shapes: an address already seen doing BUCP gets the SNAC, a first-time one gets a bare signoff.
      if (this.limiter.bucp) {
        conn.snac(0x17, 0x03, 0, encodeTlvs([tlv.u16(0x08, 0x001d)]));
        conn.ignoreInput = true;
        conn.socket.end();
      } else {
        conn.signoff([tlv.u16(0x08, 0x001d)]);
      }
      return;
    }
    if (hasTlv(tlvs, 0x01)) {
      conn.socket.destroy();
      return;
    }
    this.limiter.bucp = true;
  }

  // foodgroup/auth.go:566-574: a screen name that is a UIN and has no account gets
  // LoginErrICQUserErr (0x0008), every other missing name gets 0x0001.
  private onAuthSnac(conn: Conn, snac: Snac): void {
    const tlvs = decodeTlvs(snac.body);
    const name = tlvStr(tlvs, 0x01) ?? '';
    const ident = normalizeScreenName(name);
    conn.name = ident;
    this.record(ident, snac, 'auth');
    if (snac.family !== 0x17) {
      conn.socket.destroy();
      return;
    }
    if (snac.subtype === 0x06) {
      const user = this.users.get(ident);
      if (!user && !this.opts.disableAuth) {
        conn.snac(0x17, 0x03, snac.requestId, encodeTlvs([tlv.u16(0x08, missingAccountError(ident))]));
        conn.ignoreInput = true;
        conn.socket.end();
        return;
      }
      conn.snac(0x17, 0x07, snac.requestId, new ByteWriter().str16(user?.authKey ?? `stub-${randomBytes(8).toString('hex')}`).toBytes());
      return;
    }
    if (snac.subtype !== 0x02) {
      conn.socket.destroy();
      return;
    }
    const clientId = tlvStr(tlvs, 0x03) ?? '';
    // The 256-byte cookie cannot hold more; the real server drops the connection with no reply.
    if (Buffer.byteLength(name) + Buffer.byteLength(clientId) > 200) {
      conn.socket.destroy();
      return;
    }
    let user = this.users.get(ident);
    const fail = (code: number): void => {
      conn.snac(0x17, 0x03, snac.requestId, encodeTlvs([tlv.str(0x01, name), tlv.u16(0x08, code)]));
      conn.signoff([]);
    };
    if (!user) {
      if (!this.opts.disableAuth) return fail(missingAccountError(ident));
      this.addUser(name, 'welcome1');
      user = this.users.get(ident);
    }
    const hash = findTlv(tlvs, 0x25) ?? new Uint8Array(0);
    const good = user ? Buffer.from(strongHash(user.password, user.authKey)).equals(Buffer.from(hash)) : false;
    if (!this.opts.disableAuth && !good) return fail(0x0005);
    const cookie = new Uint8Array(randomBytes(256));
    this.cookies.set(Buffer.from(cookie).toString('hex'), {
      name,
      service: 'bos',
      flag: tlvU8(tlvs, 0x4a) ?? 0,
      expires: Date.now() + COOKIE_TTL_MS,
    });
    const ssl = this.opts.tls && this.generation === 'main' && this.sslHost ? 0x02 : 0x00;
    conn.snac(
      0x17,
      0x03,
      snac.requestId,
      encodeTlvs([tlv.str(0x01, name), tlv.str(0x05, this.advertised()), tlv.bytes(0x06, cookie), tlv.u8(0x8e, ssl)]),
    );
    conn.signoff([]);
  }

  private advertised(): string {
    return this.opts.advertisedHost ?? `127.0.0.1:${this.port}`;
  }

  private onService(conn: Conn, cookieBytes: Uint8Array): void {
    const ticket = this.roomEngine.claim(cookieBytes);
    if (ticket) {
      // kind and name are set before anything is recorded, so snacsFrom(name) labels these sockets
      conn.kind = ticket.kind;
      conn.name = ticket.name;
      conn.display = ticket.display;
      // P1a's setRate sends a v0.24 BOS notice to the account's open ChatNav connection
      if (ticket.kind === 'chatnav') this.chatnav.add(conn);
      const link = this.wrap(conn);
      if (link) this.roomEngine.attach(link, ticket);
      return;
    }
    const cookie = this.cookies.get(Buffer.from(cookieBytes).toString('hex'));
    if (!cookie || cookie.expires < Date.now()) {
      conn.socket.destroy();
      return;
    }
    const ident = normalizeScreenName(cookie.name);
    conn.name = ident;
    conn.kind = 'bos';
    const old = this.sessions.get(ident);
    if (old) this.evict(old);
    this.sessions.set(ident, this.newSession(ident, conn, null, cookie.flag));
    conn.display = this.sessions.get(ident)?.display ?? cookie.name;
    const families = new ByteWriter();
    for (const f of BOS_FAMILIES) families.u16(f);
    conn.snac(1, 0x03, SERVER_REQUEST_ID, families.toBytes());
  }

  private evict(session: FakeSession): void {
    const conn = session.conn;
    this.removeSession(session.ident);
    if (!conn) return;
    if (session.flag === 0) conn.oldSignoff();
    else conn.signoff([tlv.u8(0x09, 0x01), tlv.str(0x0b, 'https://github.com/mk6i/open-oscar-server')]);
  }

  removeSession(ident: string): void {
    const session = this.sessions.get(ident);
    if (!session) return;
    this.sessions.delete(ident);
    // the server closes every room of an account when its BOS session ends (RemoveUserFromAllChats)
    this.roomEngine.bosGone(ident);
    // Departure carries the name and one TLV, flags 0; the real server sends no more than that.
    const departed = encodeUserInfo({ name: session.display, warning: 0, tlvs: [tlv.u16(0x01, 0)] });
    for (const watcher of this.watchersOf(ident)) watcher.conn?.snac(3, 0x0c, SERVER_REQUEST_ID, departed);
  }

  private watchersOf(ident: string): FakeSession[] {
    return [...this.sessions.values()].filter((s) => s.conn && s.signonComplete && s.buddies.has(ident));
  }

  announce(session: FakeSession): void {
    if (!session.signonComplete) return;
    for (const watcher of this.watchersOf(session.ident)) watcher.conn?.snac(3, 0x0b, SERVER_REQUEST_ID, this.userInfo(session));
  }

  private arrivalsFor(session: FakeSession, names: Iterable<string>): void {
    for (const ident of names) {
      const buddy = this.sessions.get(ident);
      if (buddy?.signonComplete) session.conn?.snac(3, 0x0b, SERVER_REQUEST_ID, this.userInfo(buddy));
    }
  }

  private onSnac(conn: Conn, snac: Snac): void {
    if (conn.kind === 'auth') {
      this.onAuthSnac(conn, snac);
      return;
    }
    this.record(conn.name, snac, conn.kind);
    const link = this.wrap(conn);
    if (link && (conn.kind === 'chatnav' || conn.kind === 'chat')) {
      this.roomEngine.snac(link, snac.family, snac.subtype, snac.requestId, snac.body);
      return;
    }
    const session = this.sessions.get(conn.name);
    if (!session) return;
    const bos = conn.kind === 'bos' && session.conn === conn;
    // A limited SNAC is dropped with no reply of any kind.
    if (bos && session.limited && rateClassOf(snac.family, snac.subtype) === 3) return;
    const key = (snac.family << 16) | snac.subtype;
    switch (key) {
      case 0x0001_0017:
        conn.snac(1, 0x18, snac.requestId, snac.body);
        conn.snac(1, 0x13, SERVER_REQUEST_ID, new ByteWriter().u16(4).bytes(encodeTlvs([tlv.str(0x0b, 'Welcome')])).toBytes());
        return;
      case 0x0001_0006: {
        const w = new ByteWriter().u16(RATE_CLASSES.length);
        for (const c of RATE_CLASSES) w.bytes(rateRecord(c.id, c.max));
        for (const c of RATE_CLASSES) {
          const pairs = RATE_GROUPS[c.id] ?? [];
          w.u16(c.id).u16(pairs.length);
          for (const [f, s] of pairs) w.u16(f).u16(s);
        }
        conn.snac(1, 0x07, snac.requestId, w.toBytes());
        return;
      }
      case 0x0001_0008: {
        const r = new ByteReader(snac.body);
        while (r.remaining >= 2) session.subscribed.add(r.u16());
        return;
      }
      case 0x0001_000e:
        conn.snac(1, 0x0f, snac.requestId, this.userInfo(session));
        return;
      case 0x0001_001f:
        conn.snac(1, 0x20, snac.requestId);
        return;
      case 0x0001_0002:
        if (!bos) return;
        session.signonComplete = true;
        if (session.contactsInit) {
          this.arrivalsFor(session, session.buddies);
          this.announce(session);
        }
        conn.snac(0x0b, 0x02, SERVER_REQUEST_ID, new ByteWriter().u16(1).toBytes());
        if (this.storedFor(session.ident).length > 0) {
          const text = `You just received ${this.storedFor(session.ident).length} IM(s) while you were offline.`;
          this.deliverTo(session, {
            cookie: 0n,
            channel: 1,
            sender: null,
            senderName: SYSTEM_NAME,
            tlvs: [tlv.bytes(0x02, encodeImFragments(0, new Uint8Array(Buffer.from(text, 'utf8'))))],
          });
        }
        return;
      case 0x0001_0004:
        // one fake implementation of the service request, as there is one real one in src/oscar/session.ts
        if (bos && link) this.roomEngine.serviceRequest(link, snac.requestId, snac.body);
        return;
      case 0x0002_0004: {
        const tlvs = decodeTlvs(snac.body);
        const caps = findTlv(tlvs, 0x05);
        if (caps && caps.length % 16 !== 0) {
          conn.socket.destroy();
          return;
        }
        const away = findTlv(tlvs, 0x04);
        if (away) {
          session.away = away.length > 0 ? Buffer.from(away).toString('utf8') : null;
          this.announce(session);
        }
        return;
      }
      case 0x0003_0004:
      case 0x0003_0005: {
        const r = new ByteReader(snac.body);
        const names: string[] = [];
        while (r.remaining > 0) names.push(normalizeScreenName(r.str8()));
        if (snac.subtype === 0x05) {
          for (const n of names) session.buddies.delete(n);
          return;
        }
        for (const n of names) session.buddies.add(n);
        session.contactsInit = true;
        if (session.signonComplete) this.arrivalsFor(session, names);
        return;
      }
      case 0x0004_0002:
        if (snac.body.length < 16) conn.socket.destroy();
        return;
      case 0x0004_0006: {
        const r = new ByteReader(snac.body);
        const cookie = r.u64();
        const channel = r.u16();
        const to = r.str8();
        this.routeIm(session, cookie, channel, to, decodeTlvs(r.rest()), snac.requestId);
        return;
      }
      case 0x0004_0010: {
        conn.snac(4, 0x17, snac.requestId);
        const stored = this.storedFor(session.ident);
        // v0.24.0 relays replays by screen name, which needs a live instance, and deletes the queue regardless.
        if (this.generation === 'main' || session.signonComplete) {
          for (const m of stored) {
            const w = new ByteWriter().u64(m.cookie).u16(m.channel).bytes(encodeUserInfo({ name: m.sender, warning: 0, tlvs: [] }));
            const tlvs = [...m.tlvs.filter((t) => t.tag !== 0x16), tlv.u32(0x16, Math.floor(m.sentAt / 1000))];
            conn.snac(4, 0x07, SERVER_REQUEST_ID, w.bytes(encodeTlvs(tlvs)).toBytes());
          }
        }
        this.offline.delete(session.ident);
        return;
      }
      case 0x0004_0014:
        return;
      default:
        conn.snac(snac.family, 0x01, snac.requestId, new ByteWriter().u16(0x0001).toBytes());
    }
  }

  routeIm(sender: FakeSession | undefined, cookie: bigint, channel: number, to: string, tlvs: Tlv[], requestId: number | null): void {
    if (!sender) return;
    const reply = (subtype: number, body: Uint8Array): void => {
      if (requestId === null) return;
      const send = (): void => {
        sender.conn?.snac(4, subtype, requestId, body);
      };
      const held = this.heldAcks.get(sender.ident);
      if (held) held.push(send);
      else send();
    };
    const refuse = (extra: Tlv[] = []): void => reply(0x01, new ByteWriter().u16(0x0004).bytes(encodeTlvs(extra)).toBytes());
    const ack = (): void => {
      if (hasTlv(tlvs, 0x03)) reply(0x0c, new ByteWriter().u64(cookie).u16(channel).str8(to).toBytes());
    };
    // A channel 2 message whose TLV 0x05 is under 26 bytes is a handler error: the sender's connection drops.
    if (channel === 2 && (findTlv(tlvs, 0x05)?.length ?? 0) < 26) {
      sender.conn?.socket.destroy();
      return;
    }
    const ident = normalizeScreenName(to);
    const recipient = this.sessions.get(ident);
    if (!recipient?.signonComplete) {
      if (!hasTlv(tlvs, 0x06) || !this.users.has(ident)) return refuse();
      const fromSender = this.storedFor(ident).filter((m) => m.sender === sender.ident).length;
      if (fromSender >= OFFLINE_CAP) return refuse([tlv.u16(0x08, 0x000f)]);
      this.store(ident, { sender: sender.ident, cookie, channel, tlvs, sentAt: Date.now() });
      return ack();
    }
    // Host ack is stripped everywhere; store and send time only on main. v0.24.0 forwards them to the recipient.
    const strip = this.generation === 'main' ? [0x03, 0x06, 0x16] : [0x03];
    this.deliverTo(recipient, { cookie, channel, sender, senderName: sender.display, tlvs: tlvs.filter((t) => !strip.includes(t.tag)) });
    ack();
  }

  private deliverTo(recipient: FakeSession, d: Delivery): void {
    if (recipient.peer) {
      recipient.peer.deliver(d);
      return;
    }
    const w = new ByteWriter().u64(d.cookie).u16(d.channel);
    w.bytes(d.sender ? this.userInfo(d.sender) : encodeUserInfo({ name: d.senderName, warning: 0, tlvs: [] }));
    recipient.conn?.snac(4, 0x07, SERVER_REQUEST_ID, w.bytes(encodeTlvs(d.tlvs)).toBytes());
  }
}
