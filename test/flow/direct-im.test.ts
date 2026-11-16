import { afterEach, describe, expect, it } from 'vitest';
import { settle, waitFor } from 'open-oscar-client-kit/testing';
import type { FakeOscarServer } from 'open-oscar-client-kit/testing';
import type { OscarSessionOptions, TransferOptions } from '../../src/oscar/types.js';
import { startServer } from '../fake/kit.js';
import { makeSession, stopAllSessions } from '../fake/session-harness.js';
import type { Harness } from '../fake/session-harness.js';

const MB = 1024 * 1024;
const PNG = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4);

let server: FakeOscarServer;

afterEach(async () => {
  await stopAllSessions();
  await server.stop();
});

async function signOn(transfers?: Partial<TransferOptions>, over: Partial<OscarSessionOptions> = {}): Promise<Harness> {
  server = await startServer({ relay: true });
  server.addUser('botone', 'botpass1');
  const h = makeSession(server, { ...(transfers ? { transfers: { directIm: true, sendFile: false, maxBytes: 10 * MB, ...transfers } } : {}), ...over });
  h.session.start();
  await h.online();
  return h;
}

async function offerOf(h: Harness): Promise<string> {
  await waitFor(() => h.directImOffers.length === 1, 'the Direct IM offer');
  const id = h.directImOffers[0]?.id;
  if (id === undefined) throw new Error('no offer');
  return id;
}

describe('Direct IM on the session', () => {
  it('reports a Direct IM offer and opens the session through the relay once accepted', async () => {
    const h = await signOn({});
    const opening = server.peer('Alice').openDirectIm('botone');
    const id = await offerOf(h);
    expect(h.directImOffers).toEqual([{ id, from: 'alice', fromDisplay: 'Alice' }]);
    await settle(server.port);
    expect(server.relayed()).toEqual([]);
    expect(h.directIms).toEqual([]);
    await h.session.acceptDirectIm(id);
    expect((await opening).outcome).toBe('open');
    await waitFor(() => h.directIms.length === 1, 'the open session');
    expect(h.directIms).toEqual([{ id, peer: 'alice', role: 'receiving', state: 'open' }]);
    await waitFor(() => server.relayed().length === 1, 'the pair on the relay');
    const direct = await opening;
    await direct.sendText('hello');
    await waitFor(() => h.directMessages.length === 1, 'the message');
    await h.session.closeDirectIm(id);
    await waitFor(() => h.directIms.at(-1)?.state === 'closed', 'the closed session');
    expect(h.directIms).toEqual([
      { id, peer: 'alice', role: 'receiving', state: 'open' },
      { id, peer: 'alice', role: 'receiving', state: 'closed', end: 'closed', by: 'self' },
    ]);
  });

  it('delivers a picture with its text', async () => {
    const h = await signOn({});
    const opening = server.peer('alice').openDirectIm('botone');
    const id = await offerOf(h);
    await h.session.acceptDirectIm(id);
    const direct = await opening;
    await direct.sendPicture('cat.png', PNG, 'look at <B>this</B>');
    await waitFor(() => h.directMessages.length === 1, 'the picture');
    expect(h.directMessages).toEqual([
      { id, from: 'alice', fromDisplay: 'alice', text: 'look at this', autoResponse: false, damaged: false, pictures: [{ name: 'cat.png', bytes: PNG }] },
    ]);
  });

  it('declines an offer without any connection', async () => {
    const h = await signOn({});
    const opening = server.peer('mallory').openDirectIm('botone');
    const id = await offerOf(h);
    await h.session.declineDirectIm(id);
    expect((await opening).outcome).toBe('declined');
    await settle(server.port);
    expect(server.relayed()).toEqual([]);
    expect(h.directIms.filter((s) => s.state === 'open')).toEqual([]);
  });

  it("refuses an offer whose address is not the server's", async () => {
    const h = await signOn({ lookup: async () => ['203.0.113.9'] }, { host: 'localhost', redirect: 'pin' });
    const opening = server.peer('alice').openDirectIm('botone');
    const id = await offerOf(h);
    await h.session.acceptDirectIm(id);
    await waitFor(() => h.directIms.length === 1, 'the end of the session');
    expect(h.directIms).toEqual([{ id, peer: 'alice', role: 'receiving', state: 'closed', end: 'refused-address' }]);
    expect(server.relayed()).toEqual([]);
    expect(h.logs.text()).toContain("refused to dial an address that is not the server's");
    expect((await opening).outcome).not.toBe('open');
  });

  it('ends the session when a message is larger than the limit', async () => {
    const h = await signOn({ maxBytes: 1024 });
    const opening = server.peer('alice').openDirectIm('botone');
    const id = await offerOf(h);
    await h.session.acceptDirectIm(id);
    const direct = await opening;
    await direct.sendPicture('small.png', PNG);
    await waitFor(() => h.directMessages.length === 1, 'the small picture');
    await direct.sendPicture('big.png', new Uint8Array(300 * 1024)).catch(() => undefined);
    await waitFor(() => h.directIms.at(-1)?.state === 'closed', 'the end of the session');
    expect(h.directIms.at(-1)).toMatchObject({ id, peer: 'alice', role: 'receiving', state: 'closed', end: 'too-large' });
    expect(h.directMessages).toHaveLength(1);
  });

  it('ignores every offer when the setting is off', async () => {
    for (const transfers of [undefined, { directIm: false }]) {
      const h = await signOn(transfers);
      const alice = server.peer('alice');
      void alice.openDirectIm('botone').catch(() => undefined);
      // The IM comes after the offer on the same link.
      alice.sendIm('botone', 'hello');
      await waitFor(() => h.ims.length === 1, 'the IM after the offer');
      await settle(server.port);
      expect(h.ims.map((i) => i.text)).toEqual(['hello']);
      expect(h.directImOffers).toEqual([]);
      expect(h.directIms).toEqual([]);
      expect(server.relayed()).toEqual([]);
      await expect(h.session.acceptDirectIm('alice:0000000000000001')).rejects.toThrow();
      await stopAllSessions();
      await server.stop();
    }
  });
});
