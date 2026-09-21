import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8' });

const allowedTopLevel = new Set([
  '.github',
  '.gitignore',
  'LICENSE',
  'README.md',
  'assets',
  'openclaw.plugin.json',
  'package-lock.json',
  'package.json',
  'src',
  'test',
  'tsconfig.build.json',
  'tsconfig.json',
  'vitest.config.ts',
  'vitest.live.config.ts',
]);

function outsideAllowlist(paths: string[]): string[] {
  return paths.filter((p) => !allowedTopLevel.has(p.split('/')[0] ?? ''));
}

function coAuthorLines(log: string): string[] {
  return log.split('\n').filter((line) => /^\s*co-authored-by\s*:/i.test(line));
}

function literalAfterPassword(line: string): boolean {
  const rest = /\bpassword\b\s*[:=]\s*(.+)$/i.exec(line)?.[1]?.trim();
  if (!rest) return false;
  const quote = rest[0];
  let value: string;
  let quoted = false;
  if (quote === '"' || quote === "'" || quote === '`') {
    const end = rest.indexOf(quote, 1);
    if (end < 0) return false;
    value = rest.slice(1, end);
    quoted = true;
  } else {
    value = /^[^\s,;#)"'`]+/.exec(rest)?.[0] ?? '';
  }
  if (value.length < 16) return false;
  if (/[${}]/.test(value)) return false;
  if (!quoted && /^[A-Za-z_$][\w$]*(\??\.|\s*\(|$)/.test(value)) return false;
  return true;
}

function hostImportOffSubpath(line: string): boolean {
  const spec = /\b(?:from|import)\s*\(?\s*['"](openclaw(?:\/[^'"]*)?)['"]/.exec(line)?.[1];
  if (!spec) return false;
  return !/^openclaw\/plugin-sdk\/(?!zod$)[a-z0-9-]+$/.test(spec);
}

const rules: { name: string; hit: (line: string) => boolean }[] = [
  { name: 'child_process', hit: (l) => /child_process/.test(l) },
  { name: 'eval', hit: (l) => /\beval\s*\(/.test(l) },
  { name: 'new Function', hit: (l) => /\bnew\s+Function\b/.test(l) },
  { name: 'process.env', hit: (l) => /\bprocess\s*\.\s*env\b|\bprocess\s*\[\s*['"`]env['"`]\s*\]/.test(l) },
  { name: 'rejectUnauthorized: false', hit: (l) => /rejectUnauthorized['"]?\s*:\s*false/.test(l) },
  { name: 'raw-IP URL', hit: (l) => /[a-z][a-z0-9+.-]*:\/\/\d{1,3}(?:\.\d{1,3}){3}/i.test(l) },
  { name: 'literal after password', hit: literalAfterPassword },
  { name: 'host import off a typed subpath', hit: hostImportOffSubpath },
];

function firstRule(line: string): string | null {
  return rules.find((r) => r.hit(line))?.name ?? null;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sourceFiles(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : [],
  );
}

function commitMessages(): string {
  try {
    git('rev-parse', '--verify', '--quiet', 'HEAD');
  } catch {
    return '';
  }
  return git('log', '--format=%B');
}

describe('checks check what they claim', () => {
  it.each<[string, string | null]>([
    ["import { spawn } from 'node:child_process';", 'child_process'],
    ['const out = eval(code);', 'eval'],
    ["const f = new Function('a', 'return a');", 'new Function'],
    ['const p = process.env.OSCAR_PASSWORD;', 'process.env'],
    ["const p = process['env'].HOME;", 'process.env'],
    ['tls.connect({ host, rejectUnauthorized: false });', 'rejectUnauthorized: false'],
    ["const url = 'http://192.0.2.10:5190/';", 'raw-IP URL'],
    ["const url = 'oscar://203.0.113.7';", 'raw-IP URL'],
    ["const login = { password: 'correct-horse-battery' };", 'literal after password'],
    ['// password=abcdefgh-ijklmnop-1', 'literal after password'],
    ['const hint = "password: 0123456789abcdef0123";', 'literal after password'],
    ["const login = { password: 'short' };", null],
    ['const login = { password: await opts.getPassword() };', null],
    ['const login = { password: account.resolvedPasswordValue, host };', null],
    ['const login = { password: resolvedPasswordValueForLogin };', null],
    ['const login = { password: `${prefix}-abcdefghijklmnop` };', null],
    ['type Account = { password?: unknown; passwordFile?: string };', null],
    ["field: 'password',", null],
    ['const value = retrieval(key);', null],
    ['tls.connect({ host, rejectUnauthorized: true });', null],
    ["const host = 'oscar.example.net';", null],
    ["const version = '2026.7.1.2';", null],
    ["const docs = 'https://example.net/1.2.3.4/page';", null],
    ["import { definePluginEntry } from 'openclaw';", 'host import off a typed subpath'],
    ["import type { ChannelPlugin } from 'openclaw/plugin-sdk';", 'host import off a typed subpath'],
    ["import { x } from 'openclaw/dist/core-BrzUQHHT.js';", 'host import off a typed subpath'],
    ["import { z } from 'openclaw/plugin-sdk/zod';", 'host import off a typed subpath'],
    ["const sdk = await import('openclaw/plugin-sdk/testing/helpers');", 'host import off a typed subpath'],
    ["import type { ChannelPlugin } from 'openclaw/plugin-sdk/channel-core';", null],
    ["const sdk = await import('openclaw/plugin-sdk/channel-inbound');", null],
    ["configFile: 'openclaw.json',", null],
  ])('%s -> %s', (line, rule) => {
    expect(firstRule(line)).toBe(rule);
  });

  it.each<[string, string[]]>([
    ['src/index.ts', []],
    ['.github/workflows/ci.yml', []],
    ['package-lock.json', []],
    ['docs/plan.md', ['docs/plan.md']],
    ['notes.md', ['notes.md']],
    ['scripts/release.sh', ['scripts/release.sh']],
    ['.vscode/settings.json', ['.vscode/settings.json']],
    ['.npmrc', ['.npmrc']],
  ])('tracked path %s -> %j', (path, bad) => {
    expect(outsideAllowlist([path])).toEqual(bad);
  });

  it.each<[string, number]>([
    ['Add FLAP frame codec\n', 0],
    ['Add codec\n\nThe co-authored-by: text inside a sentence is fine.\n', 0],
    ['Add codec\n\nCo-authored-by: Someone <someone@example.com>\n', 1],
    ['Add codec\n\nCO-AUTHORED-BY: Someone <someone@example.com>\n  co-authored-by : Other <o@example.com>\n', 2],
  ])('message %j has %i co-author line(s)', (message, count) => {
    expect(coAuthorLines(message)).toHaveLength(count);
  });
});

describe('repository', () => {
  it('tracks only allowlisted top-level paths', () => {
    const tracked = git('ls-files').split('\n').filter(Boolean);
    expect(tracked.length).toBeGreaterThan(0);
    expect(outsideAllowlist(tracked)).toEqual([]);
  });

  it('tracks no symlinks', () => {
    const links = git('ls-files', '-s').split('\n').filter((line) => line.startsWith('120000'));
    expect(links).toEqual([]);
  });

  it('has no co-author trailers in any commit message', () => {
    expect(coAuthorLines(commitMessages())).toEqual([]);
  });
});

describe('shipped source', () => {
  it('uses nothing a registry scan refuses', () => {
    const files = sourceFiles(join(root, 'src'));
    expect(files.length).toBeGreaterThan(0);
    const hits = files.flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .flatMap((line, i) => {
          const rule = firstRule(line);
          return rule ? [`${relative(root, file)}:${i + 1} ${rule}`] : [];
        }),
    );
    expect(hits).toEqual([]);
  });
});
