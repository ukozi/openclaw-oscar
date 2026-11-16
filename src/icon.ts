import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/channel-core';
import { writeJsonFileAtomically } from 'openclaw/plugin-sdk/json-store';
import { buildOutboundMediaLoadOptions, getAgentScopedMediaLocalRoots, getImageMetadata, resizeToJpeg } from 'openclaw/plugin-sdk/media-runtime';
import { resolveAgentRoute } from 'openclaw/plugin-sdk/routing';
import { resolveStateDir } from 'openclaw/plugin-sdk/state-paths';
import { loadWebMedia } from 'openclaw/plugin-sdk/web-media';
import { CHANNEL_ID } from './config.js';
import { isOwnIcon } from './oscar/index.js';
import type { Logger, TimerApi } from './oscar/index.js';

export const ICON_TIMING = { afterSignOnMs: 20_000, lookEveryMs: 600_000, stepMs: 30_000 };

const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const ICON_SIDE = 48;
const QUALITIES = [85, 70, 55, 40, 25, 10];

export type BuddyIcon = { onOnline(): void; onTurn(): void; stop(): void; idle(): Promise<void> };
export type IconDeps = {
  accountId: string; getCfg: () => unknown; now: () => number; timers: TimerApi; log: Logger;
  enabled: boolean;
  // The server and the name the stored hash belongs to.
  owner: string;
  online: () => boolean;
  setOwnIcon: (bytes: Uint8Array) => Promise<void>;
  file?: string;
};

type Avatar = { kind: 'none' } | { kind: 'local'; filePath: string } | { kind: 'remote' | 'data'; url: string };
type Stored = { version: 1; owner: string; hash: string; ok: boolean };
type Made = { icon: Uint8Array } | { why: string };

export function iconFileFor(accountId: string): string {
  return join(resolveStateDir(), 'oscar', `icon-${accountId}.json`);
}

const hashOf = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

async function keyOf(avatar: Avatar): Promise<string> {
  if (avatar.kind === 'none') return 'none';
  if (avatar.kind !== 'local') return `${avatar.kind}:${hashOf(avatar.url)}`;
  const file = await stat(avatar.filePath).catch(() => undefined);
  return `local:${avatar.filePath}:${file?.size ?? ''}:${file?.mtimeMs ?? ''}`;
}

async function bytesOf(avatar: Exclude<Avatar, { kind: 'none' }>, cfg: OpenClawConfig, agentId: string, signal: AbortSignal): Promise<Buffer> {
  if (avatar.kind === 'data') {
    const body = /^data:[^,]*;base64,(.*)$/s.exec(avatar.url)?.[1];
    if (body === undefined || body.length > AVATAR_MAX_BYTES * 2) throw new Error('not a base64 data URL of a usable size');
    return Buffer.from(body, 'base64');
  }
  const local = avatar.kind === 'local';
  const options = buildOutboundMediaLoadOptions({
    maxBytes: AVATAR_MAX_BYTES, optimizeImages: false, requestInit: { signal },
    ...(local ? { mediaLocalRoots: getAgentScopedMediaLocalRoots(cfg, agentId) } : {}),
  });
  return (await loadWebMedia(local ? avatar.filePath : avatar.url, options)).buffer;
}

export async function makeIcon(bytes: Buffer): Promise<Made> {
  if (isOwnIcon(bytes)) return { icon: bytes };
  const size = await getImageMetadata(bytes);
  if (!size) return { why: 'the avatar could not be read' };
  // The host's resize keeps the shape, so only a square gives 48 by 48.
  if (size.width !== size.height) return { why: 'the avatar is not square' };
  for (const quality of QUALITIES) {
    const out = await resizeToJpeg({ buffer: bytes, maxSide: ICON_SIDE, quality, withoutEnlargement: false });
    if (isOwnIcon(out)) return { icon: out };
  }
  return { why: 'the avatar could not be made into an icon' };
}

