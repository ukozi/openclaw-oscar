import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('openclaw/plugin-sdk/agent-runtime', async () => (await import('../fake/openclaw.js')).agentRuntime);
vi.mock('openclaw/plugin-sdk/media-runtime', async () => (await import('../fake/openclaw.js')).mediaRuntime);
vi.mock('openclaw/plugin-sdk/web-media', async () => (await import('../fake/openclaw.js')).webMedia);
vi.mock('openclaw/plugin-sdk/routing', async () => (await import('../fake/openclaw.js')).routing);

import { ICON_TIMING, createBuddyIcon } from '../../src/icon.js';
import type { BuddyIcon } from '../../src/icon.js';
import { isOwnIcon } from '../../src/oscar/index.js';
import { ICON_JPEG, sdk } from '../fake/openclaw.js';

const u32be = (n: number): number[] => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
const png = (width: number, height: number): Buffer =>
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...u32be(13), ...Buffer.from('IHDR'), ...u32be(width), ...u32be(height), 8, 2, 0, 0, 0]);
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const AVATAR = '/fake/agents/calyssa/avatar.png';
const CFG = { bindings: [{ agentId: 'calyssa', match: { channel: 'oscar', accountId: 'default' } }] };
const TIMING = { ...ICON_TIMING };

type Rig = {
  icon: BuddyIcon; sets: Uint8Array[]; lines: string[]; state: { online: boolean; now: number; refuse: Error | null };
  signOn(): Promise<void>; turn(): Promise<void>;
};

let dir: string;
let file: string;

function rig(over: { enabled?: boolean; setOwnIcon?: (bytes: Uint8Array) => Promise<void> } = {}): Rig {
  const sets: Uint8Array[] = [];
  const lines: string[] = [];
  const state = { online: true, now: 1_000_000, refuse: null as Error | null };
  const timers: (() => void)[] = [];
  const say = (msg: string): void => {
    lines.push(msg);
  };
  const icon = createBuddyIcon({
    accountId: 'default', getCfg: () => CFG, now: () => state.now, file,
    timers: { setTimeout: ((fn: () => void) => timers.push(fn)) as never, clearTimeout: (() => undefined) as never },
    log: { debug: () => undefined, info: say, warn: say, error: say },
    enabled: over.enabled ?? true,
    owner: 'oscar.example.net:5190:botone',
    online: () => state.online,
    setOwnIcon: over.setOwnIcon ?? (async (bytes) => {
      if (state.refuse) throw state.refuse;
      sets.push(bytes);
    }),
  });
  return {
    icon, sets, lines, state,
    async signOn(): Promise<void> {
      icon.onOnline();
      timers.pop()?.();
      await icon.idle();
    },
    async turn(): Promise<void> {
      icon.onTurn();
      await icon.idle();
    },
  };
}

function avatar(bytes: Buffer): void {
  sdk.avatar = { kind: 'local', filePath: AVATAR, source: 'config' };
  sdk.files.set(AVATAR, { buffer: bytes, contentType: 'image/png' });
}

beforeEach(() => {
  sdk.reset();
  dir = mkdtempSync(join(tmpdir(), 'oscar-icon-'));
  file = join(dir, 'icon-default.json');
});
afterEach(() => {
  Object.assign(ICON_TIMING, TIMING);
  rmSync(dir, { recursive: true, force: true });
});

