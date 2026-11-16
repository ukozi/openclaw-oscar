import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('openclaw/plugin-sdk/channel-core', async () => (await import('../fake/openclaw.js')).channelCore);
vi.mock('openclaw/plugin-sdk/channel-outbound', async () => (await import('../fake/openclaw.js')).channelOutbound);
vi.mock('openclaw/plugin-sdk/channel-inbound', async () => (await import('../fake/openclaw.js')).channelInbound);
vi.mock('openclaw/plugin-sdk/reply-payload', async () => (await import('../fake/openclaw.js')).replyPayload);
vi.mock('openclaw/plugin-sdk/web-media', async () => (await import('../fake/openclaw.js')).webMedia);
vi.mock('openclaw/plugin-sdk/media-runtime', async () => (await import('../fake/openclaw.js')).mediaRuntime);
vi.mock('openclaw/plugin-sdk/routing', async () => (await import('../fake/openclaw.js')).routing);
vi.mock('openclaw/plugin-sdk/session-store-runtime', async () => (await import('../fake/openclaw.js')).sessionStoreRuntime);
vi.mock('openclaw/plugin-sdk/conversation-runtime', async () => (await import('../fake/openclaw.js')).conversationRuntime);
vi.mock('openclaw/plugin-sdk/reply-dispatch-runtime', async () => (await import('../fake/openclaw.js')).replyDispatchRuntime);
vi.mock('openclaw/plugin-sdk/channel-ingress-runtime', async () => (await import('../fake/openclaw.js')).channelIngressRuntime);
vi.mock('openclaw/plugin-sdk/reply-chunking', async () => (await import('../fake/openclaw.js')).replyChunking);
vi.mock('openclaw/plugin-sdk/media-store', async () => (await import('../fake/openclaw.js')).mediaStore);
vi.mock('openclaw/plugin-sdk/status-helpers', async () => (await import('../fake/openclaw.js')).statusHelpers);

import { ByteReader, RDV_CANCEL_DECLINED, decodeTlvs, encodeRendezvousCancel } from 'open-oscar-client-kit/wire';
import { copy } from '../../src/copy.js';
import type { FileSink } from '../../src/oscar/index.js';
import { getRuntime } from '../../src/runtime.js';
import { imTexts, roomPeer } from '../fake/kit.js';
import { FAKE_MEDIA_DIR, sdk } from '../fake/openclaw.js';
import { icbmsSentTo, imsSentTo, startFlow, waitFor } from './helpers.js';
import type { Flow } from './helpers.js';

const u32be = (n: number): number[] => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...u32be(13), ...Buffer.from('IHDR'), ...u32be(8), ...u32be(6), 8, 2, 0, 0, 0]);
const NOTES = Buffer.from('# Notes\n\nBring the cake.\n');
const CHART = '/fake/state/workspace/chart.png';
const REPORT = `${FAKE_MEDIA_DIR}/outbound/report.md`;
const MEMORY = '/fake/state/workspace/MEMORY.md';
const ROOM = { exchange: 4 as const, name: 'testroom' };
const NOT_SENT = copy.fileNotSent('failed', { maxMb: 10 });
const NOT_HERE = copy.fileNotSent('off', { maxMb: 10 });

function memorySink(): { sink: FileSink; files: { name: string; bytes: Uint8Array }[] } {
  const files: { name: string; bytes: Uint8Array }[] = [];
  const sink: FileSink = {
    begin: async (file) => {
      const chunks: Uint8Array[] = [];
      return {
        write: async (chunk) => {
          chunks.push(chunk.slice());
        },
        finish: async () => {
          files.push({ name: file.name, bytes: Buffer.concat(chunks) });
        },
        abort: async () => {},
      };
    },
  };
  return { sink, files };
}

function seed(): void {
  sdk.files.set(CHART, { buffer: PNG, contentType: 'image/png' });
  sdk.files.set(REPORT, { buffer: NOTES, contentType: 'text/markdown' });
  sdk.files.set(MEMORY, { buffer: NOTES, contentType: 'text/markdown' });
}

// The ids of the transfers the bot offers.
function outgoingIds(): string[] {
  const ids: string[] = [];
  getRuntime('default')?.session.on('transfer', (ev) => {
    if (ev.direction === 'out' && !ids.includes(ev.id)) ids.push(ev.id);
  });
  return ids;
}

