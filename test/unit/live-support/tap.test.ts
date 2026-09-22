import * as net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { imCookieOf, imRecipientOf, Tap } from '../../live/support/tap.js';
import { sleep, until } from '../../live/support/wait.js';

function flap(channel: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt8(0x2a, 0);
  header.writeUInt8(channel, 1);
  header.writeUInt16BE(1, 2);
  header.writeUInt16BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

function snac(family: number, subtype: number, body: string): Buffer {
  const header = Buffer.alloc(10);
  header.writeUInt16BE(family, 0);
  header.writeUInt16BE(subtype, 2);
  header.writeUInt32BE(7, 6);
  return flap(2, Buffer.concat([header, Buffer.from(body, 'latin1')]));
}

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function rig(): Promise<{ tap: Tap; client: net.Socket; seen: () => string }> {
  const chunks: Buffer[] = [];
  const sink = net.createServer((socket) => {
    socket.on('error', () => {});
    socket.on('data', (d: Buffer) => chunks.push(d));
  });
  await new Promise<void>((resolve) => sink.listen(0, '127.0.0.1', () => resolve()));
  const tap = await Tap.start({ targetHost: '127.0.0.1', targetPort: (sink.address() as net.AddressInfo).port });
  const client = net.connect(tap.port, '127.0.0.1');
  client.on('error', () => {});
  await new Promise<void>((resolve) => client.once('connect', () => resolve()));
  cleanups.push(() => { client.destroy(); }, () => tap.stop(), () => { sink.close(); });
  return { tap, client, seen: () => Buffer.concat(chunks).toString('latin1') };
}

describe('tap', () => {
  it('forwards frames that arrive split across writes', async () => {
    const { tap, client, seen } = await rig();
    const frame = snac(4, 6, 'first');
    client.write(frame.subarray(0, 9));
    await sleep(20);
    client.write(frame.subarray(9));
    await until(() => seen().includes('first'), { timeoutMs: 1000, what: 'the frame upstream' });
    expect(tap.framesToServer().map((f) => [f.channel, f.family, f.subtype])).toEqual([[2, 4, 6]]);
  });

  it('drops only the next matching frame', async () => {
    const { tap, client, seen } = await rig();
    tap.dropNext((f) => f.family === 4 && f.subtype === 6);
    client.write(Buffer.concat([snac(4, 6, 'lost'), snac(4, 6, 'kept'), snac(4, 0x14, 'typing')]));
    await until(() => seen().includes('typing'), { timeoutMs: 1000, what: 'later frames upstream' });
    expect(seen()).not.toContain('lost');
    expect(seen()).toContain('kept');
    expect(tap.framesToServer()).toHaveLength(3);
  });

  it('reads who an IM frame is addressed to', async () => {
    const { tap, client, seen } = await rig();
    const im = `${'\u0001'.repeat(8)}\u0000\u0001\u0008Mal Lory and the rest`;
    client.write(Buffer.concat([snac(4, 6, im), snac(4, 0x14, 'typing')]));
    await until(() => seen().includes('typing'), { timeoutMs: 1000, what: 'both frames upstream' });
    expect(tap.framesToServer().map(imRecipientOf)).toEqual(['mallory', null]);
    expect(tap.framesToServer().map(imCookieOf)).toEqual(['0101010101010101', null]);
  });

  it('holds traffic while frozen and releases it on thaw', async () => {
    const { tap, client, seen } = await rig();
    tap.freeze();
    client.write(snac(1, 2, 'frozen'));
    await sleep(80);
    expect(seen()).not.toContain('frozen');
    expect(tap.open()).toBe(1);
    tap.thaw();
    await until(() => seen().includes('frozen'), { timeoutMs: 1000, what: 'the held frame' });
  });

  it('severs both sides without a sign-off', async () => {
    const { tap, client, seen } = await rig();
    let closed = false;
    client.on('close', () => { closed = true; });
    client.write(snac(1, 2, 'hello'));
    await until(() => seen().includes('hello'), { timeoutMs: 1000, what: 'the connection to be up' });
    tap.severAll();
    await until(() => closed, { timeoutMs: 1000, what: 'the client socket to close' });
    expect(tap.connections()).toBe(1);
    expect(tap.open()).toBe(0);
  });
});
