import { afterEach, describe, expect, it } from 'vitest';
import { settle, waitFor } from 'open-oscar-client-kit/testing';
import type { FakeOscarServer } from 'open-oscar-client-kit/testing';
import type { FileSink, OscarSessionOptions, TransferOptions } from '../../src/oscar/types.js';
import { startServer } from '../fake/kit.js';
import { makeSession, stopAllSessions } from '../fake/session-harness.js';
import type { Harness } from '../fake/session-harness.js';

const MB = 1024 * 1024;
const NOTES = new TextEncoder().encode('# Notes\n\nBring the cake.\n');

let server: FakeOscarServer;

afterEach(async () => {
  await stopAllSessions();
  await server.stop();
});

async function signOn(transfers?: Partial<TransferOptions>, over: Partial<OscarSessionOptions> = {}): Promise<Harness> {
  server = await startServer({ relay: true });
  server.addUser('botone', 'botpass1');
  const h = makeSession(server, { ...(transfers ? { transfers: { directIm: false, sendFile: true, maxBytes: 10 * MB, ...transfers } } : {}), ...over });
  h.session.start();
  await h.online();
  return h;
}

async function offerOf(h: Harness): Promise<string> {
  await waitFor(() => h.fileOffers.length === 1, 'the file offer');
  const id = h.fileOffers[0]?.id;
  if (id === undefined) throw new Error('no offer');
  return id;
}

function memorySink(gate?: Promise<void>): { sink: FileSink; files: { name: string; bytes: Uint8Array }[] } {
  const files: { name: string; bytes: Uint8Array }[] = [];
  const sink: FileSink = {
    begin: async (file) => {
      const chunks: Uint8Array[] = [];
      return {
        write: async (chunk) => {
          await gate;
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

describe('Send File on the session', () => {
  it('reports a file offer and receives the file into the sink through the relay', async () => {
    const h = await signOn({});
    const sending = server.peer('Alice').offerFile('botone', 'notes.md', NOTES);
    const id = await offerOf(h);
    expect(h.fileOffers).toEqual([{ id, from: 'alice', fromDisplay: 'Alice', count: 1, totalBytes: NOTES.length, name: 'notes.md', folder: false }]);
    await settle(server.port);
    expect(server.relayed()).toEqual([]);
    expect(h.transfers).toEqual([]);
    const { sink, files } = memorySink();
    await h.session.acceptFileOffer(id, sink);
    expect((await sending).outcome).toBe('done');
    await waitFor(() => h.transfers.at(-1)?.state === 'done', 'the end of the transfer');
    expect(files).toEqual([{ name: 'notes.md', bytes: Buffer.from(NOTES) }]);
    expect(server.relayed()).toHaveLength(1);
    expect(h.transfers.every((t) => t.id === id && t.peer === 'alice')).toBe(true);
    expect(h.transfers.at(-1)).toEqual({ id, peer: 'alice', state: 'done', index: 0, bytesDone: NOTES.length });
  });

  it('declines an offer without any connection', async () => {
    const h = await signOn({});
    const sending = server.peer('mallory').offerFile('botone', 'notes.md', NOTES);
    const id = await offerOf(h);
    await h.session.declineFileOffer(id);
    expect((await sending).outcome).toBe('declined');
    await settle(server.port);
    expect(server.relayed()).toEqual([]);
    expect(h.transfers).toEqual([{ id, peer: 'mallory', state: 'declined', by: 'self', index: 0, bytesDone: 0 }]);
  });

  it('reports a folder offer as a folder', async () => {
    const h = await signOn({});
    const sending = server.peer('alice').offerFolder('botone', 'docs', [
      { path: ['a.txt'], bytes: NOTES },
      { path: ['b.txt'], bytes: NOTES },
    ]);
    const id = await offerOf(h);
    expect(h.fileOffers).toEqual([
      { id, from: 'alice', fromDisplay: 'alice', count: 2, totalBytes: 2 * NOTES.length, name: expect.stringContaining('docs'), folder: true },
    ]);
    await h.session.declineFileOffer(id);
    expect((await sending).outcome).toBe('declined');
    expect(server.relayed()).toEqual([]);
  });

  it("refuses an offer whose address is not the server's", async () => {
    const h = await signOn({ lookup: async () => ['203.0.113.9'] }, { host: 'localhost', redirect: 'pin' });
    const sending = server.peer('alice').offerFile('botone', 'notes.md', NOTES);
    const id = await offerOf(h);
    const { sink, files } = memorySink();
    await h.session.acceptFileOffer(id, sink);
    await waitFor(() => h.transfers.some((t) => t.state === 'failed'), 'the end of the transfer');
    expect(h.transfers.at(-1)).toEqual({ id, peer: 'alice', state: 'failed', failure: 'refused-address', index: 0, bytesDone: 0 });
    expect(server.relayed()).toEqual([]);
    expect(files).toEqual([]);
    expect(h.logs.text()).toContain("refused to dial an address that is not the server's");
    expect((await sending).outcome).not.toBe('done');
  });

  it('cancels a running transfer', async () => {
    const h = await signOn({});
    const sending = server.peer('alice').offerFile('botone', 'notes.md', NOTES);
    const id = await offerOf(h);
    let release = (): void => {};
    const { sink, files } = memorySink(new Promise<void>((resolve) => (release = resolve)));
    await h.session.acceptFileOffer(id, sink);
    await waitFor(() => h.transfers.some((t) => t.state === 'transferring'), 'the transfer under way');
    await h.session.cancelTransfer(id);
    expect(h.transfers.at(-1)).toMatchObject({ id, peer: 'alice', state: 'cancelled', by: 'self' });
    release();
    expect((await sending).outcome).not.toBe('done');
    await settle(server.port);
    expect(files).toEqual([]);
    expect(h.transfers.filter((t) => t.state === 'done')).toEqual([]);
  });

  it('ignores every file offer when the setting is off', async () => {
    for (const transfers of [undefined, { directIm: true, sendFile: false }]) {
      const h = await signOn(transfers);
      const alice = server.peer('alice');
      void alice.offerFile('botone', 'notes.md', NOTES).catch(() => undefined);
      // The IM comes after the offer on the same link.
      alice.sendIm('botone', 'hello');
      await waitFor(() => h.ims.length === 1, 'the IM after the offer');
      await settle(server.port);
      expect(h.fileOffers).toEqual([]);
      expect(h.transfers).toEqual([]);
      expect(server.relayed()).toEqual([]);
      await stopAllSessions();
      await server.stop();
    }
  });
});
