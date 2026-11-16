import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('openclaw/plugin-sdk/web-media', async () => (await import('../../fake/openclaw.js')).webMedia);
vi.mock('openclaw/plugin-sdk/media-runtime', async () => (await import('../../fake/openclaw.js')).mediaRuntime);

import { linkOf, loadOutgoing } from '../../../src/sending/load.js';
import type { HostAccess } from '../../../src/sending/load.js';
import { FAKE_MEDIA_DIR, sdk } from '../../fake/openclaw.js';
import { silentLog } from '../rooms-fixtures.js';

const MB = 1024 * 1024;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const NOTES = Buffer.from('# Notes\n');
const CHART = `${FAKE_MEDIA_DIR}/outbound/chart.png`;
const MEMORY = '/fake/agents/helper/MEMORY.md';
const THEIRS = `${FAKE_MEDIA_DIR}/inbound/theirs.png`;
const ELSEWHERE = '/fake/home/report.pdf';

type Role = 'owner' | 'approved';
const load = (url: string, role: Role, over: { host?: HostAccess; maxBytes?: number; agentId?: string } = {}) =>
  loadOutgoing({ url, cfg: {}, agentId: over.agentId ?? 'helper', role, maxBytes: over.maxBytes ?? MB, host: over.host, log: silentLog });
const lastOptions = () => sdk.loads.at(-1)?.options ?? {};

beforeEach(() => {
  sdk.reset();
  sdk.files.set(CHART, { buffer: PNG, contentType: 'image/png' });
  sdk.files.set(MEMORY, { buffer: NOTES, contentType: 'text/markdown' });
  sdk.files.set(THEIRS, { buffer: PNG, contentType: 'image/png' });
  sdk.files.set(ELSEWHERE, { buffer: NOTES, contentType: 'application/pdf' });
});

describe('loadOutgoing for an approved person', () => {
  it('loads a file from the media folder for an approved person', async () => {
    const got = await load(CHART, 'approved');
    expect(got).toMatchObject({ ok: true, name: 'chart.png', contentType: 'image/png' });
    expect(got.ok && [...got.bytes]).toEqual([...PNG]);
    expect(lastOptions()).toMatchObject({ localRoots: [FAKE_MEDIA_DIR], optimizeImages: false });
  });

  it('refuses a workspace file for an approved person', async () => {
    expect(await load(MEMORY, 'approved')).toEqual({ ok: false, why: 'not-allowed' });
    expect(await load('/fake/state/workspace/notes.md', 'approved')).toEqual({ ok: false, why: 'not-allowed' });
  });

  it('refuses the inbound folder for an approved person', async () => {
    expect(await load(THEIRS, 'approved')).toEqual({ ok: false, why: 'not-allowed' });
    expect(sdk.loads).toEqual([]);
  });

  it('refuses the inbound folder reached through .. and through a file URL', async () => {
    const forms = [
      `${FAKE_MEDIA_DIR}/outbound/../inbound/theirs.png`,
      `file://${THEIRS}`,
      `file://${FAKE_MEDIA_DIR}/outbound/%2e%2e/inbound/theirs.png`,
      `FILE://${THEIRS}`,
      `${FAKE_MEDIA_DIR}/INBOUND/theirs.png`,
      `${FAKE_MEDIA_DIR}//inbound/theirs.png`,
    ];
    for (const url of forms) expect(await load(url, 'approved'), url).toEqual({ ok: false, why: 'not-allowed' });
    expect(sdk.loads).toEqual([]);
  });

  it('refuses a store reference, a prefixed path, a home path and a relative path for an approved person', async () => {
    const forms = ['media://inbound/theirs.png', 'MEDIA://inbound/theirs.png', ` MEDIA: ${THEIRS}`, `MEDIA:${CHART}`, '~/media/inbound/theirs.png', 'inbound/theirs.png', '../media/inbound/theirs.png', 'data:image/png;base64,AAAA', ''];
    for (const url of forms) expect(await load(url, 'approved'), url).toEqual({ ok: false, why: 'not-allowed' });
    expect(sdk.loads).toEqual([]);
  });

  it('hands the loader the resolved path of a file URL', async () => {
    expect(await load(`file://${FAKE_MEDIA_DIR}/outbound/./chart.png`, 'approved')).toMatchObject({ ok: true, name: 'chart.png' });
    expect(sdk.loads.at(-1)?.url).toBe(CHART);
  });

  it("ignores the host's media access for an approved person", async () => {
    const readFile = vi.fn(async () => NOTES);
    const host: HostAccess = { mediaAccess: { localRoots: ['/fake/home'], readFile, workspaceDir: '/fake/home' }, mediaLocalRoots: ['/fake/home'], mediaReadFile: readFile };
    expect(await load(ELSEWHERE, 'approved', { host })).toEqual({ ok: false, why: 'not-allowed' });
    expect(readFile).not.toHaveBeenCalled();
    expect(lastOptions()).toMatchObject({ maxBytes: MB, localRoots: [FAKE_MEDIA_DIR], optimizeImages: false });
    expect(lastOptions()).not.toHaveProperty('readFile');
    expect(lastOptions()).not.toHaveProperty('hostReadCapability');
    expect(lastOptions()).not.toHaveProperty('workspaceDir');
  });

  it('gives an http url to the loader for an approved person', async () => {
    sdk.remote.set('https://example.net/cat.png', { buffer: PNG, contentType: 'image/png', fileName: 'cat.png' });
    expect(await load(' https://example.net/cat.png ', 'approved')).toMatchObject({ ok: true, name: 'cat.png' });
    expect(sdk.loads.at(-1)?.url).toBe('https://example.net/cat.png');
    expect(lastOptions()).not.toHaveProperty('ssrfPolicy');
  });
});

