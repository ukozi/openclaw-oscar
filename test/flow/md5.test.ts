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

it('takes a login budget token before it finds MD5 missing', async () => {
  server = await startServer();
  server.addUser('botone', 'botpass1');
  let taken = 0;
  const h = makeSession(server, { loginBudget: { take: async () => void taken++ } });
  h.session.start();
  expect((await h.phase('fatal')).reason).toBe('md5-unavailable');
  expect(taken).toBe(1);
});
