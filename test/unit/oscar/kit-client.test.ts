import { afterEach, describe, expect, it } from 'vitest';
import { SignOnError, adapterTicketSource } from 'open-oscar-client-kit/client';
import { ByteReader, CAP_CHAT, strongHash } from 'open-oscar-client-kit/wire';
import { captureLog, settle, waitFor } from 'open-oscar-client-kit/testing';
import type { FakeOscarServer } from 'open-oscar-client-kit/testing';
import { directImLimits, kitOptions, makeKitClient } from '../../../src/oscar/kit-client.js';
import type { KitClient } from '../../../src/oscar/kit-client.js';
import { login } from '../../../src/oscar/login.js';
import type { OscarSessionOptions } from '../../../src/oscar/types.js';
import { startServer } from '../../fake/kit.js';

let server: FakeOscarServer | undefined;
let client: KitClient | undefined;

afterEach(async () => {
  await client?.signOff();
  client = undefined;
  await server?.stop();
  server = undefined;
});

async function signOn(): Promise<{ s: FakeOscarServer; tickets: () => number }> {
  const s = await startServer();
  server = s;
  s.addUser('botone', 'botpass1');
  const opts: OscarSessionOptions = {
    host: '127.0.0.1',
    port: s.port,
    tls: false,
    redirect: 'auto',
    screenName: 'botone',
    getPassword: async () => 'botpass1',
    buddies: () => ['alice', 'bob'],
    log: captureLog().log,
    loginBudget: { take: async () => {} },
  };
  const c = makeKitClient(opts, { reconnect: { next: () => ({ retry: false, reason: { kind: 'unreachable' } }) } });
  client = c;
  let issued = 0;
  const source = adapterTicketSource(async (request) => {
    issued++;
    const out = await login({ ...opts, hash: (key) => strongHash('botpass1', key), track: request.track });
    if (!out.ok) throw new SignOnError({ kind: 'unreachable' });
    return { ticket: { host: out.host, port: out.port, cookie: out.cookie }, source: 'adapter', obtainedAt: Date.now(), expiresAt: null };
  });
  expect(await c.signOnWith(source, { host: '127.0.0.1', port: s.port })).toBe('online');
  return { s, tickets: () => issued };
}

const serviceFamilies = (s: FakeOscarServer): number[] =>
  s
    .snacsFrom('botone')
    .filter((snac) => snac.conn === 'bos' && snac.family === 0x01 && snac.subtype === 0x04)
    .map((snac) => new ByteReader(snac.body).u16());

describe('makeKitClient', () => {
  it('watches the session buddies and sends no feedbag SNAC at sign-on', async () => {
    const { s } = await signOn();
    await waitFor(() => s.sessionBuddiesOf('botone').length === 2, 'the session buddy list');
    expect(s.sessionBuddiesOf('botone')).toEqual(['alice', 'bob']);
    expect(s.snacsFrom('botone').filter((snac) => snac.family === 0x13)).toEqual([]);
  });

  it('asks for no icon and no service when a buddy with an icon arrives', async () => {
    const { s } = await signOn();
    s.peer('alice').setIcon(Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4));
    expect(s.iconOf('alice')).not.toBeNull();
    await waitFor(() => client?.presenceOf('alice')?.online === true, 'alice online');
    await settle(s.port);
    expect(serviceFamilies(s)).toEqual([]);
    expect(s.snacsFrom('botone').filter((snac) => snac.family === 0x10)).toEqual([]);
    expect(s.openConnections('botone')).toEqual(['bos']);
  });

  it('takes its login from the plugin, not from the kit', async () => {
    const { s, tickets } = await signOn();
    expect(tickets()).toBe(1);
    expect(s.bucpLogins.map((l) => ({ clientId: l.clientId, multiConn: l.multiConn }))).toEqual([{ clientId: 'openclaw-oscar', multiConn: 0x03 }]);
  });
});

