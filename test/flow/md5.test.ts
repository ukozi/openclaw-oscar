import { afterEach, expect, it, vi } from 'vitest';
import { makeSession, stopAllSessions } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';

vi.mock('../../src/oscar/auth.js', async (original) => ({
  ...(await original<typeof import('../../src/oscar/auth.js')>()),
  md5Available: () => false,
}));

let server: FakeOscarServer;

afterEach(async () => {
  await stopAllSessions();
  await server.stop();
});

it('a Node build without MD5 is a terminal status, not a reconnect loop', async () => {
  server = await FakeOscarServer.start();
  server.addUser('botone', 'botpass1');
  const h = makeSession(server);
  h.session.start();
  const state = await h.phase('fatal');
  expect(state).toMatchObject({ reason: 'md5-unavailable', detail: 'this Node build disables MD5' });
  expect(h.timers.pending()).toEqual([]);
  expect(server.snacsFrom('botone')).toEqual([]);
});
