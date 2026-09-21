import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const text = readFileSync(fileURLToPath(new URL('../../.github/workflows/live.yml', import.meta.url)), 'utf8');
const lines = text.split('\n').map((l) => l.trim());

describe('live workflow', () => {
  it('runs by hand and nightly, never on a push or a pull request', () => {
    expect(text).toContain('workflow_dispatch:');
    expect(text).toMatch(/schedule:\n\s+- cron: '\d+ \d+ \* \* \*'/);
    expect(text).not.toMatch(/^\s*push:/m);
    expect(text).not.toMatch(/pull_request/);
  });

  it('builds the server at the release tag and at the pinned main commit, by full SHA', () => {
    expect(text).toContain('sha: 8c0fab9f0576d60c3da6e0cacd3b4718ad4814b4');
    expect(text).toContain('sha: 7bdd674afc482d700cc733be7c0b86a51f65883a');
    expect(text).toContain('ref: ${{ matrix.server.sha }}');
    expect(text).toContain('repository: mk6i/open-oscar-server');
  });

  it('builds with Go 1.26.2 and caches the binary by commit', () => {
    expect(text).toContain("go-version: '1.26.2'");
    expect(text).toContain('key: server-${{ runner.os }}-${{ runner.arch }}-go1.26.2-${{ matrix.server.sha }}');
    expect(lines.filter((l) => l === "- if: steps.server-cache.outputs.cache-hit != 'true'")).toHaveLength(3);
  });

  it('points the live suite at the built binary', () => {
    expect(lines).toContain('- run: npm run test:live');
    expect(text).toContain('OOS_BIN: ${{ github.workspace }}/server-bin/open_oscar_server');
  });

  it('uses only first-party actions, each pinned to a major version', () => {
    const uses = lines.filter((l) => /^(- )?uses:/.test(l)).map((l) => l.replace(/^(- )?uses:/, '').trim());
    expect(uses.length).toBe(5);
    for (const ref of uses) expect(ref).toMatch(/^actions\/[a-z-]+@v\d+$/);
  });

  it('asks for read-only repository access and no secrets', () => {
    expect(text).toContain('permissions:\n  contents: read');
    expect(text).not.toMatch(/secrets\./);
  });
});
