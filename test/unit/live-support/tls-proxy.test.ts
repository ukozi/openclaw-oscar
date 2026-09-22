import { readFileSync } from 'node:fs';
import * as net from 'node:net';
import * as tls from 'node:tls';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTestCa, opensslAvailable, TlsProxy } from '../../live/support/tls-proxy.js';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function dial(port: number, ca?: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: 'localhost', port, ...(ca ? { ca } : {}) }, () => socket.write('hi'));
    socket.on('data', (d) => {
      resolve(d.toString());
      socket.destroy();
    });
    socket.on('error', reject);
  });
}

describe.skipIf(!opensslAvailable())('tls proxy', () => {
  it('terminates TLS with a certificate the test CA signed', async () => {
    const ca = makeTestCa();
    const echo = net.createServer((s) => {
      s.on('error', () => {});
      s.on('data', (d: Buffer) => s.write(Buffer.concat([Buffer.from('echo:'), d])));
    });
    await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', () => resolve()));
    const proxy = await TlsProxy.start({ ca, targetHost: '127.0.0.1', targetPort: (echo.address() as net.AddressInfo).port });
    cleanups.push(() => proxy.stop(), () => { echo.close(); });

    expect(await dial(proxy.port, readFileSync(ca.caFile))).toBe('echo:hi');
    expect(proxy.connections()).toBe(1);
  });

  it('is refused by a client that does not trust the test CA', async () => {
    const ca = makeTestCa();
    const proxy = await TlsProxy.start({ ca, targetHost: '127.0.0.1', targetPort: 9 });
    cleanups.push(() => proxy.stop());
    await expect(dial(proxy.port)).rejects.toThrow(/certificate|verify|signature/i);
  });
});
