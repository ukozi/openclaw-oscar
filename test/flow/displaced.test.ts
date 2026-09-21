import { afterEach, describe, expect, it } from 'vitest';
import { makeSession, stopAllSessions } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';

let server: FakeOscarServer;

afterEach(async () => {
  await stopAllSessions();
  await server.stop();
});

describe('disconnected by the server', () => {
  it('does not reconnect for 60 s after a kick and says why', async () => {
    server = await FakeOscarServer.start();
    server.addUser('botone', 'botpass1');
    const h = makeSession(server);
    h.session.start();
    await h.online();
    server.kick('botone');
    const state = await h.phase('backoff');
    expect(state).toMatchObject({ reason: 'disconnected-by-server', detail: 'signed on elsewhere or kicked' });
    expect(h.timers.pending()[0]).toBeGreaterThanOrEqual(60_000);
    await h.timers.advance(59_999);
    expect(h.session.getState().phase).toBe('backoff');
    await h.timers.advance(12_001);
    await h.online();
  });

  it('is displaced by a second sign-on with the same screen name, and the two do not fight', async () => {
    server = await FakeOscarServer.start();
    server.addUser('botone', 'botpass1');
    const first = makeSession(server);
    first.session.start();
    await first.online();
    const second = makeSession(server);
    second.session.start();
    await second.online();
    expect((await first.phase('backoff')).reason).toBe('disconnected-by-server');
    await first.timers.advance(30_000);
    expect(first.session.getState().phase).toBe('backoff');
    expect(second.session.getState().phase).toBe('online');
  });

  it('blames the rate limit when the governor saw trouble just before', async () => {
    server = await FakeOscarServer.start();
    server.addUser('botone', 'botpass1');
    const h = makeSession(server);
    h.session.start();
    await h.online();
    server.setRate('botone', 'bos', 'limited');
    await expect.poll(() => h.rates.at(-1)?.status).toBe('limited');
    server.kick('botone');
    expect((await h.phase('backoff')).detail).toBe('rate limit');
  });
});
