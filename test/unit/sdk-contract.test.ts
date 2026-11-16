import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveAgentAvatar } from 'openclaw/plugin-sdk/agent-runtime';
import { resolveStableChannelMessageIngress } from 'openclaw/plugin-sdk/channel-ingress-runtime';
import { buildOutboundMediaLoadOptions, getMediaDir } from 'openclaw/plugin-sdk/media-runtime';
import { resolveOutboundMediaUrls } from 'openclaw/plugin-sdk/reply-payload';
import { loadWebMedia } from 'openclaw/plugin-sdk/web-media';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readPolicy } from '../../src/config.js';
import { ingressParams } from '../../src/inbound/im.js';
import { makeIcon } from '../../src/icon.js';
import { isOwnIcon } from '../../src/oscar/index.js';
import { loadOutgoing } from '../../src/sending/load.js';
import { replyPayload } from '../fake/openclaw.js';
import { silentLog } from './rooms-fixtures.js';

const policy = (sec: Record<string, unknown>) => readPolicy({ channels: { oscar: sec } });

describe('real ingress resolver', () => {
  it('blocks a stranger without asking for pairing', async () => {
    const res = await resolveStableChannelMessageIngress(ingressParams('botone', 'mallory', policy({ owners: ['Alice B'], allowFrom: ['bob'] })));
    expect(res.senderAccess.decision).toBe('block');
    expect(res.ingress.admission).toBe('drop');
    expect(res.ingress.reasonCode).toBe('dm_policy_not_allowlisted');
  });

  it('admits an owner whose config entry has spaces and capitals', async () => {
    const res = await resolveStableChannelMessageIngress(ingressParams('botone', 'aliceb', policy({ owners: ['Alice B'] })));
    expect(res.senderAccess.decision).toBe('allow');
    expect(res.ingress.admission).toBe('dispatch');
  });

  it('admits nobody when disabled and anybody when open', async () => {
    expect((await resolveStableChannelMessageIngress(ingressParams('botone', 'alice', policy({ owners: ['alice'], dmPolicy: 'disabled' })))).senderAccess.decision).toBe('block');
    expect((await resolveStableChannelMessageIngress(ingressParams('botone', 'mallory', policy({ owners: ['alice'], dmPolicy: 'open', dangerouslyAllowOpenDm: true })))).senderAccess.decision).toBe('allow');
  });

  it('agrees with the fake about open without a star', async () => {
    const params = { ...ingressParams('botone', 'mallory', policy({ owners: ['alice'], dmPolicy: 'open', dangerouslyAllowOpenDm: true })), allowFrom: ['alice'] };
    expect((await resolveStableChannelMessageIngress(params)).senderAccess.decision).toBe('block');
  });
});

describe('real reply payload', () => {
  it('lists the media of a reply the way the test SDK does', () => {
    const fake = replyPayload.resolveOutboundMediaUrls as typeof resolveOutboundMediaUrls;
    for (const payload of [{}, { mediaUrl: '/a.png' }, { mediaUrls: ['/a.png', '/b.png'] }, { mediaUrl: '/a.png', mediaUrls: ['/b.png'] }, { mediaUrl: '/a.png', mediaUrls: [] }, { mediaUrl: '' }]) {
      expect(fake(payload)).toEqual(resolveOutboundMediaUrls(payload));
    }
    expect(resolveOutboundMediaUrls({ mediaUrl: '/a.png', mediaUrls: ['/b.png'] })).toEqual(['/b.png']);
  });
});

