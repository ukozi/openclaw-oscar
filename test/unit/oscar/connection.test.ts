import { mkdtempSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';
import { afterEach, describe, expect, it } from 'vitest';
import { fromHex, toHex } from '../../../src/oscar/bytes.js';
import { ConnectionClosedError, RequestTimeoutError, isTlsError, openConnection } from '../../../src/oscar/connection.js';
import type { CloseInfo, OscarConnection } from '../../../src/oscar/connection.js';
import { FlapDecoder, encodeFlap } from '../../../src/oscar/flap.js';
import type { FlapFrame } from '../../../src/oscar/flap.js';
import { decodeSnac, encodeSnac } from '../../../src/oscar/snac.js';
import { ManualTimers, captureLog, waitFor } from '../../fake/oscar-client.js';
import { TEST_TLS_CERT, TEST_TLS_KEY } from '../../fake/tls-fixture.js';

const SERVER_SIGNON = fromHex('2a010064000400000001');

type Script = { server: net.Server; port: number; frames: FlapFrame[]; sockets: net.Socket[] };
const open: Script[] = [];

async function listen(onConnect: (s: net.Socket) => void, secure = false): Promise<Script> {
  const script: Script = { server: null as unknown as net.Server, port: 0, frames: [], sockets: [] };
  const handler = (socket: net.Socket): void => {
    script.sockets.push(socket);
    const decoder = new FlapDecoder();
    socket.on('data', (chunk) => {
      try {
        script.frames.push(...decoder.push(new Uint8Array(chunk)));
      } catch {
        socket.destroy();
      }
    });
    socket.on('error', () => {});
    onConnect(socket);
  };
  script.server = secure ? tls.createServer({ key: TEST_TLS_KEY, cert: TEST_TLS_CERT }, handler) : net.createServer(handler);
  await new Promise<void>((resolve) => script.server.listen(0, '127.0.0.1', resolve));
  script.port = (script.server.address() as net.AddressInfo).port;
  open.push(script);
  return script;
}

afterEach(async () => {
  for (const s of open.splice(0)) {
    for (const socket of s.sockets) socket.destroy();
    await new Promise((resolve) => s.server.close(resolve));
  }
});

function connect(port: number, timers: ManualTimers, extra: { tls?: boolean; caFile?: string; host?: string; cookie?: Uint8Array } = {}) {
  return openConnection({
    host: extra.host ?? '127.0.0.1',
    port,
    tls: extra.tls ?? false,
    caFile: extra.caFile,
    cookie: extra.cookie,
    label: 'test',
    log: captureLog().log,
    timers: timers.api,
  });
}

function closeOf(conn: OscarConnection): { info: () => CloseInfo | null } {
  let info: CloseInfo | null = null;
  conn.onClose((i) => (info = i));
  return { info: () => info };
}

describe('OscarConnection', () => {
  it('answers the server signon with its own, then numbers its frames', async () => {
    const script = await listen((s) => s.write(SERVER_SIGNON));
    const conn = await connect(script.port, new ManualTimers());
    expect(conn.send(0x0001, 0x000e, undefined, 7)).toBe(7);
    expect(conn.send(0x0001, 0x000e)).toBe(1);
    await waitFor(() => script.frames.length === 3, 'three frames');
    expect(script.frames.map((f) => [f.type, f.seq])).toEqual([[1, 0], [2, 1], [2, 2]]);
    expect(toHex(script.frames[0]?.payload ?? new Uint8Array())).toBe('00000001');
    expect(decodeSnac(script.frames[1]?.payload ?? new Uint8Array())).toMatchObject({ family: 1, subtype: 0x0e, requestId: 7 });
    conn.destroy();
  });

  it('puts a service cookie in its signon', async () => {
    const script = await listen((s) => s.write(SERVER_SIGNON));
    const conn = await connect(script.port, new ManualTimers(), { cookie: fromHex('deadbeef') });
    await waitFor(() => script.frames.length === 1, 'signon');
    expect(toHex(script.frames[0]?.payload ?? new Uint8Array())).toBe('0000000100060004deadbeef');
    conn.destroy();
  });

  it('fails to open when the server never sends a signon', async () => {
    const script = await listen(() => {});
    const timers = new ManualTimers();
    const opening = connect(script.port, timers);
    const failed = expect(opening).rejects.toThrow('connect timeout');
    await waitFor(() => script.sockets.length === 1, 'socket');
    await timers.advance(20_000);
    await failed;
  });

  it('reads the truncated four-byte signoff as a clean signoff', async () => {
    const script = await listen((s) => s.write(SERVER_SIGNON));
    const conn = await connect(script.port, new ManualTimers());
    const closed = closeOf(conn);
    script.sockets[0]?.end(fromHex('2a040065'));
    await waitFor(() => closed.info() !== null, 'close');
    expect(closed.info()).toEqual({ kind: 'signoff', clean: true, tlvs: [], truncated: true });
  });

  it('reads a signoff frame with TLVs', async () => {
    const script = await listen((s) => s.write(SERVER_SIGNON));
    const conn = await connect(script.port, new ManualTimers());
    const closed = closeOf(conn);
    script.sockets[0]?.end(encodeFlap(4, 101, fromHex('0009000101')));
    await waitFor(() => closed.info() !== null, 'close');
    expect(closed.info()).toEqual({ kind: 'signoff', clean: true, tlvs: [{ tag: 9, value: fromHex('01') }], truncated: false });
  });

  it('reports a bare EOF and a mid-frame EOF differently', async () => {
    const script = await listen((s) => s.write(SERVER_SIGNON));
    const a = await connect(script.port, new ManualTimers());
    const closedA = closeOf(a);
    script.sockets[0]?.end();
    await waitFor(() => closedA.info() !== null, 'close a');
    expect(closedA.info()).toEqual({ kind: 'eof', clean: false });

    const b = await connect(script.port, new ManualTimers());
    const closedB = closeOf(b);
    script.sockets[1]?.end(fromHex('2a0200660010'));
    await waitFor(() => closedB.info() !== null, 'close b');
    expect(closedB.info()).toMatchObject({ kind: 'error', clean: false });
  });

  it('resolves a request with the SNAC that echoes its id, and shows every SNAC to listeners', async () => {
    const script = await listen((s) => s.write(SERVER_SIGNON));
    const conn = await connect(script.port, new ManualTimers());
    const seen: number[] = [];
    conn.onSnac((s) => seen.push(s.subtype));
    const reply = conn.request(0x0001, 0x0006);
    await waitFor(() => script.frames.length === 2, 'request');
    const id = decodeSnac(script.frames[1]?.payload ?? new Uint8Array()).requestId;
    const socket = script.sockets[0];
    socket?.write(encodeFlap(2, 101, encodeSnac({ family: 1, subtype: 0x13, requestId: 0x80000000 })));
    socket?.write(encodeFlap(2, 102, encodeSnac({ family: 1, subtype: 0x07, requestId: id })));
    expect((await reply).subtype).toBe(0x07);
    expect(seen).toEqual([0x13, 0x07]);
    conn.destroy();
  });

  it('skips a malformed SNAC and keeps the connection', async () => {
    const script = await listen((s) => s.write(SERVER_SIGNON));
    const conn = await connect(script.port, new ManualTimers());
    const seen: number[] = [];
    conn.onSnac((s) => seen.push(s.subtype));
    script.sockets[0]?.write(encodeFlap(2, 101, fromHex('0001')));
    script.sockets[0]?.write(encodeFlap(2, 102, encodeSnac({ family: 1, subtype: 0x0f, requestId: 1 })));
    await waitFor(() => seen.length === 1, 'snac');
    expect(conn.isOpen).toBe(true);
    conn.destroy();
  });

  it('times a request out and rejects pending requests on close', async () => {
    const script = await listen((s) => s.write(SERVER_SIGNON));
    const timers = new ManualTimers();
    const conn = await connect(script.port, timers);
    const slow = expect(conn.request(1, 6, undefined, 5000)).rejects.toBeInstanceOf(RequestTimeoutError);
    await timers.advance(5000);
    await slow;
    const cut = expect(conn.request(1, 6)).rejects.toBeInstanceOf(ConnectionClosedError);
    conn.destroy();
    await cut;
    await expect(conn.request(1, 6)).rejects.toBeInstanceOf(ConnectionClosedError);
  });

  it('sends a FLAP keepalive every 60 s and a user-info query, never the fatal probe, every 90 s', async () => {
    const script = await listen((s) => s.write(SERVER_SIGNON));
    const timers = new ManualTimers();
    const conn = await connect(script.port, timers);
    await timers.advance(59_999);
    await waitFor(() => script.frames.length === 1, 'signon only');
    await timers.advance(1);
    await waitFor(() => script.frames.length === 2, 'keepalive');
    expect(script.frames[1]).toMatchObject({ type: 5, payload: new Uint8Array(0) });
    await timers.advance(30_000);
    await waitFor(() => script.frames.length === 3, 'probe');
    expect(decodeSnac(script.frames[2]?.payload ?? new Uint8Array())).toMatchObject({ family: 1, subtype: 0x0e });
    conn.destroy();
    expect(timers.pending()).toEqual([]);
  });

  it('destroys the socket when the liveness request goes unanswered for 20 s', async () => {
    const script = await listen((s) => s.write(SERVER_SIGNON));
    const timers = new ManualTimers();
    const conn = await connect(script.port, timers);
    const closed = closeOf(conn);
    await timers.advance(90_000);
    await timers.advance(19_999);
    expect(closed.info()).toBeNull();
    await timers.advance(1);
    expect(closed.info()).toEqual({ kind: 'probe-timeout', clean: false });
  });

  it('counts any SNAC echoing the liveness id as alive, an error reply included', async () => {
    const script = await listen((s) => s.write(SERVER_SIGNON));
    const timers = new ManualTimers();
    const conn = await connect(script.port, timers);
    const closed = closeOf(conn);
    const seen: number[] = [];
    conn.onSnac((s) => seen.push(s.subtype));
    await timers.advance(90_000);
    await waitFor(() => script.frames.some((f) => f.type === 2), 'liveness request');
    const probe = script.frames.find((f) => f.type === 2);
    const id = decodeSnac(probe?.payload ?? new Uint8Array()).requestId;
    script.sockets[0]?.write(encodeFlap(2, 101, encodeSnac({ family: 1, subtype: 0x01, requestId: id }, fromHex('0001'))));
    await waitFor(() => timers.pending().length === 2, 'probe deadline cleared');
    await timers.advance(25_000);
    expect(closed.info()).toBeNull();
    expect(seen).toEqual([0x01]);
    conn.destroy();
  });

  it('close() writes a FLAP signoff and reports a clean local close, once', async () => {
    const script = await listen((s) => s.write(SERVER_SIGNON));
    const conn = await connect(script.port, new ManualTimers());
    const seen: CloseInfo[] = [];
    conn.onClose((i) => seen.push(i));
    conn.close();
    conn.close();
    await waitFor(() => script.frames.length === 2, 'signoff frame');
    expect(script.frames[1]).toMatchObject({ type: 4, seq: 1 });
    expect(seen).toEqual([{ kind: 'local', clean: true }]);
    const late: CloseInfo[] = [];
    conn.onClose((i) => late.push(i));
    expect(late).toEqual([{ kind: 'local', clean: true }]);
  });

  it('has the five calls room code makes on a connection', async () => {
    const script = await listen((s) => s.write(SERVER_SIGNON));
    const conn = await connect(script.port, new ManualTimers());
    for (const name of ['send', 'request', 'onSnac', 'onClose', 'close'] as const) expect(typeof conn[name]).toBe('function');
    conn.destroy();
  });

  it('connects over TLS with a private CA file and refuses without it', async () => {
    const script = await listen((s) => s.write(SERVER_SIGNON), true);
    const caFile = join(mkdtempSync(join(tmpdir(), 'oscar-ca-')), 'ca.pem');
    writeFileSync(caFile, TEST_TLS_CERT);
    const conn = await connect(script.port, new ManualTimers(), { tls: true, caFile });
    expect(conn.isOpen).toBe(true);
    conn.destroy();
    const byName = await connect(script.port, new ManualTimers(), { tls: true, caFile, host: 'localhost' });
    byName.destroy();
    const err = await connect(script.port, new ManualTimers(), { tls: true }).catch((e: unknown) => e);
    expect(isTlsError(err)).toBe(true);
  });

  it('reports TLS aimed at a plaintext port as a TLS error', async () => {
    const script = await listen((s) => s.write(SERVER_SIGNON));
    const err = await connect(script.port, new ManualTimers(), { tls: true }).catch((e: unknown) => e);
    expect(isTlsError(err)).toBe(true);
  });
});
