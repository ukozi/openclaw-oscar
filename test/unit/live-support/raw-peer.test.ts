import { createHash } from 'node:crypto';
import * as net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { RawPeer } from '../../live/support/raw-peer.js';
import { until } from '../../live/support/wait.js';

function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n, 0);
  return b;
}

function tlv(tag: number, value: Buffer): Buffer {
  return Buffer.concat([u16(tag), u16(value.length), value]);
}

function flap(channel: number, payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0x2a, channel]), u16(1), u16(payload.length), payload]);
}

function snac(family: number, subtype: number, requestId: number, body: Buffer, flags = 0): Buffer {
  const id = Buffer.alloc(4);
  id.writeUInt32BE(requestId, 0);
  return flap(2, Buffer.concat([u16(family), u16(subtype), u16(flags), id, body]));
}

function userInfo(name: string, flags: number): Buffer {
  return Buffer.concat([Buffer.from([name.length]), Buffer.from(name, 'latin1'), u16(0), u16(1), tlv(0x01, u16(flags))]);
}

type Seen = { family: number; subtype: number; body: Buffer };

async function responder(password: string): Promise<{ port: number; seen: Seen[]; close: () => void }> {
  const key = 'salt123';
  const expected = createHash('md5')
    .update(key)
    .update(createHash('md5').update(password, 'latin1').digest())
    .update('AOL Instant Messenger (SM)', 'latin1')
    .digest();
  const seen: Seen[] = [];
  let port = 0;
  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    socket.write(flap(1, Buffer.from([0, 0, 0, 1])));
    let pending = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 6) {
        const size = 6 + pending.readUInt16BE(4);
        if (pending.length < size) return;
        const channel = pending.readUInt8(1);
        const payload = pending.subarray(6, size);
        pending = pending.subarray(size);
        if (channel === 1 && payload.length > 4) socket.write(snac(0x01, 0x03, 0, Buffer.alloc(0)));
        if (channel !== 2) continue;
        const family = payload.readUInt16BE(0);
        const subtype = payload.readUInt16BE(2);
        const requestId = payload.readUInt32BE(6);
        const body = Buffer.from(payload.subarray(10));
        seen.push({ family, subtype, body });
        if (family === 0x17 && subtype === 0x06) socket.write(snac(0x17, 0x07, requestId, Buffer.concat([u16(key.length), Buffer.from(key)])));
        if (family === 0x17 && subtype === 0x02) {
          const reply = body.includes(expected)
            ? Buffer.concat([tlv(0x01, Buffer.from('bob')), tlv(0x05, Buffer.from(`127.0.0.1:${port}`)), tlv(0x06, Buffer.alloc(256, 7)), tlv(0x8e, Buffer.from([0]))])
            : tlv(0x08, u16(0x0005));
          socket.write(snac(0x17, 0x03, requestId, reply));
          // the server ends an auth connection with an empty sign-off frame
          socket.write(flap(4, Buffer.alloc(0)));
        }
        if (family === 0x02 && subtype === 0x05) {
          const name = body.subarray(3, 3 + body.readUInt8(2)).toString('latin1');
          if (name === 'ghost') {
            socket.write(snac(0x02, 0x01, requestId, u16(0x0004)));
          } else if (name === 'botone') {
            const away = Buffer.concat([userInfo('BotOne', 0x0420), tlv(0x03, Buffer.from('text/aolrtf')), tlv(0x04, Buffer.from('Looking something up'))]);
            socket.write(snac(0x02, 0x06, requestId, Buffer.concat([u16(0), away]), 0x8000));
          } else if (name === 'mallory') {
            socket.write(snac(0x02, 0x06, requestId, userInfo('Mallory', 0x0030)));
            const message = Buffer.concat([u16(0), u16(0), Buffer.from('away right now')]);
            const fragments = Buffer.concat([Buffer.from([5, 1]), u16(3), Buffer.from([1, 1, 2]), Buffer.from([1, 1]), u16(message.length), message]);
            socket.write(snac(0x04, 0x07, 0, Buffer.concat([Buffer.alloc(8, 2), u16(1), userInfo('Mallory', 0x0030), tlv(0x02, fragments), tlv(0x04, Buffer.alloc(0))])));
          } else if (name === 'carol') {
            socket.write(snac(0x02, 0x06, requestId, userInfo('Carol', 0x0010)));
            socket.write(flap(4, Buffer.concat([tlv(0x09, Buffer.from([1])), tlv(0x0b, Buffer.from('https://example.net'))])));
          } else {
            socket.write(snac(0x02, 0x06, requestId, userInfo(name, 0x0010)));
            const message = Buffer.concat([u16(0), u16(0), Buffer.from('hello bob')]);
            const fragments = Buffer.concat([Buffer.from([5, 1]), u16(3), Buffer.from([1, 1, 2]), Buffer.from([1, 1]), u16(message.length), message]);
            const im = snac(0x04, 0x07, 0, Buffer.concat([Buffer.alloc(8, 1), u16(1), userInfo('Alice', 0x0010), tlv(0x02, fragments)]));
            setTimeout(() => socket.write(im), 20);
          }
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  port = (server.address() as net.AddressInfo).port;
  return { port, seen, close: () => { server.close(); } };
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

describe('raw peer', () => {
  it('reports the login error code', async () => {
    const r = await responder('hunter22');
    cleanups.push(r.close);
    await expect(RawPeer.signOn({ host: '127.0.0.1', port: r.port, screenName: 'bob', password: 'wrongpass' })).rejects.toThrow(/code 0x5/);
  });

  it('signs on, reads away text and flags, and parses an IM', async () => {
    const r = await responder('hunter22');
    const bob = await RawPeer.signOn({ host: '127.0.0.1', port: r.port, screenName: 'bob', password: 'hunter22' });
    cleanups.push(r.close, () => bob.signOff());

    expect(await bob.userInfo('ghost')).toEqual({ online: false, away: null, flags: 0 });
    expect(await bob.userInfo('botone')).toEqual({ online: true, away: 'Looking something up', flags: 0x0420 });
    expect(await until(() => (bob.ims().length > 0 ? bob.ims() : null), { timeoutMs: 1000, what: 'the sign-on IM' }))
      .toEqual([{ from: 'alice', text: 'hello bob', autoResponse: false }]);
    expect(r.seen.map((s) => [s.family, s.subtype]).slice(0, 5)).toEqual([[0x17, 0x06], [0x17, 0x02], [0x02, 0x04], [0x13, 0x07], [0x01, 0x02]]);
  });

  it('sends a channel 1 IM without asking for a host ack and a channel 2 invite the server accepts', async () => {
    const r = await responder('hunter22');
    const bob = await RawPeer.signOn({ host: '127.0.0.1', port: r.port, screenName: 'bob', password: 'hunter22' });
    cleanups.push(r.close, () => bob.signOff());

    bob.sendIm('botone', 'hi');
    bob.sendInvite('botone', { exchange: 4, name: 'testroom' });
    const sends = await until(() => {
      const got = r.seen.filter((s) => s.family === 0x04 && s.subtype === 0x06);
      return got.length === 2 ? got : null;
    }, { timeoutMs: 1000, what: 'both sends' });

    const im = sends[0] as Seen;
    expect(im.body.readUInt16BE(8)).toBe(1);
    expect(im.body.subarray(11, 17).toString('latin1')).toBe('botone');
    expect(im.body.readUInt16BE(17)).toBe(0x02);
    expect(im.body.includes(Buffer.from([0x00, 0x03, 0x00, 0x00]))).toBe(false);

    const invite = sends[1] as Seen;
    expect(invite.body.readUInt16BE(8)).toBe(2);
    expect(invite.body.readUInt16BE(17)).toBe(0x05);
    // a rendezvous block under 26 bytes makes a real server drop the sender
    expect(invite.body.readUInt16BE(19)).toBeGreaterThanOrEqual(26);
    expect(invite.body.includes(Buffer.from('748F2420628711D18222444553540000', 'hex'))).toBe(true);
    expect(invite.body.includes(Buffer.from('4-0-testroom', 'latin1'))).toBe(true);
  });
  it('marks an auto response and reads the sign-off that says another login took over', async () => {
    const r = await responder('hunter22');
    const bob = await RawPeer.signOn({ host: '127.0.0.1', port: r.port, screenName: 'bob', password: 'hunter22' });
    cleanups.push(r.close, () => bob.signOff());
    await until(() => (bob.ims().some((m) => m.from === 'alice') ? true : null), { timeoutMs: 1000, what: 'the sign-on IM' });

    const mark = Date.now();
    // receivedSince compares whole milliseconds, so step past the sign-on IM's own millisecond
    const start = await until(() => { const t = Date.now(); return t > mark ? t : null; }, { timeoutMs: 1000, what: 'a fresh mark' });
    await bob.userInfo('mallory');
    const reply = await until(() => bob.ims().find((m) => m.from === 'mallory') ?? null, { timeoutMs: 1000, what: 'the auto reply' });
    expect(reply).toEqual({ from: 'mallory', text: 'away right now', autoResponse: true });
    expect(bob.receivedSince(start, 0x04).map((s) => s.subtype)).toEqual([0x07]);
    expect(bob.kicked()).toBe(false);

    await bob.userInfo('carol');
    await until(() => (bob.kicked() ? true : null), { timeoutMs: 1000, what: 'the kick' });
  });
});
