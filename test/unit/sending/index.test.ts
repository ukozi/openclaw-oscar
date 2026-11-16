import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('openclaw/plugin-sdk/web-media', async () => (await import('../../fake/openclaw.js')).webMedia);
vi.mock('openclaw/plugin-sdk/media-runtime', async () => (await import('../../fake/openclaw.js')).mediaRuntime);
vi.mock('openclaw/plugin-sdk/reply-chunking', async () => (await import('../../fake/openclaw.js')).replyChunking);
vi.mock('openclaw/plugin-sdk/channel-outbound', async () => (await import('../../fake/openclaw.js')).channelOutbound);
vi.mock('openclaw/plugin-sdk/routing', async () => (await import('../../fake/openclaw.js')).routing);

import type { RoomRef } from '../../../src/names.js';
import { applyRoomReady, resetRuntimeForTests, setRuntime } from '../../../src/runtime.js';
import type { AccountRuntime } from '../../../src/runtime.js';
import { createMediaSender } from '../../../src/sending/index.js';
import type { HostAccess } from '../../../src/sending/load.js';
import type { SendProblem } from '../../../src/sending/notes.js';
import type { OutFile, Picture } from '../../../src/sending/plan.js';
import type { SendOutcome } from '../../../src/sending/send-file.js';
import { FAKE_MEDIA_DIR, sdk } from '../../fake/openclaw.js';
import { FakeSession } from '../../fake/session.js';
import { silentLog } from '../rooms-fixtures.js';

const MB = 1024 * 1024;
const u32be = (n: number): number[] => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...u32be(13), ...Buffer.from('IHDR'), ...u32be(8), ...u32be(6), 8, 2, 0, 0, 0]);
const NOTES = Buffer.from('# Notes\n\nBring the cake.\n');
const CHART = `${FAKE_MEDIA_DIR}/outbound/chart.png`;
const REPORT = `${FAKE_MEDIA_DIR}/outbound/report.md`;
const MEMORY = '/fake/agents/helper/MEMORY.md';
const LINK = 'https://files.example.net/report.md';
const ROOM: RoomRef = { exchange: 4, name: 'testroom' };

type End = (outcome: SendOutcome) => void;

function setup(files: Record<string, unknown> | undefined = { directIm: true, sendFile: true }, over: Record<string, unknown> = {}) {
  let cfg: unknown = {
    channels: { oscar: { host: 'h', screenName: 'botone', password: 'hunter22', owners: ['alice'], allowFrom: ['bob'], ...(files ? { files } : {}), ...over } },
  };
  const session = new FakeSession();
  const rt: AccountRuntime = { accountId: 'default', session: session.asSession(), rooms: new Map(), sessionKeys: new Map(), lastReplyAt: new Map(), counters: { droppedSends: 0, eventGaps: 0 } };
  setRuntime(rt);
  session.setState({ phase: 'online' });
  const notes: { to: string; why: SendProblem; link?: string }[] = [];
  const roomNotes: { room: RoomRef; why: SendProblem }[] = [];
  const pictures: { to: string; pictures: Picture[]; end: End }[] = [];
  const offers: { to: string; files: OutFile[]; end: End; check?: () => boolean }[] = [];
  const state = { offer: 'queued' as 'queued' | 'too-many', picture: 'queued' as 'queued' | 'too-many', stopped: 0 };
  const on = (files ?? {}) as { directIm?: boolean; sendFile?: boolean };
  const sender = createMediaSender({
    accountId: 'default', self: () => 'botone', getCfg: () => cfg, now: () => 1, log: silentLog,
    presenceOf: (name) => session.asSession().presenceOf(name),
    files: on.sendFile
      ? {
          offer: (to, list, end, check) => {
            if (state.offer === 'queued') offers.push({ to, files: list, end, ...(check ? { check } : {}) });
            return state.offer;
          },
          stop: () => void (state.stopped += 1),
          idle: async () => undefined,
        }
      : undefined,
    directIm: on.directIm
      ? {
          send: (to, list, end) => {
            if (state.picture === 'queued') pictures.push({ to, pictures: list, end });
            return state.picture;
          },
        }
      : undefined,
    note: (to, why, link) => void notes.push({ to, why, ...(link ? { link } : {}) }),
    roomNote: (room, why) => void roomNotes.push({ room, why }),
  });
  const send = (to: string, urls: string[], extra: { host?: HostAccess; agentId?: string } = {}) =>
    sender.sendMediaTo({ cfg, accountId: 'default', to, urls, agentId: 'helper', ...extra });
  return { sender, send, session, rt, notes, roomNotes, pictures, offers, state, setCfg: (next: unknown) => void (cfg = next) };
}

