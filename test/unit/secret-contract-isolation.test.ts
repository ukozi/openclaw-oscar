import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../../src/secret-contract-api.ts', import.meta.url), 'utf8');
const specifiers = [...source.matchAll(/\b(?:from|import)\s+'([^']+)'/g)].map((m) => m[1]);

describe('secret contract file', () => {
  it('imports nothing from the rest of the plugin', () => {
    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers.filter((spec) => spec?.startsWith('.'))).toEqual([]);
  });

  it('imports one host subpath and nothing else', () => {
    expect([...new Set(specifiers)]).toEqual(['openclaw/plugin-sdk/channel-secret-basic-runtime']);
  });
});
