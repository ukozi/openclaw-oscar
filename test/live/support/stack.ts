import type { LiveEnv } from './env.js';
import { freePorts, Oos } from './oos.js';
import { Tap } from './tap.js';
import { makeTestCa, TlsProxy, type TestCa } from './tls-proxy.js';

export type ClientTarget = { host: string; port: number; tls: boolean; caFile?: string };
export type Stack = {
  oos: Oos;
  target: ClientTarget;
  tap: Tap | null;
  advertisedTap: Tap;
  tlsProxy: TlsProxy | null;
  advertisedTlsProxy: TlsProxy | null;
  ca: TestCa | null;
  stop(): Promise<void>;
};

// v0.24.0 has no SSL listener: the TLS proxy feeds its plain listener, and the server still advertises a
// plaintext address. With advertise 'same' the server advertises the address the client already dials, so
// a session that follows the redirect stays on the one tap.
export async function startStack(
  env: Extract<LiveEnv, { mode: 'local' }>,
  opts: { tls?: boolean; disableAuth?: boolean; advertise?: 'same' | 'separate' } = {},
): Promise<Stack> {
  const [oscar, ssl, toc, api] = (await freePorts(4)) as [number, number, number, number];
  const separate = opts.advertise === 'separate';
  let tap: Tap | null = null;
  let advertisedTap: Tap;
  let tlsProxy: TlsProxy | null = null;
  let advertisedTlsProxy: TlsProxy | null = null;
  let ca: TestCa | null = null;
  let target: ClientTarget;
  if (opts.tls) {
    ca = makeTestCa();
    const decryptedPort = env.generation === 'main' ? ssl : oscar;
    tlsProxy = await TlsProxy.start({ ca, targetHost: '127.0.0.1', targetPort: decryptedPort });
    advertisedTlsProxy = separate ? await TlsProxy.start({ ca, targetHost: '127.0.0.1', targetPort: decryptedPort }) : tlsProxy;
    advertisedTap = await Tap.start({ targetHost: '127.0.0.1', targetPort: oscar });
    target = { host: 'localhost', port: tlsProxy.port, tls: true, caFile: ca.caFile };
  } else {
    tap = await Tap.start({ targetHost: '127.0.0.1', targetPort: oscar });
    advertisedTap = separate ? await Tap.start({ targetHost: '127.0.0.1', targetPort: oscar }) : tap;
    target = { host: '127.0.0.1', port: tap.port, tls: false };
  }
  const oos = await Oos.start({
    bin: env.bin,
    generation: env.generation,
    ports: { oscar, ssl, toc, api },
    advertisedPort: advertisedTap.port,
    ...(advertisedTlsProxy ? { ssl: { advertisedPort: advertisedTlsProxy.port } } : {}),
    ...(opts.disableAuth ? { disableAuth: true } : {}),
  });
  return {
    oos, target, tap, advertisedTap, tlsProxy, advertisedTlsProxy, ca,
    async stop() {
      for (const part of new Set([tap, advertisedTap, tlsProxy, advertisedTlsProxy])) await part?.stop();
      await oos.stop();
    },
  };
}
