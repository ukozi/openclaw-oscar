import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

const stateDir = mkdtempSync(join(tmpdir(), 'openclaw-test-state-'));

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/live/**', 'node_modules/**', 'dist/**'],
    testTimeout: 30_000,
    env: {
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: join(stateDir, 'openclaw.json'),
    },
  },
});
