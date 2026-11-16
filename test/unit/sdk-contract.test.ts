import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveStableChannelMessageIngress } from 'openclaw/plugin-sdk/channel-ingress-runtime';
import { getMediaDir } from 'openclaw/plugin-sdk/media-runtime';
import { loadWebMedia } from 'openclaw/plugin-sdk/web-media';
import { beforeAll, describe, expect, it } from 'vitest';
import { readPolicy } from '../../src/config.js';
import { ingressParams } from '../../src/inbound/im.js';
import { loadOutgoing } from '../../src/sending/load.js';
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

describe('real media loader', () => {
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const MB = 1024 * 1024;
  const outside = mkdtempSync(join(tmpdir(), 'oscar-outside-'));
  const media = getMediaDir();
  const chart = join(media, 'outbound', 'chart.png');
  const theirs = join(media, 'inbound', 'theirs.png');
  const secret = join(outside, 'secret.png');
  const load = (url: string, role: 'owner' | 'approved', maxBytes = MB) => loadOutgoing({ url, cfg: {}, role, maxBytes, log: silentLog });

  beforeAll(() => {
    mkdirSync(join(media, 'outbound'), { recursive: true });
    mkdirSync(join(media, 'inbound'), { recursive: true });
    writeFileSync(chart, PNG);
    writeFileSync(theirs, PNG);
    writeFileSync(secret, PNG);
    writeFileSync(join(media, 'outbound', 'empty.txt'), '');
    writeFileSync(join(media, 'outbound', 'big.bin'), Buffer.alloc(MB + 1, 7));
    symlinkSync(join(media, 'inbound'), join(media, 'outbound', 'door'));
  });

  it("the SDK's loader refuses a path outside the roots", async () => {
    await expect(loadWebMedia(secret, { localRoots: [media], optimizeImages: false })).rejects.toMatchObject({ name: 'LocalMediaAccessError', code: 'path-not-allowed' });
    expect(await load(secret, 'approved')).toEqual({ ok: false, why: 'not-allowed' });
    expect(await load(secret, 'owner')).toEqual({ ok: false, why: 'not-allowed' });
  });

  it('refuses a loopback address', async () => {
    await expect(loadWebMedia('http://127.0.0.1:9/x.png', { maxBytes: MB, optimizeImages: false })).rejects.toThrow();
    expect(await load('http://127.0.0.1:9/x.png', 'approved')).toEqual({ ok: false, why: 'failed' });
    expect(await load('http://localhost:9/x.png', 'owner')).toEqual({ ok: false, why: 'failed' });
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
