import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ChainFacts } from '../../../src/chain/controller.js';
import { chainIssues, handoffAwarenessLines } from '../../../src/chain/report.js';
import { ROOM } from './fixtures.js';

const NOW = 10_000_000;
const clean: ChainFacts = { mismatches: [], claims: [], lastRefusal: null, open: [] };

describe('chainIssues', () => {
  it('is empty for a healthy chain and for an account with no chain', () => {
    expect(chainIssues(clean, NOW)).toEqual([]);
    expect(chainIssues(undefined, NOW)).toEqual([]);
  });

  it('reports a roster mismatch with both hashes and a fix', () => {
    const [issue] = chainIssues({ ...clean, mismatches: [{ peer: 'bottwo', theirs: 'deadbeef', mine: '0a1b2c3d' }] }, NOW);
    expect(issue).toEqual({
      kind: 'config', severity: 'warning',
      message: 'chain roster differs from bottwo (mine 0a1b2c3d, theirs deadbeef); both use name order until it matches',
      fix: 'make channels.oscar.chain.roster identical on both gateways: same names, same order, same aliases',
    });
  });

  it('reports a non-roster name that claims to be in the chain', () => {
    const [issue] = chainIssues({ ...clean, claims: ['mallory'] }, NOW);
    expect(issue).toMatchObject({ kind: 'runtime', severity: 'info', message: 'mallory claims to be in the chain but is not in chain.roster' });
    expect(issue?.fix).toBeTruthy();
  });

  it('leaves the owner wildcard and a bot missing from its own roster to the modules that already report them', () => {
    expect(readFileSync('src/status.ts', 'utf8')).toContain('hand-offs are refused');
    expect(readFileSync('src/config.ts', 'utf8')).toContain('is missing from the roster');
  });

  it('shows a refused text hand-off for ten minutes', () => {
    const lastRefusal = { at: NOW - 60_000, to: 'bottwo', reason: 'bottwo is not in this room' };
    const [issue] = chainIssues({ ...clean, lastRefusal }, NOW);
    expect(issue).toMatchObject({ kind: 'runtime', severity: 'info', message: 'a hand-off to bottwo was not sent: bottwo is not in this room' });
    expect(issue?.fix).toBeTruthy();
    expect(chainIssues({ ...clean, lastRefusal }, NOW + 600_000)).toEqual([]);
    expect(chainIssues({ ...clean, lastRefusal: { ...lastRefusal, at: NOW - 599_999 } }, NOW)).toHaveLength(1);
    expect(chainIssues({ ...clean, lastRefusal: { ...lastRefusal, at: NOW - 600_000 } }, NOW)).toEqual([]);
  });
});

describe('handoffAwarenessLines', () => {
  it('lists open hand-offs with their age', () => {
    const open = [{ id: '1-k7f3', to: 'bottwo', room: ROOM, originator: 'alice', hop: 1, createdAt: NOW - 185_000 }];
    expect(handoffAwarenessLines(open, NOW)).toEqual(['open hand-off 1-k7f3 to bottwo in testroom for alice, 3 min']);
    expect(handoffAwarenessLines([], NOW)).toEqual([]);
  });
});
