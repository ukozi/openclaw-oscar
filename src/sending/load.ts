import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/channel-core';
import { buildOutboundMediaLoadOptions, extensionForMime, getAgentScopedMediaLocalRoots, getMediaDir } from 'openclaw/plugin-sdk/media-runtime';
import { loadWebMedia } from 'openclaw/plugin-sdk/web-media';
import { baseName } from '../inbound/sniff.js';
import type { Logger } from '../oscar/index.js';

export type HostAccess = { mediaAccess?: unknown; mediaLocalRoots?: readonly string[]; mediaReadFile?: (path: string) => Promise<Buffer> };
export type Loaded =
  | { ok: true; bytes: Uint8Array; name: string; contentType?: string }
  | { ok: false; why: 'too-large' | 'not-allowed' | 'empty' | 'failed' };

type LoadParams = NonNullable<Parameters<typeof buildOutboundMediaLoadOptions>[0]>;
type Why = Extract<Loaded, { ok: false }>['why'];

const HTTP = /^https?:\/\//i;
const MISSING = new Set(['not-found', 'not-file']);
const LOAD_MS = 60_000;
const IDLE_MS = 15_000;

export function linkOf(url: string): string | undefined {
  const link = typeof url === 'string' ? url.trim() : '';
  if (!HTTP.test(link) || /[\s\u0000-\u001f\u007f]/.test(link)) return undefined;
  try {
    return new URL(link).hostname ? link : undefined;
  } catch {
    return undefined;
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function whyOf(err: unknown): Why {
  const e = (typeof err === 'object' && err !== null ? err : {}) as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown };
  if (e.name === 'LocalMediaAccessError') return typeof e.code === 'string' && MISSING.has(e.code) ? 'failed' : 'not-allowed';
  const cause = (typeof e.cause === 'object' && e.cause !== null ? e.cause : {}) as { code?: unknown };
  if (e.code === 'max_bytes' || cause.code === 'too-large') return 'too-large';
  const message = typeof e.message === 'string' ? e.message : '';
  return /\bexceeds [^/\\]{1,24} limit\b|could not be reduced below /.test(message) ? 'too-large' : 'failed';
}

// Two leading separators name another computer or a device on Windows.
export function networkPath(path: string): boolean {
  return /^[\\/]{2}/.test(path);
}

// Only an absolute path or a file URL with no host counts as a local file for a person who is not an owner.
function plainPath(url: string): string | undefined {
  let path = url;
  if (/^file:/i.test(url)) {
    try {
      if (new URL(url).hostname !== '') return undefined;
      path = fileURLToPath(url);
    } catch {
      return undefined;
    }
  }
  if (networkPath(path) || !isAbsolute(path) || path.includes('\u0000')) return undefined;
  const full = resolve(path);
  return networkPath(full) ? undefined : full;
}

async function real(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

function within(dir: string, path: string): boolean {
  const rel = relative(dir.toLowerCase(), path.toLowerCase());
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

// The file system is asked about the path only when its text is inside the media folder.
async function refusal(path: string): Promise<string | undefined> {
  const media = resolve(getMediaDir());
  if (![media, await real(media)].some((dir) => within(dir, path))) return 'outside the media folder';
  const inbound = resolve(media, 'inbound');
  const dirs = [inbound, await real(inbound)];
  const paths = [path, await real(path)];
  return dirs.some((dir) => paths.some((p) => within(dir, p))) ? 'received from somebody' : undefined;
}

// Stops a load that takes too long, and gives up on one that does not stop.
async function inTime<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const stop = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error('the load took too long');
      stop.abort(err);
      reject(err);
    }, LOAD_MS);
  });
  try {
    const load = run(stop.signal);
    load.catch(() => undefined);
    return await Promise.race([load, late]);
  } finally {
    clearTimeout(timer);
  }
}

export async function loadOutgoing(p: {
  url: string;
  cfg: unknown;
  agentId?: string;
  role: 'owner' | 'approved';
  maxBytes: number;
  host?: HostAccess;
  log: Logger;
}): Promise<Loaded> {
  try {
    let url = typeof p.url === 'string' ? p.url.trim() : '';
    let params: LoadParams;
    if (p.role === 'owner') {
      const roots = p.host?.mediaLocalRoots?.length ? p.host.mediaLocalRoots : getAgentScopedMediaLocalRoots(p.cfg as OpenClawConfig, p.agentId);
      params = { mediaAccess: p.host?.mediaAccess as LoadParams['mediaAccess'], mediaLocalRoots: roots, mediaReadFile: p.host?.mediaReadFile };
    } else {
      if (!HTTP.test(url)) {
        const path = plainPath(url);
        const why = path === undefined ? 'not a plain path' : await refusal(path);
        if (path === undefined || why !== undefined) {
          p.log.info('a file was not loaded for a person who is not an owner', { why });
          return { ok: false, why: 'not-allowed' };
        }
        url = path;
      }
      params = { mediaLocalRoots: [getMediaDir()] };
    }
    const got = await inTime((signal) => {
      const built = buildOutboundMediaLoadOptions({ ...params, maxBytes: p.maxBytes, optimizeImages: false, requestInit: { signal } });
      const options = { ...built, readIdleTimeoutMs: IDLE_MS };
      return loadWebMedia(url, options);
    });
    const bytes = new Uint8Array(got.buffer);
    if (bytes.byteLength === 0) return { ok: false, why: 'empty' };
    if (bytes.byteLength > p.maxBytes) return { ok: false, why: 'too-large' };
    const name = got.fileName ? baseName(got.fileName) : `file${extensionForMime(got.contentType) ?? ''}`;
    return { ok: true, bytes, name, ...(got.contentType ? { contentType: got.contentType } : {}) };
  } catch (err) {
    const why = whyOf(err);
    p.log.warn('a file to send could not be loaded', { why, error: errText(err) });
    return { ok: false, why };
  }
}
