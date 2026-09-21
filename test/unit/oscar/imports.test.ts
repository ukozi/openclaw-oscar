import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const dir = fileURLToPath(new URL('../../../src/oscar/', import.meta.url));
const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
const read = (file: string): string => readFileSync(`${dir}${file}`, 'utf8');

describe('src/oscar stands alone', () => {
  it.each(files)('%s imports only node built-ins and its own siblings', (file) => {
    const specifiers = [...read(file).matchAll(/\bfrom\s+'([^']+)'/g)].map((m) => m[1] ?? '');
    for (const s of specifiers) expect(s).toMatch(/^(node:[a-z/]+|\.\/[a-z-]+\.js)$/);
  });

  it.each(files)('%s has nothing the package scanner rejects', (file) => {
    const text = read(file);
    for (const banned of ['child_process', 'eval(', 'new Function', 'process.env', 'rejectUnauthorized']) {
      expect(text.includes(banned), `${file} contains ${banned}`).toBe(false);
    }
  });

  it('has every module this plan names', () => {
    expect(files).toEqual(
      expect.arrayContaining([
        'auth.ts',
        'bos.ts',
        'bytes.ts',
        'connection.ts',
        'constants.ts',
        'flap.ts',
        'index.ts',
        'rate.ts',
        'session.ts',
        'snac.ts',
        'text.ts',
        'tlv.ts',
        'types.ts',
      ]),
    );
  });
});
