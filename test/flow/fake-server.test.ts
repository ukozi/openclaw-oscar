import { afterEach, describe, expect, it } from 'vitest';
import { encodeImFragments } from '../../src/oscar/bos.js';
import { ByteWriter, toHex } from '../../src/oscar/bytes.js';
import { encodeFlap } from '../../src/oscar/flap.js';
import { decodeSnacError } from '../../src/oscar/snac.js';
import { decodeTlvs, encodeTlvs, findTlv, tlv, tlvStr, tlvU16, tlvU8 } from '../../src/oscar/tlv.js';
import { RawClient } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';
import type { FakeGeneration } from '../fake/oscar-server.js';

let server: FakeOscarServer;

afterEach(async () => {
  await server.stop();
});

function im(to: string, tlvs: ReturnType<typeof tlv.empty>[]): Uint8Array {
  return new ByteWriter()
    .u64(5n)
    .u16(1)
    .str8(to)
    .bytes(encodeTlvs([tlv.bytes(0x02, encodeImFragments(0, new Uint8Array(Buffer.from('hi')))), ...tlvs]))
    .toBytes();
}

describe('the fake speaks first and routes on the signon TLVs', () => {
  it('opens with the same signon frame the real server sends', async () => {
    server = await FakeOscarServer.start();
    const c = await RawClient.connect(server.port);
    expect(toHex(encodeFlap(c.frames[0]?.type ?? 0, c.frames[0]?.seq ?? 0, c.frames[0]?.payload))).toBe('2a010064000400000001');
    c.close();
  });

  it('answers a good login with name, address, a 256-byte cookie and the SSL state, then an empty signoff', async () => {
    server = await FakeOscarServer.start();
    server.addUser('botone', 'botpass1');
    const { tlvs, client } = await RawClient.login(server.port, 'botone', 'botpass1');
    expect(tlvs.map((t) => t.tag)).toEqual([0x01, 0x05, 0x06, 0x8e]);
    expect(tlvStr(tlvs, 0x05)).toBe(`127.0.0.1:${server.port}`);
    expect(findTlv(tlvs, 0x06)).toHaveLength(256);
    expect(tlvU8(tlvs, 0x8e)).toBe(0);
    expect(await client.nextFrame()).toMatchObject({ type: 4, payload: new Uint8Array(0) });
    await client.untilClosed();
  });

  it('answers a bad password with 0x0005 and an unknown name at the challenge with 0x0001 and no signoff', async () => {
    server = await FakeOscarServer.start();
    server.addUser('botone', 'botpass1');
    const bad = await RawClient.login(server.port, 'botone', 'nope');
    expect(tlvU16(bad.tlvs, 0x08)).toBe(0x0005);
    const unknown = await RawClient.login(server.port, 'nobody', 'x');
    expect(tlvU16(unknown.tlvs, 0x08)).toBe(0x0001);
    await unknown.client.untilClosed();
    expect(unknown.client.frames.some((f) => f.type === 4)).toBe(false);
  });

  it('with auth disabled takes any password and creates unknown names', async () => {
    server = await FakeOscarServer.start({ disableAuth: true });
    server.addUser('botone', 'botpass1');
    expect(findTlv((await RawClient.login(server.port, 'botone', 'wrong')).tlvs, 0x06)).toHaveLength(256);
    expect(findTlv((await RawClient.login(server.port, 'newname', 'whatever')).tlvs, 0x06)).toHaveLength(256);
  });

  it('limits logins per window in both shapes', async () => {
    server = await FakeOscarServer.start({ loginLimit: 1 });
    server.addUser('botone', 'botpass1');
    const fresh = await FakeOscarServer.start({ loginLimit: 0 });
    try {
      const first = await RawClient.connect(fresh.port);
      first.signon();
      const signoff = await first.nextFrame();
      expect([signoff.type, tlvU16(decodeTlvs(signoff.payload), 0x08)]).toEqual([4, 0x001d]);
    } finally {
      await fresh.stop();
    }
    await RawClient.login(server.port, 'botone', 'botpass1');
    const second = await RawClient.connect(server.port);
    second.signon();
    const reply = await second.nextSnac();
    expect([reply.family, reply.subtype, tlvU16(decodeTlvs(reply.body), 0x08)]).toEqual([0x17, 0x03, 0x001d]);
  });

  it('lets a login cookie be presented more than once, and forgets it on restart', async () => {
    server = await FakeOscarServer.start();
    server.addUser('botone', 'botpass1');
    const { tlvs } = await RawClient.login(server.port, 'botone', 'botpass1');
    const cookie = findTlv(tlvs, 0x06) ?? new Uint8Array();
    for (let i = 0; i < 2; i++) {
      const bos = await RawClient.connect(server.port);
      bos.signon([tlv.bytes(0x06, cookie)]);
      expect((await bos.nextSnac()).subtype).toBe(0x03);
    }
    await server.restart();
    const after = await RawClient.connect(server.port);
    after.signon([tlv.bytes(0x06, cookie)]);
    await after.untilClosed();
    expect(after.frames).toHaveLength(1);
  });
});