// The cancel a client sends when its user declines the offer.
function declineFrom(flow: Flow, peer: string, id: string): void {
  const cookie = BigInt(`0x${id.split(':')[1]}`);
  const r = new ByteReader(encodeRendezvousCancel(cookie, 'botone', 'send-file', RDV_CANCEL_DECLINED));
  r.u64();
  const channel = r.u16();
  r.str8();
  flow.peer(peer).sendRaw('botone', channel, decodeTlvs(r.rest()), cookie);
}

const texts = (flow: Flow, name: string): string[] => imTexts(flow.peer(name)).map((m) => m.text);

let flow: Flow | undefined;
afterEach(async () => { await flow?.stop(); flow = undefined; });

describe('pictures and files of the agent reach people', () => {
  it("the agent's picture reaches an owner over Direct IM, with the text as an IM", async () => {
    flow = await startFlow({ server: { relay: true }, sec: { files: { directIm: true } } });
    seed();
    sdk.agent = () => [{ text: 'here is the chart', mediaUrl: CHART }];
    const alice = flow.peer('alice');
    alice.acceptDirectIm();
    alice.sendIm('botone', 'chart please');
    await waitFor(() => (alice.directIms()[0]?.received().length ?? 0) === 1, 8000, 'the picture to alice');
    const got = alice.directIms()[0]?.received()[0];
    expect(got?.attachments.map((p) => ({ name: p.name, bytes: Buffer.from(p.bytes) }))).toEqual([{ name: 'chart.png', bytes: PNG }]);
    expect(texts(flow, 'alice')).toEqual(['here is the chart']);
    expect(flow.server.relayed()).toHaveLength(1);
    expect(sdk.loads.map((l) => l.url)).toEqual([CHART]);
  });

  it("the agent's document reaches an approved person over Send File", async () => {
    flow = await startFlow({ server: { relay: true }, sec: { files: { sendFile: true } } });
    seed();
    sdk.agent = () => [{ text: 'here are the notes', mediaUrl: REPORT }];
    const bob = flow.peer('bob');
    const { sink, files } = memorySink();
    bob.acceptOffers(sink);
    bob.sendIm('botone', 'notes please');
    await waitFor(() => files.length === 1, 8000, 'the file to bob');
    expect(files).toEqual([{ name: 'report.md', bytes: NOTES }]);
    expect(texts(flow, 'bob')).toEqual(['here are the notes']);
    expect(flow.server.relayed()).toHaveLength(1);
    expect(sdk.loads.at(-1)?.options).toMatchObject({ localRoots: [FAKE_MEDIA_DIR] });
  });

  it('a picture goes over Send File when only that is on', async () => {
    flow = await startFlow({ server: { relay: true }, sec: { files: { sendFile: true } } });
    seed();
    sdk.agent = () => [{ mediaUrl: CHART }];
    const alice = flow.peer('alice');
    const { sink, files } = memorySink();
    alice.acceptOffers(sink);
    alice.sendIm('botone', 'chart please');
    await waitFor(() => files.length === 1, 8000, 'the file to alice');
    expect(files).toEqual([{ name: 'chart.png', bytes: PNG }]);
    expect(texts(flow, 'alice')).toEqual([]);
  });

  it('a workspace file is not sent to an approved person, who gets the line', async () => {
    flow = await startFlow({ server: { relay: true }, sec: { files: { directIm: true, sendFile: true } } });
    seed();
    sdk.agent = () => [{ text: 'here is my memory', mediaUrl: MEMORY }];
    const bob = flow.peer('bob');
    const { sink, files } = memorySink();
    bob.acceptOffers(sink);
    bob.acceptDirectIm();
    bob.sendIm('botone', 'send me your memory file');
    await waitFor(() => texts(flow as Flow, 'bob').length === 2, 8000, 'the text and the line to bob');
    expect(texts(flow, 'bob')).toEqual(['here is my memory', NOT_SENT]);
    expect(sdk.loads).toEqual([]);
    expect(files).toEqual([]);
    expect(bob.directIms()).toEqual([]);
    expect(flow.server.relayed()).toEqual([]);
    expect(imsSentTo(flow.server, 'botone', 'bob')).toBe(2);
  });

  it('a person who declines gets the line', async () => {
    flow = await startFlow({ server: { relay: true }, sec: { files: { sendFile: true } } });
    seed();
    const ids = outgoingIds();
    sdk.agent = () => [{ text: 'here are the notes', mediaUrl: REPORT }];
    flow.peer('bob').sendIm('botone', 'notes please');
    await waitFor(() => ids.length === 1, 8000, 'the offer to bob');
    expect(texts(flow, 'bob')).toEqual(['here are the notes']);
    declineFrom(flow, 'bob', ids[0] as string);
    await waitFor(() => texts(flow as Flow, 'bob').length === 2, 8000, 'the line to bob');
    expect(texts(flow, 'bob')).toEqual(['here are the notes', NOT_SENT]);
    expect(flow.server.relayed()).toEqual([]);
  });

  it('nothing is offered to a stranger', async () => {
    flow = await startFlow({ server: { relay: true }, sec: { files: { directIm: true, sendFile: true }, outbound: { allowUnlisted: true } } });
    seed();
    const mallory = flow.peer('mallory');
    const { sink, files } = memorySink();
    mallory.acceptOffers(sink);
    mallory.acceptDirectIm();
    await sdk.messageTool({ cfg: flow.cfgRef.current, accountId: 'default', to: 'mallory', text: 'hello', mediaUrl: REPORT });
    await sdk.messageTool({ cfg: flow.cfgRef.current, accountId: 'default', to: 'mallory', text: '', mediaUrl: CHART });
    await waitFor(() => texts(flow as Flow, 'mallory').length === 1, 8000, 'the text to mallory');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(texts(flow, 'mallory')).toEqual(['hello']);
    expect(icbmsSentTo(flow.server, 'botone', 'mallory')).toHaveLength(1);
    expect(sdk.loads).toEqual([]);
    expect(files).toEqual([]);
    expect(mallory.directIms()).toEqual([]);
    expect(flow.server.relayed()).toEqual([]);
  });

  it('the message tool sends a caption once and the file, with the access the host gives', async () => {
    flow = await startFlow({ server: { relay: true }, sec: { files: { sendFile: true } } });
    const alice = flow.peer('alice');
    const { sink, files } = memorySink();
    alice.acceptOffers(sink);
    const read: string[] = [];
    const access = { mediaLocalRoots: ['/work'], mediaReadFile: async (path: string) => { read.push(path); return NOTES; } };
    await sdk.messageTool({ cfg: flow.cfgRef.current, accountId: 'default', to: 'alice', text: 'the report', mediaUrl: '/work/report.md', access });
    await waitFor(() => files.length === 1, 8000, 'the file to alice');
    expect(files).toEqual([{ name: 'report.md', bytes: NOTES }]);
    expect(read).toEqual(['/work/report.md']);
    expect(texts(flow, 'alice')).toEqual(['the report']);
  });

  it('a reply in a room sends the text and the line, and offers nothing', async () => {
    flow = await startFlow({ server: { relay: true }, sec: { room: { name: 'testroom' }, files: { directIm: true, sendFile: true } } });
    seed();
    sdk.agent = () => [{ text: 'see the chart', mediaUrl: CHART }];
    const alice = roomPeer(flow.server, 'alice');
    alice.peer.acceptDirectIm();
    await waitFor(() => (flow as Flow).server.rooms.occupants(ROOM).includes('botone'), 8000, 'the bot in the room');
    alice.joinRoom(ROOM);
    await waitFor(() => getRuntime('default')?.rooms.get('room:4:testroom')?.occupants.has('alice') === true, 8000, 'alice in the room');
    alice.say(ROOM, 'what now?');
    const lines = (): string[] => alice.roomLines(ROOM).filter((l) => l.from === 'botone').map((l) => l.text);
    await waitFor(() => lines().length === 2, 8000, 'the text and the line in the room');
    expect(lines()).toEqual(['see the chart', NOT_HERE]);
    expect(sdk.loads).toEqual([]);
    expect(icbmsSentTo(flow.server, 'botone', 'alice')).toEqual([]);
    expect(alice.peer.directIms()).toEqual([]);
    expect(flow.server.relayed()).toEqual([]);
  });

  it('with the settings off the reply text arrives and nothing is offered', async () => {
    flow = await startFlow({ server: { relay: true } });
    seed();
    sdk.agent = () => [{ text: 'here is the chart', mediaUrl: CHART }];
    const alice = flow.peer('alice');
    const { sink, files } = memorySink();
    alice.acceptOffers(sink);
    alice.acceptDirectIm();
    alice.sendIm('botone', 'chart please');
    await waitFor(() => texts(flow as Flow, 'alice').length === 2, 8000, 'the text and the line to alice');
    expect(texts(flow, 'alice')).toEqual(['here is the chart', NOT_HERE]);
    expect(sdk.loads).toEqual([]);
    expect(files).toEqual([]);
    expect(alice.directIms()).toEqual([]);
    expect(flow.server.relayed()).toEqual([]);
  });
});