describe('kitOptions', () => {
  const hooks = { reconnect: { next: () => ({ retry: false as const, reason: { kind: 'unreachable' as const } }) } };
  const base = (over: Partial<OscarSessionOptions> = {}): OscarSessionOptions => ({
    host: 'chat.example',
    port: 5190,
    tls: false,
    redirect: 'auto',
    screenName: 'botone',
    getPassword: async () => 'botpass1',
    buddies: () => [],
    log: captureLog().log,
    loginBudget: { take: async () => {} },
    ...over,
  });

  it('builds the client without Direct IM when the setting is off', () => {
    for (const opts of [base(), base({ transfers: { directIm: false, sendFile: false, maxBytes: 10 * 1024 * 1024 } })]) {
      const built = kitOptions(opts, hooks);
      expect('directIm' in built).toBe(false);
      expect('fileTransfer' in built).toBe(false);
      expect(built.capabilities).toEqual([CAP_CHAT]);
    }
  });

  it('turns Direct IM on with the dial rule and the size limits', async () => {
    const lookup = async (host: string): Promise<string[]> => (host === 'chat.example' ? ['192.0.2.1'] : []);
    const built = kitOptions(base({ transfers: { directIm: true, sendFile: false, maxBytes: 1000, relayHost: '198.51.100.7', lookup } }), hooks);
    expect(built.capabilities).toEqual([CAP_CHAT]);
    expect('fileTransfer' in built).toBe(false);
    expect(built.directIm).toMatchObject({ maxMessageBytes: 1000 + 262_144, maxSessionBytes: 100 * (1000 + 262_144) });
    expect(directImLimits(1000)).toEqual({ maxMessageBytes: 1000 + 262_144, maxSessionBytes: 100 * (1000 + 262_144) });
    const allowDial = built.directIm?.allowDial;
    if (!allowDial) throw new Error('no dial rule');
    const context = { server: { host: 'chat.example', port: 5190 }, bos: { host: 'chat.example', port: 5190 } };
    expect(await allowDial({ ip: '192.0.2.1', port: 4443 }, context)).toBe(true);
    expect(await allowDial({ ip: '198.51.100.7', port: 4443 }, context)).toBe(true);
    expect(await allowDial({ ip: '203.0.113.9', port: 4443 }, context)).toBe(false);
  });

  it('builds the client without file transfer when the setting is off', () => {
    const built = kitOptions(base({ transfers: { directIm: true, sendFile: false, maxBytes: 1000 } }), hooks);
    expect('fileTransfer' in built).toBe(false);
    expect(built.directIm?.allowDial).toBeTypeOf('function');
  });

  it('turns file transfer on with the dial rule', async () => {
    const lookup = async (host: string): Promise<string[]> => (host === 'chat.example' ? ['192.0.2.1'] : []);
    const built = kitOptions(base({ transfers: { directIm: false, sendFile: true, maxBytes: 1000, relayHost: '198.51.100.7', lookup } }), hooks);
    expect(built.capabilities).toEqual([CAP_CHAT]);
    expect('directIm' in built).toBe(false);
    expect('getFile' in built).toBe(false);
    const allowDial = built.fileTransfer?.allowDial;
    if (!allowDial) throw new Error('no dial rule');
    const context = { server: { host: 'chat.example', port: 5190 }, bos: { host: 'chat.example', port: 5190 } };
    expect(await allowDial({ ip: '192.0.2.1', port: 4443 }, context)).toBe(true);
    expect(await allowDial({ ip: '198.51.100.7', port: 4443 }, context)).toBe(true);
    expect(await allowDial({ ip: '203.0.113.9', port: 4443 }, context)).toBe(false);
  });

  it('hands the offer rule to each kind that is on, with the kind', () => {
    const asked: string[] = [];
    const allowOffer = (kind: string, from: string): boolean => {
      asked.push(`${kind} ${from}`);
      return from === 'Alice';
    };
    const built = kitOptions(base({ transfers: { directIm: true, sendFile: true, maxBytes: 1000, allowOffer } }), hooks);
    expect(built.directIm?.allowOffer?.('Alice')).toBe(true);
    expect(built.fileTransfer?.allowOffer?.('Mallory')).toBe(false);
    expect(asked).toEqual(['direct-im Alice', 'send-file Mallory']);
    const plain = kitOptions(base({ transfers: { directIm: true, sendFile: true, maxBytes: 1000 } }), hooks);
    expect(plain.directIm?.allowOffer).toBeUndefined();
    expect(plain.fileTransfer?.allowOffer).toBeUndefined();
  });

  it('gives Direct IM and file transfer the same dial rule when both are on', () => {
    const built = kitOptions(base({ transfers: { directIm: true, sendFile: true, maxBytes: 1000 } }), hooks);
    expect(built.fileTransfer?.allowDial).toBeTypeOf('function');
    expect(built.directIm?.allowDial).toBe(built.fileTransfer?.allowDial);
  });
});
