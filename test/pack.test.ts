import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
const shippable = /^(dist\/.+\.(js|d\.ts)|openclaw\.plugin\.json|assets\/icon\.png|package\.json|README\.md|LICENSE)$/;
const unwanted = /\.(test|spec)\.|\.map$|(^|\/)(fixtures?|vectors|fake)\//;

function unexpected(paths: string[]): string[] {
  return paths.filter((p) => !shippable.test(p) || unwanted.test(p));
}

let packed: string[] = [];

beforeAll(() => {
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(join(root, 'dist', 'stale.js'), 'export {};\n');
  execFileSync('npm', ['run', 'build', '--silent'], { cwd: root, stdio: 'pipe' });
  const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const report = JSON.parse(out) as { files: { path: string }[] }[];
  packed = (report[0]?.files ?? []).map((f) => f.path).sort();
}, 180_000);

describe('file filter', () => {
  it.each<[string, boolean]>([
    ['dist/index.js', true],
    ['dist/index.d.ts', true],
    ['dist/oscar/flap.js', true],
    ['openclaw.plugin.json', true],
    ['assets/icon.png', true],
    ['package.json', true],
    ['README.md', true],
    ['LICENSE', true],
    ['dist/index.js.map', false],
    ['dist/index.d.ts.map', false],
    ['dist/oscar/flap.test.js', false],
    ['dist/fake/oscar-server.js', false],
    ['src/index.ts', false],
    ['test/pack.test.ts', false],
    ['tsconfig.json', false],
    ['package-lock.json', false],
    ['README.internal.md', false],
    ['CHANGELOG.md', false],
    ['assets/icon.svg', false],
    ['.github/workflows/ci.yml', false],
  ])('%s shippable: %s', (path, ok) => {
    expect(unexpected([path]).length === 0).toBe(ok);
  });
});

describe('npm pack', () => {
  it('lists nothing outside the allowlist', () => {
    expect(packed.length).toBeGreaterThan(0);
    expect(unexpected(packed)).toEqual([]);
  });

  it.each([
    'dist/index.js',
    'dist/index.d.ts',
    'dist/setup-entry.js',
    'dist/secret-contract-api.js',
    'openclaw.plugin.json',
    'assets/icon.png',
    'package.json',
    'README.md',
    'LICENSE',
  ])('includes %s', (path) => {
    expect(packed).toContain(path);
  });

  it('includes every entry the package metadata points at', () => {
    const oc = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).openclaw as {
      runtimeExtensions: string[];
      runtimeSetupEntry: string;
    };
    for (const entry of [...oc.runtimeExtensions, oc.runtimeSetupEntry]) {
      expect(packed).toContain(entry.replace(/^\.\//, ''));
    }
  });

  it('drops files left in dist by an earlier build', () => {
    expect(packed).not.toContain('dist/stale.js');
  });
});

describe('build output', () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));

  it('carries no absolute paths from the build machine', () => {
    const needles = [root.replace(/\/$/, ''), homedir()];
    const hits = walk(join(root, 'dist')).filter((file) => {
      const text = readFileSync(file, 'utf8');
      return needles.some((n) => text.includes(n));
    });
    expect(hits).toEqual([]);
  });

  it('carries no comments', () => {
    const hits = walk(join(root, 'dist'))
      .filter((file) => file.endsWith('.js'))
      .filter((file) => /^\s*(\/\/|\/\*)/m.test(readFileSync(file, 'utf8')));
    expect(hits).toEqual([]);
  });
});

describe('icon', () => {
  it('is a square PNG of at most 512 KiB', () => {
    const file = join(root, 'assets', 'icon.png');
    const bytes = readFileSync(file);
    expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(bytes.subarray(12, 16).toString('ascii')).toBe('IHDR');
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    expect(width).toBe(height);
    expect(width).toBeGreaterThanOrEqual(128);
    expect(width).toBeLessThanOrEqual(1024);
    expect(statSync(file).size).toBeLessThanOrEqual(512 * 1024);
  });
});
