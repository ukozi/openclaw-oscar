import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const OOS_BIN = process.env.OOS_BIN ?? '';
export const liveEnabled = OOS_BIN.length > 0;

export type LiveServer = {
  host: string;
  port: number;
  tocPort: number;
  apiBase: string;
  createUser(name: string, password: string, opts?: { bot?: boolean }): Promise<void>;
  createPublicRoom(name: string): Promise<void>;
  logs(): string;
  stop(): Promise<void>;
};

const HOST = '127.0.0.1';
const READY_TIMEOUT_MS = 20_000;
const STOP_TIMEOUT_MS = 6_000;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, HOST, () => {
      const address = probe.address();
      probe.close(() => {
        if (address && typeof address === 'object') resolve(address.port);
        else reject(new Error('no port assigned'));
      });
    });
  });
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, HOST);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function startLiveServer(launch: { bin: string; args?: string[] } = { bin: OOS_BIN }): Promise<LiveServer> {
  if (launch.bin.length === 0) throw new Error('OOS_BIN is not set');
  const [port, tocPort, apiPort] = await Promise.all([freePort(), freePort(), freePort()]);
  const dir = await mkdtemp(path.join(tmpdir(), 'oos-live-'));
  let output = '';
  // the binary reads ./settings.env when it exists, so it runs in an empty directory with every key given here
  const child: ChildProcess = spawn(launch.bin, [...(launch.args ?? []), '-config', path.join(dir, 'unused.env')], {
    cwd: dir,
    env: {
      PATH: process.env.PATH ?? '',
      OSCAR_LISTENERS: `LOCAL://${HOST}:${port}`,
      OSCAR_ADVERTISED_LISTENERS_PLAIN: `LOCAL://${HOST}:${port}`,
      TOC_LISTENERS: `${HOST}:${tocPort}`,
      API_LISTENER: `${HOST}:${apiPort}`,
      DB_PATH: path.join(dir, 'oscar.sqlite'),
      DISABLE_AUTH: 'false',
      DISABLE_MULTI_LOGIN_NOTIF: 'true',
      LOG_LEVEL: 'debug',
      ICQ_LEGACY_ENABLED: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  let exited = false;
  const exit = new Promise<void>((resolve) => {
    child.once('exit', () => {
      exited = true;
      resolve();
    });
    // a binary that cannot be spawned at all emits 'error' and never 'exit', and an unheard 'error' throws
    child.once('error', (err: Error) => {
      output += `${err.message}\n`;
      exited = true;
      resolve();
    });
  });

  const api = `http://${HOST}:${apiPort}`;
  const stop = async (): Promise<void> => {
    if (!exited) {
      child.kill('SIGTERM');
      await Promise.race([exit, sleep(STOP_TIMEOUT_MS)]);
      if (!exited) child.kill('SIGKILL');
      await exit;
    }
    await rm(dir, { recursive: true, force: true });
  };

  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    if (exited) {
      await stop();
      throw new Error(`the server exited during start-up:\n${output}`);
    }
    const apiUp = await fetch(`${api}/version`).then((r) => r.ok, () => false);
    if (apiUp && (await canConnect(port)) && (await canConnect(tocPort))) break;
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`the server did not come up in ${READY_TIMEOUT_MS} ms:\n${output}`);
    }
    await sleep(100);
  }

  const call = async (method: string, route: string, body: unknown, accepted: number[]): Promise<void> => {
    const res = await fetch(`${api}${route}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!accepted.includes(res.status)) throw new Error(`${method} ${route} answered ${res.status}: ${await res.text()}`);
  };

  return {
    host: HOST,
    port,
    tocPort,
    apiBase: api,
    async createUser(name, password, opts = {}) {
      await call('POST', '/user', { screen_name: name, password }, [201, 409]);
      if (opts.bot) await call('PATCH', `/user/${encodeURIComponent(name)}/account`, { is_bot: true }, [204, 304]);
    },
    async createPublicRoom(name) {
      await call('POST', '/chat/room/public', { name }, [201, 409]);
    },
    logs: () => output,
    stop,
  };
}
