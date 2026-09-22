export type Generation = 'v0.24' | 'main';
export type Credential = { screenName: string; password: string };
export type LiveEnv =
  | { mode: 'off' }
  | { mode: 'local'; bin: string; generation: Generation }
  | { mode: 'remote'; host: string; port: number; tls: boolean; caFile?: string; room: string; a: Credential; b: Credential };

const REMOTE_KEYS = ['OSCAR_LIVE_HOST', 'OSCAR_LIVE_USER_A', 'OSCAR_LIVE_PASS_A', 'OSCAR_LIVE_USER_B', 'OSCAR_LIVE_PASS_B'] as const;

export function liveEnv(env: Record<string, string | undefined> = process.env): LiveEnv {
  const bin = env.OOS_BIN?.trim();
  const host = env.OSCAR_LIVE_HOST?.trim();
  if (bin && host) throw new Error('set OOS_BIN or OSCAR_LIVE_HOST, not both');
  if (bin) {
    const generation = env.OOS_GENERATION?.trim();
    if (generation !== 'v0.24' && generation !== 'main') {
      throw new Error('OOS_GENERATION must be v0.24 or main when OOS_BIN is set');
    }
    return { mode: 'local', bin, generation };
  }
  if (!host) return { mode: 'off' };
  const missing = REMOTE_KEYS.filter((k) => !env[k]?.trim());
  if (missing.length > 0) throw new Error(`missing ${missing.join(', ')}`);
  const port = Number(env.OSCAR_LIVE_PORT ?? '5190');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('OSCAR_LIVE_PORT must be a port number');
  const caFile = env.OSCAR_LIVE_CA_FILE?.trim();
  return {
    mode: 'remote',
    host,
    port,
    tls: env.OSCAR_LIVE_TLS === '1',
    ...(caFile ? { caFile } : {}),
    room: env.OSCAR_LIVE_ROOM?.trim() || 'smoketest',
    a: { screenName: env.OSCAR_LIVE_USER_A as string, password: env.OSCAR_LIVE_PASS_A as string },
    b: { screenName: env.OSCAR_LIVE_USER_B as string, password: env.OSCAR_LIVE_PASS_B as string },
  };
}
