import { CHANNEL_ID, listAccountIds, readPolicy } from './config.js';
import { copy } from './copy.js';
import type { ImControlHandler } from './inbound/im.js';
import { normalizeName } from './names.js';
import { roleOf } from './policy.js';
import { hostConfigMutation } from './runtime.js';
import { withOwnerAllowFrom } from './setup.js';
import { hostOwnerList } from './status.js';

let warned = false;

export function missingHostOwners(cfg: unknown): string[] {
  const entries = hostOwnerList(cfg);
  // An empty list makes the host fall back to allowFrom; adding entries would narrow who counts as owner on other channels.
  if (entries.length === 0 || entries.includes('*')) return [];
  const listed = new Set(entries.filter((e) => /^oscar:/i.test(e) || !e.includes(':')).map(normalizeName));
  return readPolicy(cfg).owners.filter((owner) => !listed.has(owner));
}

export function maybeWarnOwners(p: { cfg: unknown; accountId: string; bot: string; send: (owner: string, text: string) => Promise<void> }): void {
  if (warned || p.accountId !== listAccountIds(p.cfg)[0]) return;
  warned = true;
  for (const owner of missingHostOwners(p.cfg)) {
    if (owner === normalizeName(p.bot)) continue;
    void p.send(owner, copy.ownersMissing(`${CHANNEL_ID}:${owner}`)).catch(() => undefined);
  }
}

export function ownerFixHandler(p: { accountId: string; getCfg: () => unknown; reply: (to: string, text: string) => void }): ImControlHandler {
  return (ev) => {
    const cfg = p.getCfg();
    const from = normalizeName(ev.from);
    if (ev.text.trim().toLowerCase() !== 'fix owners' || roleOf(from, readPolicy(cfg)) !== 'owner') return 'pass';
    const missing = missingHostOwners(cfg);
    if (missing.length === 0) {
      p.reply(from, copy.ownersNothingToFix());
      return 'handled';
    }
    const mutate = hostConfigMutation();
    if (!mutate) {
      p.reply(from, copy.ownersFixFailed('this OpenClaw cannot edit its config from a plugin'));
      return 'handled';
    }
    const added = missing.map((owner) => `${CHANNEL_ID}:${owner}`).join(', ');
    mutate({
      afterWrite: { mode: 'auto' },
      mutate: (draft) => { draft.commands = withOwnerAllowFrom(draft, missing).commands; },
    }).then(
      () => p.reply(from, copy.ownersFixed(added)),
      (err: unknown) => p.reply(from, copy.ownersFixFailed(err instanceof Error ? err.message : String(err))),
    );
    return 'handled';
  };
}

export function resetOwnerWarningForTests(): void {
  warned = false;
}