describe('the buddy icon follows the avatar of the agent', () => {
  it('sets a 48 by 48 JPEG of a square avatar after sign-on', async () => {
    avatar(png(256, 256));
    const r = rig();
    r.icon.onOnline();
    expect(sdk.loads).toEqual([]);
    await r.signOn();
    expect(r.sets).toHaveLength(1);
    expect(isOwnIcon(r.sets[0] as Uint8Array)).toBe(true);
    expect(sdk.avatarAsks).toEqual(['calyssa']);
    expect(sdk.loads[0]?.url).toBe(AVATAR);
    expect(sdk.loads[0]?.options.localRoots).toContain('/fake/agents/calyssa');
    expect(sdk.resizes[0]).toMatchObject({ maxSide: 48 });
    expect(r.lines).toHaveLength(1);
  });

  it('sets nothing again for the same avatar, also after a restart', async () => {
    avatar(png(256, 256));
    const first = rig();
    await first.signOn();
    await first.signOn();
    expect(first.sets).toHaveLength(1);
    expect(sdk.loads).toHaveLength(1);
    const second = rig();
    await second.signOn();
    expect(second.sets).toEqual([]);
    expect(second.lines).toEqual([]);
  });

  it('sets the icon again when the avatar changes', async () => {
    avatar(png(256, 256));
    const r = rig();
    await r.signOn();
    sdk.avatar = { kind: 'remote', url: 'https://cdn.example.net/new.png', source: 'config' };
    sdk.remote.set('https://cdn.example.net/new.png', { buffer: png(64, 64) });
    sdk.resize = () => Buffer.concat([ICON_JPEG, Buffer.from('other')]);
    await r.signOn();
    expect(r.sets).toHaveLength(2);
    expect(Buffer.from(r.sets[1] as Uint8Array).equals(Buffer.from(r.sets[0] as Uint8Array))).toBe(false);
  });

  it('lowers the quality until the picture fits', async () => {
    avatar(png(256, 256));
    sdk.resize = (p) => (p.quality > 40 ? Buffer.concat([ICON_JPEG, Buffer.alloc(8000)]) : ICON_JPEG);
    const r = rig();
    await r.signOn();
    expect(r.sets).toHaveLength(1);
    expect((r.sets[0] as Uint8Array).byteLength).toBeLessThanOrEqual(7168);
    const qualities = sdk.resizes.map((x) => x.quality);
    expect(qualities.length).toBeGreaterThan(1);
    expect([...qualities].sort((a, b) => b - a)).toEqual(qualities);
  });

  it('sends a small GIF as it is', async () => {
    avatar(GIF);
    const r = rig();
    await r.signOn();
    expect(r.sets.map((b) => Buffer.from(b))).toEqual([GIF]);
    expect(sdk.resizes).toEqual([]);
  });

  it('reads an avatar given as a data URL', async () => {
    sdk.avatar = { kind: 'data', url: `data:image/png;base64,${png(128, 128).toString('base64')}`, source: 'config' };
    const r = rig();
    await r.signOn();
    expect(r.sets).toHaveLength(1);
    expect(sdk.loads).toEqual([]);
  });

  it('leaves the icon alone with no avatar and says so one time', async () => {
    const r = rig();
    await r.signOn();
    await r.signOn();
    expect(r.sets).toEqual([]);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatch(/no avatar/);
  });

  it('leaves the icon alone when the avatar cannot be loaded or is no picture', async () => {
    avatar(png(256, 256));
    sdk.loadFail = new Error('boom');
    const failed = rig();
    await failed.signOn();
    await failed.signOn();
    expect(failed.sets).toEqual([]);
    expect(failed.lines).toHaveLength(1);

    sdk.loadFail = undefined;
    avatar(Buffer.from('not a picture at all'));
    const text = rig();
    await text.signOn();
    expect(text.sets).toEqual([]);
    expect(text.lines).toHaveLength(1);
    expect(sdk.resizes).toEqual([]);
  });

  it('leaves the icon alone when the avatar is not square', async () => {
    avatar(png(300, 200));
    const r = rig();
    await r.signOn();
    expect(r.sets).toEqual([]);
    expect(sdk.resizes).toEqual([]);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatch(/square/);
  });

  it('leaves the icon alone when no quality gives a picture that fits', async () => {
    avatar(png(256, 256));
    sdk.resize = () => Buffer.concat([ICON_JPEG, Buffer.alloc(8000)]);
    const r = rig();
    await r.signOn();
    expect(r.sets).toEqual([]);
    expect(r.lines).toHaveLength(1);
  });

  it('does nothing with the setting off, and forgets the icon it set', async () => {
    avatar(png(256, 256));
    await rig().signOn();
    expect(existsSync(file)).toBe(true);
    const off = rig({ enabled: false });
    await off.signOn();
    await off.turn();
    expect(off.sets).toEqual([]);
    expect(off.lines).toHaveLength(1);
    expect(off.lines[0]).toMatch(/setting/);
    expect(existsSync(file)).toBe(false);
    expect(sdk.avatarAsks).toHaveLength(1);
  });

  it('does not try a refused icon again until the avatar changes', async () => {
    avatar(png(256, 256));
    const r = rig();
    r.state.refuse = new Error('refused');
    await r.signOn();
    await r.signOn();
    expect(r.lines).toHaveLength(1);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ ok: false });
    const next = rig();
    await next.signOn();
    expect(next.sets).toEqual([]);
    expect(next.lines).toEqual([]);

    sdk.resize = () => Buffer.concat([ICON_JPEG, Buffer.from('other')]);
    avatar(png(128, 128));
    sdk.avatar = { kind: 'local', filePath: AVATAR, source: 'identity' };
    const changed = rig();
    await changed.signOn();
    expect(changed.sets).toHaveLength(1);
  });

  it('tries again after the next sign-on when the connection was lost', async () => {
    avatar(png(256, 256));
    const r = rig();
    r.state.online = false;
    await r.signOn();
    expect(r.sets).toEqual([]);
    expect(r.lines).toEqual([]);
    r.state.online = true;
    await r.signOn();
    expect(r.sets).toHaveLength(1);
  });

  it('gives up on a set or a load that never ends', async () => {
    ICON_TIMING.stepMs = 40;
    avatar(png(256, 256));
    const stuck = rig({ setOwnIcon: () => new Promise(() => undefined) });
    await stuck.signOn();
    expect(stuck.lines).toHaveLength(1);

    sdk.loadHangs = 'for-ever';
    avatar(png(128, 128));
    sdk.avatar = { kind: 'remote', url: 'https://cdn.example.net/slow.png', source: 'config' };
    const slow = rig();
    await slow.signOn();
    expect(slow.sets).toEqual([]);
    expect(slow.lines).toHaveLength(1);
  });

  it('looks again at the start of a turn, at most every ten minutes', async () => {
    const r = rig();
    await r.turn();
    expect(sdk.avatarAsks).toEqual([]);
    await r.signOn();
    expect(sdk.avatarAsks).toHaveLength(1);
    r.state.now += ICON_TIMING.lookEveryMs - 1;
    await r.turn();
    expect(sdk.avatarAsks).toHaveLength(1);
    r.state.now += 1;
    avatar(png(256, 256));
    await r.turn();
    expect(sdk.avatarAsks).toHaveLength(2);
    expect(r.sets).toHaveLength(1);
    await r.turn();
    expect(sdk.avatarAsks).toHaveLength(2);
  });

  it('a look that throws breaks nothing', async () => {
    sdk.avatar = null as never;
    const r = rig();
    await r.signOn();
    expect(r.sets).toEqual([]);
    expect(r.lines).toHaveLength(1);
  });
});
