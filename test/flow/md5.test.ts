import { afterEach, expect, it, vi } from 'vitest';
import type { FakeOscarServer } from 'open-oscar-client-kit/testing';
import { startServer } from '../fake/kit.js';
import { makeSession, stopAllSessions } from '../fake/session-harness.js';

vi.mock('open-oscar-client-kit/wire', async (original) => ({
  ...(await original<typeof import('open-oscar-client-kit/wire')>()),
  md5Available: () => false,
}));

let server: FakeOscarServer;

afterEach(async () => {
  await stopAllSessions();
  await server.stop();
});

it('a Node build without MD5 is a terminal status, not a reconnect loop', async () => {
  server = await startServer();
  server.addUser('botone', 'botpass1');
  const h = makeSession(server);
  h.session.start();
  const state = await h.phase('fatal');
  expect(state).toMatchObject({ reason: 'md5-unavailable', detail: 'this Node build disables MD5' });
  expect(h.timers.pending()).toEqual([]);
  expect(server.snacsFrom('botone')).toEqual([]);
});
