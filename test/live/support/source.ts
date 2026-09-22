import * as net from 'node:net';

let next = 0;
let available: boolean | undefined;

// OOS limits auth connections to 10 per minute per source IP. Linux routes all of 127/8 to
// loopback, so each upstream connection can come from its own address there. macOS cannot.
export async function sourceRotationAvailable(): Promise<boolean> {
  if (available !== undefined) return available;
  available = await new Promise<boolean>((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(0, '127.0.1.1', () => probe.close(() => resolve(true)));
  });
  return available;
}

export function nextSourceAddress(): string {
  next = (next % 250) + 1;
  return `127.0.1.${next}`;
}

export async function connectUpstream(host: string, port: number): Promise<net.Socket> {
  const rotate = host === '127.0.0.1' && (await sourceRotationAvailable());
  return net.connect(rotate ? { host, port, localAddress: nextSourceAddress() } : { host, port });
}
