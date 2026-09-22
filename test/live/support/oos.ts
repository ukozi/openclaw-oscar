import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Generation } from './env.js';
import { until } from './wait.js';

export type LoggedRequest = { screenName: string; family: number; subtype: number; line: string };
export type OosPorts = { oscar: number; ssl: number; toc: number; api: number };
export type OosOptions = {
  bin: string; generation: Generation; ports: OosPorts;
  advertisedPort?: number;
  ssl?: { advertisedPort: number };
  disableAuth?: boolean;
};
export type OosSession = { screenName: string; away: boolean; awayMessage: string; instances: number };

// SNACs the server forwards to a client are logged with the same message as SNACs the client sent. A BOS
// connection logs them without a screenName, which already keeps them out; this table is for a connection
// that names its session. The kinds: ICBM to client, buddy arrived and departed, OService notices, chat relays.
const FORWARDED: Record<number, number[]> = {
  0x01: [0x0a, 0x0f, 0x10, 0x13],
  0x03: [0x0b, 0x0c],
  0x04: [0x07, 0x0a],
  0x0e: [0x02, 0x03, 0x04, 0x06],
};

export function parseRequestLine(line: string): LoggedRequest | null {
  if (!/ msg="client request( -> server response| error)?"/.test(line)) return null;
  const name = /(?:^| )screenName=(?:"([^"]*)"|(\S+))/.exec(line);
  const frame = /request\.snac_frame="?\{FoodGroup:(\d+) SubGroup:(\d+)/.exec(line);
  if (!name || !frame) return null;
  const family = Number(frame[1]);
  const subtype = Number(frame[2]);
  if (FORWARDED[family]?.includes(subtype)) return null;
  return { screenName: normalizeName(name[1] ?? name[2] ?? ''), family, subtype, line };
}

export function normalizeName(name: string): string {
  return name.replace(/ /g, '').toLowerCase();
}

// Byte fields are printed as decimal lists, so a name can hide there in either case and with spaces (32).
export function mentions(line: string, name: string): boolean {
  const wanted = normalizeName(name);
  if (line.toLowerCase().replace(/ /g, '').includes(wanted)) return true;
  const codes = [...wanted].map((ch) => {
    const lower = ch.charCodeAt(0);
    const upper = ch.toUpperCase().charCodeAt(0);
    return lower === upper ? String(lower) : `(?:${lower}|${upper})`;
  });
  return new RegExp(`(?<![0-9])${codes.join(' (?:32 )*')}(?![0-9])`).test(line);
}

export function imRecipient(line: string): string | null {
  const m = /request\.snac_frame="?\{FoodGroup:4 SubGroup:6 .*?ChannelID:\d+ ScreenName:(.*?) TLVRestBlock:/.exec(line);
  return m ? normalizeName(m[1] ?? '') : null;
}

export async function freePorts(count: number): Promise<number[]> {
  const servers = await Promise.all(
    Array.from({ length: count }, () => new Promise<net.Server>((resolve) => {
      const s = net.createServer();
      s.listen(0, '127.0.0.1', () => resolve(s));
    })),
  );
  const ports = servers.map((s) => (s.address() as net.AddressInfo).port);
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  return ports;
}

export class Oos {
  readonly ports: OosPorts;
  readonly generation: Generation;
  private readonly opts: OosOptions;
  private readonly dir: string;
  private child: ChildProcess | null = null;
  private readonly requests: LoggedRequest[] = [];
  private tail: string[] = [];

  private constructor(opts: OosOptions) {
    this.opts = opts;
    this.ports = opts.ports;
    this.generation = opts.generation;
    this.dir = mkdtempSync(join(tmpdir(), 'oos-'));
  }

  static async start(opts: OosOptions): Promise<Oos> {
    const oos = new Oos(opts);
    await oos.spawn();
    return oos;
  }

  get apiUrl(): string {
    return `http://127.0.0.1:${this.ports.api}`;
  }

