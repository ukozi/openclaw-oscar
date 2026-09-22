import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as tls from 'node:tls';
import { connectUpstream } from './source.js';

export type TestCa = { caFile: string; certFile: string; keyFile: string };

export function opensslAvailable(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function makeTestCa(): TestCa {
  const dir = mkdtempSync(join(tmpdir(), 'oscar-ca-'));
  const p = (name: string) => join(dir, name);
  writeFileSync(p('ca.cnf'), [
    '[req]', 'distinguished_name=dn', 'x509_extensions=v3_ca', 'prompt=no',
    '[dn]', 'CN=openclaw-oscar test CA',
    '[v3_ca]', 'basicConstraints=critical,CA:TRUE', 'keyUsage=critical,keyCertSign,cRLSign', 'subjectKeyIdentifier=hash', '',
  ].join('\n'));
  writeFileSync(p('leaf.cnf'), ['[req]', 'distinguished_name=dn', 'prompt=no', '[dn]', 'CN=localhost', ''].join('\n'));
  writeFileSync(p('leaf.ext'), [
    'basicConstraints=CA:FALSE', 'keyUsage=critical,digitalSignature,keyEncipherment',
    'extendedKeyUsage=serverAuth', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '',
  ].join('\n'));
  const run = (args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
  run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '3', '-config', 'ca.cnf']);
  run(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'leaf.key', '-out', 'leaf.csr', '-config', 'leaf.cnf']);
  run(['x509', '-req', '-in', 'leaf.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'leaf.pem', '-days', '3', '-extfile', 'leaf.ext']);
  return { caFile: p('ca.pem'), certFile: p('leaf.pem'), keyFile: p('leaf.key') };
}

export class TlsProxy {
  readonly port: number;
  private accepted = 0;
  private readonly sockets = new Set<net.Socket>();
  private readonly server: tls.Server;

  private constructor(server: tls.Server, port: number) {
    this.server = server;
    this.port = port;
  }

  static start(opts: { ca: TestCa; targetHost: string; targetPort: number }): Promise<TlsProxy> {
    return new Promise((resolve, reject) => {
      let proxy: TlsProxy;
      const server = tls.createServer(
        { key: readFileSync(opts.ca.keyFile), cert: readFileSync(opts.ca.certFile), minVersion: 'TLSv1.2' },
        (client) => {
          proxy.accepted += 1;
          proxy.sockets.add(client);
          client.on('error', () => client.destroy());
          void connectUpstream(opts.targetHost, opts.targetPort).then((upstream) => {
            proxy.sockets.add(upstream);
            const close = () => {
              client.destroy();
              upstream.destroy();
              proxy.sockets.delete(client);
              proxy.sockets.delete(upstream);
            };
            upstream.on('error', close);
            upstream.on('close', close);
            client.on('close', close);
            client.pipe(upstream);
            upstream.pipe(client);
          });
        },
      );
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        proxy = new TlsProxy(server, (server.address() as net.AddressInfo).port);
        resolve(proxy);
      });
    });
  }

  connections(): number {
    return this.accepted;
  }

  stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}