describe('loadOutgoing for an owner', () => {
  it("uses the host's media access for an owner", async () => {
    const readFile = vi.fn(async () => NOTES);
    const got = await load(ELSEWHERE, 'owner', { host: { mediaAccess: { localRoots: ['/fake/home'], readFile } } });
    expect(got).toMatchObject({ ok: true, name: 'report.pdf' });
    expect(readFile).toHaveBeenCalledWith(ELSEWHERE);
    expect(lastOptions()).toMatchObject({ localRoots: ['/fake/home'], optimizeImages: false });
  });

  it("uses the host's roots for an owner", async () => {
    expect(await load(ELSEWHERE, 'owner', { host: { mediaLocalRoots: ['/fake/home'] } })).toMatchObject({ ok: true });
    expect(await load(MEMORY, 'owner', { host: { mediaLocalRoots: ['/fake/home'] } })).toEqual({ ok: false, why: 'not-allowed' });
  });

  it("uses the agent's roots for an owner when the host gives none", async () => {
    expect(await load(MEMORY, 'owner')).toMatchObject({ ok: true, name: 'MEMORY.md' });
    expect(lastOptions()).toMatchObject({ localRoots: [FAKE_MEDIA_DIR, '/fake/state/workspace', '/fake/agents/helper'], optimizeImages: false });
    expect(await load(MEMORY, 'owner', { host: { mediaLocalRoots: [] } })).toMatchObject({ ok: true });
    expect(await load(ELSEWHERE, 'owner')).toEqual({ ok: false, why: 'not-allowed' });
    expect(await load('/fake/agents/other/MEMORY.md', 'owner')).toEqual({ ok: false, why: 'not-allowed' });
  });

  it('gives an owner a file somebody sent, by path and by store reference', async () => {
    expect(await load(THEIRS, 'owner')).toMatchObject({ ok: true, name: 'theirs.png' });
    await load('media://inbound/theirs.png', 'owner');
    expect(sdk.loads.at(-1)?.url).toBe('media://inbound/theirs.png');
  });
});

