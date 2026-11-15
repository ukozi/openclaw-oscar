import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const src = fileURLToPath(new URL('../../../src/', import.meta.url));
const dir = `${src}oscar/`;
const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
const read = (file: string): string => readFileSync(`${dir}${file}`, 'utf8');
const specifiers = (text: string): string[] => [...text.matchAll(/\bfrom\s+'([^']+)'/g)].map((m) => m[1] ?? '');

describe('src/oscar stands alone', () => {
  it.each(files)('%s imports only node built-ins, its siblings and the client kit', (file) => {
    for (const s of specifiers(read(file))) {
      expect(s).toMatch(/^(node:[a-z/]+|\.\/[a-z-]+\.js|open-oscar-client-kit\/(wire|client|model))$/);
    }
  });

  it('has exactly the session files', () => {
    expect([...files].sort()).toEqual(['bos.ts', 'events.ts', 'index.ts', 'kit-client.ts', 'login.ts', 'rooms.ts', 'session.ts', 'types.ts']);
  });

  it('no file outside src/oscar imports the client kit', () => {
    const outside = readdirSync(src, { recursive: true, encoding: 'utf8' })
      .map((f) => f.split('\\').join('/'))
      .filter((f) => f.endsWith('.ts') && !f.startsWith('oscar/'));
    expect(outside.length).toBeGreaterThan(0);
    for (const file of outside) {
      const text = readFileSync(`${src}${file}`, 'utf8');
      expect(/['"]open-oscar-client-kit/.test(text), `${file} imports the client kit`).toBe(false);
    }
  });

  it.each(files)('%s has nothing the package scanner rejects', (file) => {
    const text = read(file);
    for (const banned of ['child_process', 'eval(', 'new Function', 'process.env', 'rejectUnauthorized']) {
      expect(text.includes(banned), `${file} contains ${banned}`).toBe(false);
    }
  });
});