describe.each<FakeGeneration>(['v0.24', 'main'])('IM relay on %s', (generation) => {
  it(generation === 'main' ? 'strips the store TLV before delivery' : 'forwards the store TLV to an online recipient', async () => {
    server = await FakeOscarServer.start({ generation });
    server.addUser('botone', 'botpass1');
    const alice = server.peer('alice');
    const bot = await RawClient.signOn(server.port, 'botone', 'botpass1');
    bot.snac(4, 0x06, 10, im('alice', [tlv.empty(0x03), tlv.empty(0x06)]));
    const ack = await bot.nextSnac();
    expect([ack.subtype, ack.requestId]).toEqual([0x0c, 10]);
    expect(alice.ims()).toEqual([{ from: 'botone', text: 'hi', storeTlv: generation === 'v0.24' }]);
  });
});

describe('IM relay', () => {
  it('sends no ack unless asked, refuses an offline recipient without the store TLV, and caps the store at ten', async () => {
    server = await FakeOscarServer.start();
    server.addUser('botone', 'botpass1');
    server.addUser('mallory', 'x');
    server.peer('alice');
    const bot = await RawClient.signOn(server.port, 'botone', 'botpass1');
    bot.snac(4, 0x06, 10, im('alice', []));
    bot.snac(4, 0x06, 11, im('mallory', [tlv.empty(0x03)]));
    const refused = await bot.nextSnac();
    expect([refused.subtype, refused.requestId, decodeSnacError(refused.body).code]).toEqual([0x01, 11, 4]);
    for (let i = 0; i < 10; i++) bot.snac(4, 0x06, 20 + i, im('mallory', [tlv.empty(0x06)]));
    bot.snac(4, 0x06, 40, im('mallory', [tlv.empty(0x06)]));
    const full = await bot.nextSnac();
    expect([full.requestId, tlvU16(decodeSnacError(full.body).tlvs, 0x08)]).toEqual([40, 0x000f]);
    expect(server.storedFor('mallory')).toHaveLength(10);
  });

  it('answers an unrouted SNAC with an error and keeps the connection, but drops it for the never-send cases', async () => {
    server = await FakeOscarServer.start();
    server.addUser('botone', 'botpass1');
    const bot = await RawClient.signOn(server.port, 'botone', 'botpass1');
    bot.snac(1, 0x09, 50);
    const err = await bot.nextSnac();
    expect([err.family, err.subtype, err.requestId]).toEqual([1, 0x01, 50]);
    bot.snac(2, 0x04, 51, encodeTlvs([tlv.bytes(0x05, new Uint8Array(15))]));
    await bot.untilClosed();

    const again = await RawClient.signOn(server.port, 'botone', 'botpass1');
    again.snac(4, 0x02, 52, new Uint8Array(8));
    await again.untilClosed();
  });

  it('evicts the older session with TLV 0x09 when the same name signs on again', async () => {
    server = await FakeOscarServer.start();
    server.addUser('botone', 'botpass1');
    const first = await RawClient.signOn(server.port, 'botone', 'botpass1');
    await RawClient.signOn(server.port, 'botone', 'botpass1');
    const signoff = await first.nextFrame();
    expect([signoff.type, tlvU8(decodeTlvs(signoff.payload), 0x09)]).toEqual([4, 1]);
  });
});