describe('loadOutgoing results', () => {
  it('passes the size limit to the loader and reports a file over it as too large', async () => {
    sdk.files.set(CHART, { buffer: Buffer.alloc(2 * MB + 1), contentType: 'image/png' });
    expect(await load(CHART, 'approved', { maxBytes: 2 * MB })).toEqual({ ok: false, why: 'too-large' });
    expect(lastOptions().maxBytes).toBe(2 * MB);
    expect(await load(CHART, 'owner', { maxBytes: 2 * MB })).toEqual({ ok: false, why: 'too-large' });
    sdk.remote.set('https://example.net/big.bin', { buffer: Buffer.alloc(2 * MB + 1) });
    expect(await load('https://example.net/big.bin', 'approved', { maxBytes: 2 * MB })).toEqual({ ok: false, why: 'too-large' });
  });

  it('reports each wording of the size error as too large', async () => {
    const shapes = [
      new Error('Media exceeds 2MB limit (got 2.40MB)'),
      new Error('Media exceeds 2MB limit'),
      new Error('Media could not be reduced below 2MB (got 2.40MB)'),
      new Error('read failed', { cause: Object.assign(new Error('file exceeds limit of 16 bytes (got 64)'), { code: 'too-large' }) }),
      Object.assign(new Error('payload exceeds maxBytes 16'), { code: 'max_bytes' }),
    ];
    for (const shape of shapes) {
      sdk.loadFail = shape;
      expect(await load(CHART, 'owner'), shape.message).toEqual({ ok: false, why: 'too-large' });
    }
    sdk.loadFail = Object.assign(new Error('Local media path is not under an allowed directory: /a exceeds 2MB limit'), { name: 'LocalMediaAccessError', code: 'path-not-allowed' });
    expect(await load(CHART, 'owner')).toEqual({ ok: false, why: 'not-allowed' });
  });

  it('reports a file the loader gives over the limit as too large', async () => {
    sdk.loadResult = { buffer: Buffer.alloc(64), fileName: 'chart.png' };
    expect(await load(CHART, 'owner', { maxBytes: 16 })).toEqual({ ok: false, why: 'too-large' });
    expect(await load(CHART, 'approved', { maxBytes: 64 })).toMatchObject({ ok: true });
  });

  it('reports an empty file', async () => {
    sdk.files.set(CHART, { buffer: Buffer.alloc(0) });
    expect(await load(CHART, 'approved')).toEqual({ ok: false, why: 'empty' });
    expect(await load(CHART, 'owner')).toEqual({ ok: false, why: 'empty' });
  });

  it('reports a missing file and a refused address as failed', async () => {
    expect(await load(`${FAKE_MEDIA_DIR}/outbound/gone.png`, 'approved')).toEqual({ ok: false, why: 'failed' });
    expect(await load('http://localhost/x.png', 'owner')).toEqual({ ok: false, why: 'failed' });
  });

  it('reports a load that throws as failed, and never throws', async () => {
    for (const thrown of [new Error('boom'), 'text', null, { code: 7 }, Object.assign(new Error('odd'), { code: 'never-heard-of-it' })]) {
      sdk.loadFail = thrown;
      expect(await load(CHART, 'owner')).toEqual({ ok: false, why: 'failed' });
      expect(await load(CHART, 'approved')).toEqual({ ok: false, why: 'failed' });
    }
    sdk.loadFail = undefined;
    const readFile = async () => NOTES;
    expect(await load(ELSEWHERE, 'owner', { host: { mediaAccess: { localRoots: 'any', readFile } } })).toEqual({ ok: false, why: 'not-allowed' });
    expect(await loadOutgoing({ url: undefined as unknown as string, cfg: null, role: 'approved', maxBytes: MB, log: silentLog })).toEqual({ ok: false, why: 'not-allowed' });
    expect(await loadOutgoing({ url: undefined as unknown as string, cfg: null, role: 'owner', maxBytes: MB, log: silentLog })).toMatchObject({ ok: false });
  });

  it('cleans the name and adds an extension when the loader gives no name', async () => {
    sdk.remote.set('https://example.net/a', { buffer: PNG, contentType: 'image/png' });
    sdk.remote.set('https://example.net/b', { buffer: PNG, contentType: 'application/x-unknown' });
    sdk.remote.set('https://example.net/c', { buffer: PNG, contentType: 'image/png', fileName: '..\\pics\\cat\u0007.png' });
    expect(await load('https://example.net/a', 'owner')).toMatchObject({ ok: true, name: 'file.png' });
    expect(await load('https://example.net/b', 'owner')).toMatchObject({ ok: true, name: 'file' });
    expect(await load('https://example.net/c', 'owner')).toMatchObject({ ok: true, name: 'cat.png' });
  });
});

describe('loadOutgoing and time', () => {
  const URL_SLOW = 'https://example.net/slow.bin';
  const signalOf = () => (lastOptions().requestInit as { signal?: AbortSignal } | undefined)?.signal;
  const settled = (load: Promise<unknown>) => {
    const state = { done: false };
    void load.then(() => (state.done = true));
    return state;
  };

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('gives up on a load that never ends, and stops it', async () => {
    for (const role of ['owner', 'approved'] as const) {
      sdk.loadHangs = 'until-aborted';
      const got = load(URL_SLOW, role);
      const state = settled(got);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(state.done, role).toBe(false);
      expect(signalOf()?.aborted, role).toBe(false);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(state.done, role).toBe(true);
      expect(await got, role).toEqual({ ok: false, why: 'failed' });
      expect(signalOf()?.aborted, role).toBe(true);
    }
  });

  it('gives up on a load that does not heed the stop', async () => {
    sdk.loadHangs = 'for-ever';
    const got = load(URL_SLOW, 'approved');
    const state = settled(got);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(state.done).toBe(true);
    expect(await got).toEqual({ ok: false, why: 'failed' });
  });

  it('limits the wait between two parts of a remote file', async () => {
    sdk.remote.set(URL_SLOW, { buffer: PNG, contentType: 'image/png' });
    expect(await load(URL_SLOW, 'approved')).toMatchObject({ ok: true });
    const idle = lastOptions().readIdleTimeoutMs as number;
    expect(idle).toBeGreaterThan(0);
    expect(idle).toBeLessThan(5 * 60_000);
  });

  it('leaves no timer behind and does not stop a load that ended', async () => {
    sdk.remote.set(URL_SLOW, { buffer: PNG, contentType: 'image/png' });
    expect(await load(URL_SLOW, 'owner')).toMatchObject({ ok: true });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(signalOf()?.aborted).toBe(false);
    sdk.loadFail = new Error('boom');
    expect(await load(URL_SLOW, 'owner')).toEqual({ ok: false, why: 'failed' });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('linkOf', () => {
  it('gives the link of an http or https url and nothing for a path', () => {
    expect(linkOf('https://example.net/cat.png')).toBe('https://example.net/cat.png');
    expect(linkOf(' HTTP://example.net/a?b=c ')).toBe('HTTP://example.net/a?b=c');
    for (const url of [CHART, `file://${CHART}`, 'media://inbound/x', 'ftp://example.net/x', 'https://', 'https://exa mple.net/x', 'https://example.net/a\nb', '']) {
      expect(linkOf(url), url).toBeUndefined();
    }
  });
});
