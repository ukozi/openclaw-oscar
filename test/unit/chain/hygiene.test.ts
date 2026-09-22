import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = 'src/chain';
const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
const read = (f: string) => readFileSync(join(dir, f), 'utf8');

describe('chain modules', () => {
  it('has every module the plan lists', () => {
    expect(files.sort()).toEqual([
      'ack.ts', 'address.ts', 'controller.ts', 'guards.ts', 'handoff.ts', 'hello.ts', 'holds.ts',
      'prompts.ts', 'report.ts', 'route.ts', 'takeover.ts', 'types.ts', 'wiring.ts',
    ]);
  });

  it.each(files)('%s keeps to the shipped-code rules', (f) => {
    const text = read(f);
    for (const banned of ['child_process', 'eval(', 'new Function', 'process.env', 'rejectUnauthorized']) {
      expect(text.includes(banned), `${f} contains ${banned}`).toBe(false);
    }
    expect(/\b(AIM|AOL|Instant Messenger)\b/.test(text), `${f} names the old product`).toBe(false);
  });

  it('only wiring.ts reaches into modules owned by other plans', () => {
    const outside = /from '\.\.\/(inbound\/|outbound\.js|status\.js|awareness\.js|channel\.js|index\.js)/;
    for (const f of files.filter((name) => name !== 'wiring.ts')) {
      expect(outside.test(read(f)), `${f} imports a seam module`).toBe(false);
    }
  });

  it('pure cores import no timers, sockets or SDK runtime', () => {
    for (const f of ['address.ts', 'route.ts', 'prompts.ts', 'report.ts', 'holds.ts']) {
      const text = read(f);
      expect(/setTimeout|node:net|node:tls/.test(text), `${f} is not pure`).toBe(false);
      expect(/^import (?!type)[^;]*from 'openclaw\//m.test(text), `${f} has a runtime SDK import`).toBe(false);
    }
  });

  it('logs names, ids and keys, never message text', () => {
    const text = read('controller.ts');
    const logCalls = text.match(/log\.(debug|info|warn|error)\([^;]*;/g) ?? [];
    expect(logCalls.length).toBeGreaterThan(0);
    for (const call of logCalls) expect(/\b(text|body|markdown|task)\b\s*[,}]/.test(call), call).toBe(false);
  });
});
