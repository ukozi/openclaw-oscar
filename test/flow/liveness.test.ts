import { afterEach, describe, expect, it } from 'vitest';
import { RawClient } from 'open-oscar-client-kit/testing';
import type { FakeOscarServer } from 'open-oscar-client-kit/testing';
import { startServer } from '../fake/kit.js';
import { makeSession, stopAllSessions } from '../fake/session-harness.js';

let server: FakeOscarServer;

afterEach(async () => {
  await stopAllSessions();
  await server.stop();
});

const userInfoQueries = (conn: string): number =>
  server.snacsFrom('botone').filter((s) => s.conn === conn && s.family === 0x0001 && s.subtype === 0x000e).length;

const probesSent = (): number => server.snacsFrom('botone').filter((s) => s.family === 0x0001 && s.subtype === 0x001f).length;

const connections = (kind: string, logs: { lines: { msg: string; fields?: Record<string, unknown> | undefined }[] }): number =>
  logs.lines.filter((l) => l.msg === 'oscar connection open' && l.fields?.['conn'] === kind).length;

describe('a session that is meant to stay online', () => {
  it('holds one connection through five liveness rounds and never sends the fatal probe', async () => {
    server = await startServer();
    server.addUser('botone', 'botpass1');
    const h = makeSession(server);
    h.session.start();
    await h.online();
    const atSignOn = userInfoQueries('bos');
    for (let round = 0; round < 5; round++) await h.timers.advance(90_000);
    expect(h.session.getState().phase).toBe('online');
    // one connecting, one online: a second pair would mean the link died and the session dialled again
    expect(h.states.map((s) => s.phase)).toEqual(['connecting', 'online']);
    expect(connections('bos', h.logs)).toBe(1);
    expect(userInfoQueries('bos') - atSignOn).toBe(5);
    expect(probesSent()).toBe(0);
  });

  it('holds a room socket through five liveness rounds too', async () => {
    server = await startServer();
    server.addUser('botone', 'botpass1');
    const h = makeSession(server);
    h.session.start();
    await h.online();
    await h.session.joinRoom({ exchange: 4, name: 'testroom' });
    const atJoin = userInfoQueries('chat');
    for (let round = 0; round < 5; round++) await h.timers.advance(90_000);
    expect(h.session.rooms().map((r) => r.room.name)).toEqual(['testroom']);
    expect(server.rooms.occupants({ exchange: 4, name: 'testroom' })).toContain('botone');
    expect(userInfoQueries('chat') - atJoin).toBe(5);
    expect(h.logs.lines.filter((l) => l.fields?.['kind'] === 'probe-timeout')).toEqual([]);
    expect(probesSent()).toBe(0);
  });

  it('is dropped by the server the moment it sends the OService probe', async () => {
    server = await startServer();
    server.addUser('botone', 'botpass1');
    const bos = await RawClient.signOn(server.port, 'botone', 'botpass1');
    bos.snac(0x0001, 0x001f, 9);
    await bos.untilClosed();
    expect(bos.closed).toBe(true);
  });
});
