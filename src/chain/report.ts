import type { ChainFacts } from './controller.js';
import type { OpenHandoff } from './handoff.js';

export type ChainIssue = { kind: 'config' | 'runtime'; severity: 'error' | 'warning' | 'info'; message: string; fix: string };

const REFUSAL_SHOWN_MS = 10 * 60_000;

export function chainIssues(facts: ChainFacts | undefined, now: number): ChainIssue[] {
  if (!facts) return [];
  const issues: ChainIssue[] = [];
  for (const m of facts.mismatches) {
    issues.push({
      kind: 'config', severity: 'warning',
      message: `chain roster differs from ${m.peer} (mine ${m.mine}, theirs ${m.theirs}); both use name order until it matches`,
      fix: 'make channels.oscar.chain.roster identical on both gateways: same names, same order, same aliases',
    });
  }
  for (const name of facts.claims) {
    issues.push({
      kind: 'runtime', severity: 'info',
      message: `${name} claims to be in the chain but is not in chain.roster`,
      fix: 'add it to chain.roster on every gateway if it is yours; otherwise nothing to do, it cannot wake a bot',
    });
  }
  if (facts.lastRefusal && now - facts.lastRefusal.at < REFUSAL_SHOWN_MS) {
    issues.push({
      kind: 'runtime', severity: 'info',
      message: `a hand-off to ${facts.lastRefusal.to} was not sent: ${facts.lastRefusal.reason}`,
      fix: 'the line went out as ordinary room text; hand the job over again once the reason is gone',
    });
  }
  return issues;
}

export function handoffAwarenessLines(open: OpenHandoff[], now: number): string[] {
  return open.map((h) => {
    const minutes = Math.floor((now - h.createdAt) / 60_000);
    return `open hand-off ${h.id} to ${h.to} in ${h.room.name} for ${h.originator}, ${minutes} min`;
  });
}