async function inTime<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const stop = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error('it took too long');
      stop.abort(err);
      reject(err);
    }, ICON_TIMING.stepMs);
  });
  try {
    const work = run(stop.signal);
    work.catch(() => undefined);
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

export function createBuddyIcon(deps: IconDeps): BuddyIcon {
  const file = deps.file ?? iconFileFor(deps.accountId);
  let stopped = false;
  let busy = false;
  let settled: string | undefined;
  let lookedAt: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let work: Promise<void> = Promise.resolve();

  const stored = (): Stored | undefined => {
    try {
      const data = JSON.parse(readFileSync(file, 'utf8')) as Partial<Stored> | null;
      return data?.version === 1 && data.owner === deps.owner && typeof data.hash === 'string' ? (data as Stored) : undefined;
    } catch {
      return undefined;
    }
  };
  const store = async (hash: string, ok: boolean): Promise<void> => {
    const body: Stored = { version: 1, owner: deps.owner, hash, ok };
    await writeJsonFileAtomically(file, body).catch((err: unknown) => deps.log.warn(`buddy icon: cannot write ${file}: ${String(err)}`));
  };
  const leave = (why: string, key: string): void => {
    deps.log.info(`buddy icon left alone: ${why}`);
    settled = key;
  };

  const look = async (): Promise<void> => {
    lookedAt = deps.now();
    const cfg = deps.getCfg() as OpenClawConfig;
    const { agentId } = resolveAgentRoute({ cfg, channel: CHANNEL_ID, accountId: deps.accountId });
    const { resolveAgentAvatar } = await import('openclaw/plugin-sdk/agent-runtime');
    const avatar = resolveAgentAvatar(cfg, agentId) as Avatar;
    const key = await keyOf(avatar);
    if (stopped || key === settled) return;
    if (avatar.kind === 'none') return leave('the agent has no avatar', key);
    let made: Made;
    try {
      made = await inTime(async (signal) => makeIcon(await bytesOf(avatar, cfg, agentId, signal)));
    } catch (err) {
      deps.log.debug('the avatar was not loaded', { error: errText(err) });
      return leave('the avatar could not be read', key);
    }
    if (stopped) return;
    if ('why' in made) return leave(made.why, key);
    const { icon } = made;
    const hash = hashOf(icon);
    if (stored()?.hash === hash) {
      settled = key;
      return;
    }
    if (!deps.online()) return;
    try {
      await inTime(() => deps.setOwnIcon(icon));
    } catch (err) {
      // A set cut off by a lost connection is tried again after the next sign-on.
      if (stopped || !deps.online()) return;
      await store(hash, false);
      deps.log.warn('buddy icon left alone: the server did not take it', { error: errText(err) });
      settled = key;
      return;
    }
    await store(hash, true);
    settled = key;
    deps.log.info('buddy icon set');
  };

  const run = (): void => {
    if (stopped || busy) return;
    busy = true;
    work = look()
      .catch((err: unknown) => deps.log.warn('buddy icon left alone: the check failed', { error: errText(err) }))
      .finally(() => {
        busy = false;
      });
  };

  if (!deps.enabled) {
    deps.log.info('buddy icon left alone: the setting is off');
    // With the setting off the icon may change elsewhere, so the stored hash says nothing.
    work = rm(file, { force: true }).catch(() => undefined);
  }

  return {
    onOnline(): void {
      if (!deps.enabled || stopped) return;
      if (timer) deps.timers.clearTimeout(timer);
      timer = deps.timers.setTimeout(run, ICON_TIMING.afterSignOnMs);
    },
    onTurn(): void {
      if (!deps.enabled || lookedAt === undefined || deps.now() - lookedAt < ICON_TIMING.lookEveryMs) return;
      run();
    },
    stop(): void {
      stopped = true;
      if (timer) deps.timers.clearTimeout(timer);
    },
    idle: () => work,
  };
}