describe('real media loader', () => {
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const MB = 1024 * 1024;
  const outside = mkdtempSync(join(tmpdir(), 'oscar-outside-'));
  const media = getMediaDir();
  const chart = join(media, 'outbound', 'chart.png');
  const theirs = join(media, 'inbound', 'theirs.png');
  const secret = join(outside, 'secret.png');
  const load = (url: string, role: 'owner' | 'approved', maxBytes = MB) => loadOutgoing({ url, cfg: {}, role, maxBytes, log: silentLog });

  // A public address in numbers, so no name is looked up. The fetch below never reaches it.
  const REMOTE = 'http://8.8.8.8/slow.bin';
  const seen: boolean[] = [];
  // One part, then silence until the signal fires.
  const stalled = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const signal = init?.signal ?? undefined;
    seen.push(signal !== undefined);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        signal?.addEventListener('abort', () => controller.error(signal.reason));
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'application/octet-stream' } });
  };
  let server: Server;
  let port = 0;
  let hits = 0;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      hits += 1;
      res.writeHead(200, { 'content-type': 'image/png' }).end(PNG);
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    port = (server.address() as { port: number }).port;
    mkdirSync(join(media, 'outbound'), { recursive: true });
    mkdirSync(join(media, 'inbound'), { recursive: true });
    writeFileSync(chart, PNG);
    writeFileSync(theirs, PNG);
    writeFileSync(secret, PNG);
    writeFileSync(join(media, 'outbound', 'empty.txt'), '');
    writeFileSync(join(media, 'outbound', 'big.bin'), Buffer.alloc(MB + 1, 7));
    symlinkSync(join(media, 'inbound'), join(media, 'outbound', 'door'));
  });

  afterAll(async () => {
    await new Promise((done) => server.close(done));
    rmSync(outside, { recursive: true, force: true });
  });

  it("the SDK's loader refuses a path outside the roots", async () => {
    await expect(loadWebMedia(secret, { localRoots: [media], optimizeImages: false })).rejects.toMatchObject({ name: 'LocalMediaAccessError', code: 'path-not-allowed' });
    expect(await load(secret, 'approved')).toEqual({ ok: false, why: 'not-allowed' });
    expect(await load(secret, 'owner')).toEqual({ ok: false, why: 'not-allowed' });
  });

  it('refuses a loopback address and never asks it', async () => {
    for (const host of ['127.0.0.1', 'localhost']) {
      const url = `http://${host}:${port}/x.png`;
      await expect(loadWebMedia(url, { maxBytes: MB, optimizeImages: false }), host).rejects.toThrow(/blocked|private|internal/i);
      expect(await load(url, 'approved'), host).toEqual({ ok: false, why: 'failed' });
      expect(await load(url, 'owner'), host).toEqual({ ok: false, why: 'failed' });
    }
    expect(hits).toBe(0);
    expect((await fetch(`http://127.0.0.1:${port}/x.png`)).status).toBe(200);
    expect(hits).toBe(1);
  });

  it('ends a remote load when the signal fires', async () => {
    const options = buildOutboundMediaLoadOptions({ maxBytes: MB, optimizeImages: false, fetchImpl: stalled, requestInit: { signal: AbortSignal.timeout(200) } });
    const started = Date.now();
    await expect(loadWebMedia(REMOTE, options)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(seen.at(-1)).toBe(true);
  });

  it('ends a remote load that sends nothing for too long', async () => {
    const options = { ...buildOutboundMediaLoadOptions({ maxBytes: MB, optimizeImages: false, fetchImpl: stalled }), readIdleTimeoutMs: 200 };
    const asked = seen.length;
    const started = Date.now();
    await expect(loadWebMedia(REMOTE, options)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(seen.length).toBe(asked + 1);
  });

  it('gives a file of the media folder whole, with its name and type', async () => {
    const got = await load(chart, 'approved');
    expect(got).toMatchObject({ ok: true, name: 'chart.png', contentType: 'image/png' });
    expect(got.ok && Buffer.from(got.bytes).equals(PNG)).toBe(true);
    expect(await load(pathToFileURL(chart).href, 'approved')).toMatchObject({ ok: true, name: 'chart.png' });
  });

  it('gives a received file whatever the roots are, so the plugin keeps it from a person who is not an owner', async () => {
    const got = await loadWebMedia(theirs, { localRoots: [outside], optimizeImages: false });
    expect(got.buffer.equals(PNG)).toBe(true);
    for (const url of [theirs, pathToFileURL(theirs).href, join(media, 'outbound', '..', 'inbound', 'theirs.png'), join(media, 'outbound', 'door', 'theirs.png'), 'media://inbound/theirs.png']) {
      expect(await load(url, 'approved'), url).toEqual({ ok: false, why: 'not-allowed' });
    }
    expect(await load(theirs, 'owner')).toMatchObject({ ok: true });
  });

  it('reports a file over the limit, an empty file and a missing file', async () => {
    expect(await load(join(media, 'outbound', 'big.bin'), 'approved')).toEqual({ ok: false, why: 'too-large' });
    expect(await load(chart, 'approved', 8)).toEqual({ ok: false, why: 'too-large' });
    expect(await load(join(media, 'outbound', 'empty.txt'), 'approved')).toEqual({ ok: false, why: 'empty' });
    const host = { mediaAccess: { localRoots: [media], readFile: async () => PNG } };
    expect(await loadOutgoing({ url: chart, cfg: {}, role: 'owner', maxBytes: 8, host, log: silentLog })).toEqual({ ok: false, why: 'too-large' });
    expect(await loadOutgoing({ url: chart, cfg: {}, role: 'owner', maxBytes: MB, host, log: silentLog })).toMatchObject({ ok: true, name: 'chart.png' });
    // Under a linked temporary folder the loader reports a missing file as a path it does not allow.
    expect(['failed', 'not-allowed']).toContain((await load(join(media, 'outbound', 'gone.png'), 'approved') as { why?: string }).why);
  });
});

describe('real avatar and resize', () => {
  it('says an agent with no avatar has none', () => {
    expect(resolveAgentAvatar({}, 'main').kind).toBe('none');
  });

  it('makes an icon the client takes from a square picture, and none from a wide one', async () => {
    const square = readFileSync(new URL('../../assets/icon.png', import.meta.url));
    const made = await makeIcon(square);
    expect('icon' in made && isOwnIcon(made.icon)).toBe(true);
    const wide = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8DwH4QBEfcD/ePF9e8AAAAASUVORK5CYII=', 'base64');
    expect(await makeIcon(wide)).not.toHaveProperty('icon');
  });
});