beforeEach(() => {
  sdk.reset();
  resetRuntimeForTests();
  sdk.files.set(CHART, { buffer: PNG, contentType: 'image/png' });
  sdk.files.set(REPORT, { buffer: NOTES, contentType: 'text/markdown' });
  sdk.files.set(MEMORY, { buffer: NOTES, contentType: 'text/markdown' });
  sdk.remote.set(LINK, { buffer: NOTES, contentType: 'text/markdown', fileName: 'report.md' });
});

describe('sendMediaTo', () => {
  it('sends the text and then the picture over Direct IM', async () => {
    const t = setup();
    await t.send('Alice', [CHART]);
    expect(t.pictures.map((p) => ({ to: p.to, pictures: p.pictures }))).toEqual([
      { to: 'alice', pictures: [{ name: 'chart.png', bytes: new Uint8Array(PNG), width: 8, height: 6 }] },
    ]);
    expect(t.offers).toEqual([]);
    expect(t.notes).toEqual([]);
    // The text is the caller's: the sender itself writes no IM.
    expect(t.session.sent).toEqual([]);
  });

  it('sends a file over Send File', async () => {
    const t = setup();
    await t.send('bob', [REPORT]);
    expect(t.offers.map((o) => ({ to: o.to, files: o.files }))).toEqual([{ to: 'bob', files: [{ name: 'report.md', bytes: new Uint8Array(NOTES) }] }]);
    expect(t.pictures).toEqual([]);
    expect(t.notes).toEqual([]);
  });

  it('sends the pictures of one reply together and its files in one offer', async () => {
    const t = setup();
    await t.send('alice', [CHART, REPORT, CHART]);
    expect(t.pictures.map((p) => p.pictures.map((x) => x.name))).toEqual([['chart.png', 'chart.png']]);
    expect(t.offers.map((o) => o.files.map((f) => f.name))).toEqual([['report.md']]);
  });

  it('sends a picture over Send File when only that is on', async () => {
    const t = setup({ sendFile: true });
    await t.send('alice', [CHART]);
    expect(t.offers.map((o) => o.files)).toEqual([[{ name: 'chart.png', bytes: new Uint8Array(PNG) }]]);
    expect(t.notes).toEqual([]);
  });

  it("says it can't send a file when only Direct IM is on, and still sends the picture", async () => {
    const t = setup({ directIm: true });
    await t.send('alice', [REPORT, CHART]);
    expect(t.notes).toEqual([{ to: 'alice', why: 'off' }]);
    expect(t.pictures).toHaveLength(1);
  });

  it("says it can't send here when both settings are off, and still sends the text", async () => {
    const t = setup({});
    await t.send('alice', [CHART]);
    expect(t.notes).toEqual([{ to: 'alice', why: 'off' }]);
    expect(sdk.loads).toEqual([]);
  });

  it("says it can't send here in a room, in the room", async () => {
    const t = setup();
    applyRoomReady(t.rt, ROOM, ['botone', 'alice'], 'botone', 1);
    await t.send('room:testroom', [CHART]);
    expect(t.roomNotes).toEqual([{ room: ROOM, why: 'off' }]);
    expect(t.notes).toEqual([]);
    expect(sdk.loads).toEqual([]);
    expect(t.pictures).toEqual([]);
    expect(t.offers).toEqual([]);
  });

  it('sends nothing and says nothing to a stranger, even with outbound.allowUnlisted', async () => {
    for (const over of [{}, { outbound: { allowUnlisted: true } }]) {
      const t = setup({ directIm: true, sendFile: true }, over);
      await t.send('mallory', [CHART, LINK]);
      expect([t.notes, t.roomNotes, t.pictures, t.offers, sdk.loads]).toEqual([[], [], [], [], []]);
    }
  });

  it('sends nothing to a teammate bot', async () => {
    const t = setup({ directIm: true, sendFile: true }, { chain: { roster: [{ screenName: 'botone' }, { screenName: 'bottwo' }] }, allowFrom: ['bob', 'bottwo'] });
    await t.send('bottwo', [CHART]);
    await t.send('botone', [CHART]);
    expect([t.notes, t.roomNotes, t.pictures, t.offers, sdk.loads]).toEqual([[], [], [], [], []]);
  });

  it('tells a person who is signed off, with the link for a url', async () => {
    const t = setup();
    t.session.setPresence('alice', { online: false });
    await t.send('alice', [CHART, LINK]);
    expect(t.notes).toEqual([{ to: 'alice', why: 'failed' }, { to: 'alice', why: 'failed', link: LINK }]);
    expect(sdk.loads).toEqual([]);
  });

  it('tells a person who is signed off about three files at most', async () => {
    const t = setup();
    t.session.setPresence('alice', { online: false });
    const links = [1, 2, 3, 4, 5].map((n) => `https://files.example.net/${n}.md`);
    await t.send('alice', links);
    expect(t.notes).toEqual([{ to: 'alice', why: 'too-many' }, ...links.slice(0, 3).map((link) => ({ to: 'alice', why: 'failed', link }))]);
    expect(sdk.loads).toEqual([]);
  });

  it('sends to a person whose presence is not known', async () => {
    const t = setup();
    await t.send('bob', [REPORT]);
    expect(t.offers).toHaveLength(1);
  });

  it('says the file could not be sent while the account is not signed on, and loads nothing', async () => {
    const t = setup();
    t.session.setState({ phase: 'connecting' });
    await t.send('alice', [LINK]);
    expect(t.notes).toEqual([{ to: 'alice', why: 'failed', link: LINK }]);
    expect(sdk.loads).toEqual([]);
  });

  it("loads with the owner's access for an owner and the media folder for an approved person", async () => {
    const t = setup();
    const host: HostAccess = { mediaLocalRoots: ['/fake/agents/helper'] };
    await t.send('alice', [MEMORY], { host });
    expect(sdk.loads.at(-1)?.options).toMatchObject({ localRoots: ['/fake/agents/helper'] });
    expect(t.offers.map((o) => o.to)).toEqual(['alice']);

    await t.send('alice', [MEMORY]);
    expect(sdk.loads.at(-1)?.options).toMatchObject({ localRoots: [FAKE_MEDIA_DIR, '/fake/state/workspace', '/fake/agents/helper'] });
    expect(t.offers.map((o) => o.to)).toEqual(['alice', 'alice']);

    const before = sdk.loads.length;
    await t.send('bob', [MEMORY], { host });
    expect(sdk.loads).toHaveLength(before);
    expect(t.notes).toEqual([{ to: 'bob', why: 'failed' }]);
    await t.send('bob', [REPORT], { host });
    expect(sdk.loads.at(-1)?.options).toMatchObject({ localRoots: [FAKE_MEDIA_DIR] });
    expect(t.offers.map((o) => o.to)).toEqual(['alice', 'alice', 'bob']);
  });

  it('says the file is too large', async () => {
    const t = setup({ sendFile: true, maxMb: 1 });
    sdk.files.set(`${FAKE_MEDIA_DIR}/outbound/big.bin`, { buffer: Buffer.alloc(MB + 1, 0x61) });
    await t.send('alice', [`${FAKE_MEDIA_DIR}/outbound/big.bin`]);
    expect(t.notes).toEqual([{ to: 'alice', why: 'too-large' }]);
    expect(t.offers).toEqual([]);
    expect(sdk.loads.at(-1)?.options).toMatchObject({ maxBytes: MB });
  });

  it('says so when more than three were handed over, and sends three', async () => {
    const t = setup();
    await t.send('alice', [REPORT, REPORT, REPORT, REPORT, REPORT]);
    expect(t.notes).toEqual([{ to: 'alice', why: 'too-many' }]);
    expect(sdk.loads).toHaveLength(3);
    expect(t.offers.map((o) => o.files.length)).toEqual([3]);
  });

  it('says so when the person already has three files waiting', async () => {
    const t = setup();
    t.state.offer = 'too-many';
    await t.send('alice', [REPORT]);
    expect(t.notes).toEqual([{ to: 'alice', why: 'too-many' }]);
  });

  it('says so when the person already has three pictures waiting', async () => {
    const t = setup();
    t.state.picture = 'too-many';
    await t.send('alice', [CHART]);
    expect(t.notes).toEqual([{ to: 'alice', why: 'too-many' }]);
    expect(t.pictures).toEqual([]);
  });

  it('gives the file sender a check of the setting and the person for the time the offer goes out', async () => {
    const t = setup();
    await t.send('bob', [REPORT]);
    const check = t.offers[0]?.check;
    expect(check?.()).toBe(true);
    t.setCfg({ channels: { oscar: { owners: ['alice'], allowFrom: ['bob'], files: { directIm: true, sendFile: false } } } });
    expect(check?.()).toBe(false);
    t.setCfg({ channels: { oscar: { owners: ['alice'], allowFrom: ['bob'], files: { sendFile: true } } } });
    expect(check?.()).toBe(true);
    t.setCfg({ channels: { oscar: { owners: ['alice'], files: { sendFile: true } } } });
    expect(check?.()).toBe(false);
  });

  it('says nothing about a failed send to a person who was taken off the lists', async () => {
    const t = setup();
    await t.send('bob', [REPORT, CHART]);
    t.setCfg({ channels: { oscar: { owners: ['alice'], files: { directIm: true, sendFile: true } } } });
    t.offers[0]?.end('failed');
    t.pictures[0]?.end('failed');
    expect(t.notes).toEqual([]);
  });

  it('sends nothing to its own name', async () => {
    const t = setup({ directIm: true, sendFile: true }, { owners: ['alice', 'botone'] });
    await t.send('BotOne', [CHART, REPORT]);
    expect([t.notes, t.pictures, t.offers, sdk.loads]).toEqual([[], [], [], []]);
  });

  it('says so when the transfer fails, and gives the link for a url', async () => {
    const t = setup();
    await t.send('alice', [LINK, REPORT]);
    await t.send('alice', [CHART]);
    expect(t.notes).toEqual([]);
    t.offers[0]?.end('failed');
    expect(t.notes).toEqual([{ to: 'alice', why: 'failed', link: LINK }, { to: 'alice', why: 'failed' }]);
    t.pictures[0]?.end('failed');
    expect(t.notes).toHaveLength(3);
  });

  it('says nothing when the transfer ends well', async () => {
    const t = setup();
    await t.send('alice', [REPORT, CHART]);
    t.offers[0]?.end('done');
    t.pictures[0]?.end('done');
    expect(t.notes).toEqual([]);
  });

  it('never throws when the loader throws', async () => {
    const t = setup();
    sdk.loadFail = new Error('boom');
    await expect(t.send('alice', [REPORT, LINK])).resolves.toBeUndefined();
    expect(t.notes).toEqual([{ to: 'alice', why: 'failed' }, { to: 'alice', why: 'failed', link: LINK }]);
    expect(t.offers).toEqual([]);
  });

  it('never throws when a sender throws', async () => {
    const broken = createMediaSender({
      accountId: 'default', self: () => 'botone', getCfg: () => ({ channels: { oscar: { owners: ['alice'], files: { sendFile: true } } } }), now: () => 1, log: silentLog,
      presenceOf: () => undefined,
      files: { offer: () => { throw new Error('boom'); }, stop: () => undefined, idle: async () => undefined },
      directIm: undefined,
      note: () => undefined,
      roomNote: () => undefined,
    });
    await expect(broken.sendMediaTo({ cfg: {}, accountId: 'default', to: 'alice', urls: [REPORT] })).resolves.toBeUndefined();
  });

  it('offers nothing when the person was taken off the lists while the file loaded', async () => {
    const t = setup();
    const host: HostAccess = {
      mediaLocalRoots: ['/fake/agents/helper'],
      mediaReadFile: async () => {
        t.setCfg({ channels: { oscar: { host: 'h', screenName: 'botone', password: 'hunter22', owners: ['bob'], files: { sendFile: true } } } });
        return NOTES;
      },
    };
    await t.send('alice', [MEMORY], { host });
    expect(sdk.loads).toHaveLength(1);
    expect([t.offers, t.notes]).toEqual([[], []]);
  });

  it('offers nothing when an owner became an approved person while the file loaded', async () => {
    const t = setup();
    const host: HostAccess = {
      mediaLocalRoots: ['/fake/agents/helper'],
      mediaReadFile: async () => {
        t.setCfg({ channels: { oscar: { host: 'h', screenName: 'botone', password: 'hunter22', owners: ['bob'], allowFrom: ['alice'], files: { sendFile: true } } } });
        return NOTES;
      },
    };
    await t.send('alice', [MEMORY], { host });
    expect(sdk.loads).toHaveLength(1);
    expect([t.offers, t.notes]).toEqual([[], []]);
  });

  it('skips an empty list and empty entries', async () => {
    const t = setup();
    await t.send('alice', []);
    await t.send('alice', ['', '  ']);
    expect([t.notes, t.pictures, t.offers, sdk.loads]).toEqual([[], [], [], []]);
  });

  it('stops its file sender, and sends and says nothing afterwards', async () => {
    const t = setup();
    await t.send('alice', [REPORT]);
    t.sender.stop();
    expect(t.state.stopped).toBe(1);
    await t.send('alice', [REPORT]);
    t.offers[0]?.end('failed');
    expect(t.offers).toHaveLength(1);
    expect(t.notes).toEqual([]);
  });
});
