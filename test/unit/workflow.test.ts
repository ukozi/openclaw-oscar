import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const text = readFileSync(fileURLToPath(new URL('../../.github/workflows/ci.yml', import.meta.url)), 'utf8');
const lines = text.split('\n').map((l) => l.trim());

describe('ci workflow', () => {
  it('runs on the three supported Node lines', () => {
    expect(text).toContain("node: ['22.22', '24', 'current']");
  });

  it.each(['npm ci', 'npm run typecheck', 'npm test', 'npm run build', 'npm run plugin:ci'])('runs %s', (cmd) => {
    expect(lines).toContain(`- run: ${cmd}`);
  });

  it('fetches full history for the commit message check', () => {
    expect(text).toContain('fetch-depth: 0');
  });

  it('uses only first-party actions, each pinned to a major version', () => {
    const uses = lines.filter((l) => l.startsWith('- uses:')).map((l) => l.replace('- uses:', '').trim());
    expect(uses.length).toBeGreaterThan(0);
    for (const ref of uses) expect(ref).toMatch(/^actions\/[a-z-]+@v\d+$/);
  });

  it('asks for read-only repository access and no secrets', () => {
    expect(text).toContain('permissions:\n  contents: read');
    expect(text).not.toMatch(/secrets\./);
  });

  it('has no lint job and does not run on pull requests', () => {
    expect(text).not.toMatch(/\blint\b/i);
    expect(text).not.toMatch(/pull_request/);
  });
});
