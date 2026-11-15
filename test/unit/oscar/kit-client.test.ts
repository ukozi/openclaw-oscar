import { afterEach, describe, expect, it } from 'vitest';
import { SignOnError, adapterTicketSource } from 'open-oscar-client-kit/client';
import { ByteReader, strongHash } from 'open-oscar-client-kit/wire';
import { captureLog, settle, waitFor } from 'open-oscar-client-kit/testing';
import type { FakeOscarServer } from 'open-oscar-client-kit/testing';
import { makeKitClient } from '../../../src/oscar/kit-client.js';
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
