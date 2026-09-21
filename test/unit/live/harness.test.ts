import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { startLiveServer } from '../../live/harness.js';

const standIn = fileURLToPath(new URL('./fixtures/stand-in-server.mjs', import.meta.url));
const exitsAtOnce = fileURLToPath(new URL('./fixtures/exits-at-once.mjs', import.meta.url));

type Report = { calls: string[]; env: Record<string, string>; argv: string[]; cwd: string };

describe('live harness', () => {
  it('refuses to start without a binary', async () => {
    await expect(startLiveServer({ bin: '' })).rejects.toThrow('OOS_BIN is not set');
  });

  it('starts the binary on free ports with its own environment, drives the management API, and cleans up', async () => {
    const server = await startLiveServer({ bin: process.execPath, args: [standIn] });
    let report: Report;
    try {
      await server.createUser('botone', 'hunter22', { bot: true });
      await server.createUser('alice', 'hunter22');
      await server.createPublicRoom('lobby');
      report = (await (await fetch(`${server.apiBase}/calls`)).json()) as Report;
    } finally {
      await server.stop();
    }
    expect(report.calls).toEqual([
      'POST /user {"screen_name":"botone","password":"hunter22"}',
      'PATCH /user/botone/account {"is_bot":true}',
      'POST /user {"screen_name":"alice","password":"hunter22"}',
      'POST /chat/room/public {"name":"lobby"}',
    ]);
    expect(report.env.DISABLE_AUTH).toBe('false');
    expect(report.env.OSCAR_LISTENERS).toBe(`LOCAL://127.0.0.1:${server.port}`);
    expect(report.env.OSCAR_ADVERTISED_LISTENERS_PLAIN).toBe(`LOCAL://127.0.0.1:${server.port}`);
    expect(report.env.TOC_LISTENERS).toBe(`127.0.0.1:${server.tocPort}`);
    expect(report.env.ICQ_LEGACY_ENABLED).toBe('false');
    expect(Object.keys(report.env).filter((k) => !['PATH', '__CF_USER_TEXT_ENCODING'].includes(k)).sort()).toEqual([
      'API_LISTENER', 'DB_PATH', 'DISABLE_AUTH', 'DISABLE_MULTI_LOGIN_NOTIF', 'ICQ_LEGACY_ENABLED', 'LOG_LEVEL',
      'OSCAR_ADVERTISED_LISTENERS_PLAIN', 'OSCAR_LISTENERS', 'TOC_LISTENERS',
    ]);
    expect(report.argv[0]).toBe('-config');
    expect(path.basename(path.dirname(report.env.DB_PATH ?? ''))).toBe(path.basename(report.cwd));
    expect(existsSync(report.env.DB_PATH ?? '')).toBe(false);
  });

  it('reports the output of a binary that exits at once', async () => {
    await expect(startLiveServer({ bin: process.execPath, args: [exitsAtOnce] })).rejects.toThrow('bad config');
  });
});