  private environment(): Record<string, string> {
    const { ports, advertisedPort, ssl, disableAuth, generation } = this.opts;
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '',
      OSCAR_LISTENERS: `LOCAL://127.0.0.1:${ports.oscar}`,
      OSCAR_ADVERTISED_LISTENERS_PLAIN: `LOCAL://127.0.0.1:${advertisedPort ?? ports.oscar}`,
      TOC_LISTENERS: `127.0.0.1:${ports.toc}`,
      API_LISTENER: `127.0.0.1:${ports.api}`,
      DB_PATH: join(this.dir, 'oscar.sqlite'),
      DISABLE_AUTH: disableAuth ? 'true' : 'false',
      DISABLE_MULTI_LOGIN_NOTIF: 'true',
      LOG_LEVEL: 'trace',
      ICQ_LEGACY_ENABLED: 'false',
    };
    // v0.24.0 has no SSL listener; a TLS client there is redirected to the plaintext host
    if (ssl && generation === 'main') {
      env.OSCAR_LISTENERS_SSL = `LOCAL://127.0.0.1:${ports.ssl}`;
      env.OSCAR_ADVERTISED_LISTENERS_SSL = `LOCAL://localhost:${ssl.advertisedPort}`;
    }
    return env;
  }

  private async spawn(): Promise<void> {
    const child = spawn(this.opts.bin, ['-config', join(this.dir, 'none.env')], {
      cwd: this.dir, env: this.environment(), stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    let exited = false;
    child.on('exit', () => { exited = true; });
    let buffered = '';
    const onOutput = (chunk: Buffer) => {
      buffered += chunk.toString('utf8');
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const line of lines) {
        this.tail.push(line);
        if (this.tail.length > 40) this.tail.shift();
        const request = parseRequestLine(line);
        if (request) this.requests.push(request);
      }
    };
    child.stdout?.on('data', onOutput);
    child.stderr?.on('data', onOutput);
    await until(async () => {
      if (exited) throw new Error(`server exited during start:\n${this.tail.join('\n')}`);
      try {
        return (await fetch(`${this.apiUrl}/session`)).ok && (await canConnect(this.ports.oscar));
      } catch {
        return false;
      }
    }, { timeoutMs: 20_000, everyMs: 150, what: 'the server to listen' });
  }

  async createUser(screenName: string, password: string, opts: { bot?: boolean } = {}): Promise<void> {
    const created = await fetch(`${this.apiUrl}/user`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ screen_name: screenName, password }),
    });
    if (created.status !== 201 && created.status !== 409) throw new Error(`create user ${screenName}: HTTP ${created.status}`);
    if (opts.bot) {
      const patched = await fetch(`${this.apiUrl}/user/${encodeURIComponent(screenName)}/account`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ is_bot: true }),
      });
      if (patched.status !== 204 && patched.status !== 304) throw new Error(`set bot flag on ${screenName}: HTTP ${patched.status}`);
    }
  }

  async sessions(): Promise<OosSession[]> {
    const body = (await (await fetch(`${this.apiUrl}/session`)).json()) as {
      sessions?: { screen_name: string; is_away?: boolean; away_message?: string; instance_count?: number }[];
    };
    return (body.sessions ?? []).map((s) => ({
      screenName: normalizeName(s.screen_name), away: s.is_away === true, awayMessage: s.away_message ?? '', instances: s.instance_count ?? 1,
    }));
  }

  async session(screenName: string): Promise<OosSession | null> {
    const wanted = normalizeName(screenName);
    return (await this.sessions()).find((s) => s.screenName === wanted) ?? null;
  }

  async roomOccupants(room: string): Promise<string[]> {
    const rooms = (await (await fetch(`${this.apiUrl}/chat/room/private`)).json()) as {
      name: string; participants?: { screen_name: string }[];
    }[];
    const found = rooms.find((r) => r.name.toLowerCase() === room.toLowerCase());
    return (found?.participants ?? []).map((p) => normalizeName(p.screen_name));
  }

  requestsFrom(screenName: string): LoggedRequest[] {
    const wanted = normalizeName(screenName);
    return this.requests.filter((r) => r.screenName === wanted);
  }

  private async halt(): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    const gone = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 5000);
    await gone;
    clearTimeout(force);
  }

  async restart(): Promise<void> {
    await this.halt();
    await this.spawn();
  }

  async stop(): Promise<void> {
    await this.halt();
  }
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}
