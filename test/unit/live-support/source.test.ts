import * as net from 'node:net';
import { describe, expect, it } from 'vitest';
import { connectUpstream, nextSourceAddress, sourceRotationAvailable } from '../../live/support/source.js';

describe('source addresses', () => {
  it('walks 127.0.1.1 to 127.0.1.250 and wraps', () => {
    const seen = Array.from({ length: 251 }, () => nextSourceAddress());
    expect(new Set(seen.slice(0, 250)).size).toBe(250);
    expect(seen.every((a) => /^127\.0\.1\.(?:[1-9]|[1-9]\d|1\d\d|2[0-4]\d|250)$/.test(a))).toBe(true);
    expect(seen[250]).toBe(seen[0]);
  });

  it('connects either way, from a rotated address where the host allows it', async () => {
    const remotes: string[] = [];
    const server = net.createServer((socket) => {
      remotes.push(socket.remoteAddress ?? '');
      socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as net.AddressInfo).port;
    for (let i = 0; i < 3; i += 1) {
      const socket = await connectUpstream('127.0.0.1', port);
      await new Promise<void>((resolve) => socket.once('close', () => resolve()));
    }
    server.close();
    expect(remotes).toHaveLength(3);
    if (await sourceRotationAvailable()) expect(new Set(remotes).size).toBe(3);
    else expect(new Set(remotes)).toEqual(new Set(['127.0.0.1']));
  });
});
