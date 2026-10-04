import { afterEach, describe, expect, it } from 'vitest';
import { copy } from '../../src/copy.js';
import type { ImEvent } from '../../src/oscar/index.js';
import { maybeWarnOwners, missingHostOwners, ownerFixHandler, resetOwnerWarningForTests } from '../../src/owners.js';
import { setHost } from '../../src/runtime.js';

type Obj = Record<string, unknown>;

const cfgWith = (ownerAllowFrom: string[] | undefined, oscar: Obj = {}): Obj => ({
  ...(ownerAllowFrom ? { commands: { ownerAllowFrom } } : {}),
  channels: { oscar: { owners: ['alice'], allowFrom: ['bob'], screenName: 'botone', ...oscar } },
});
const twoAccounts = (ownerAllowFrom: string[]): Obj =>
  cfgWith(ownerAllowFrom, { screenName: undefined, accounts: { one: { screenName: 'botone' }, two: { screenName: 'bottwo' } } });
const im = (from: string, text: string): ImEvent => ({
  from, fromDisplay: from, text, cookie: 0n, autoResponse: false, offline: false, system: false,
});
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

afterEach(() => {
  resetOwnerWarningForTests();
  setHost(undefined);
});

describe('missingHostOwners', () => {
  it('names an owner the host list leaves out', () => {
    expect(missingHostOwners(cfgWith(['signal:uuid:x']))).toEqual(['alice']);
  });

  it('is empty once the owner is listed', () => {
    expect(missingHostOwners(cfgWith(['signal:uuid:x', 'oscar:Alice']))).toEqual([]);
    expect(missingHostOwners(cfgWith(['signal:uuid:x', 'alice']))).toEqual([]);
  });

  it('is empty when the host has no owner list or a star', () => {
    expect(missingHostOwners(cfgWith(undefined))).toEqual([]);
    expect(missingHostOwners(cfgWith(['*']))).toEqual([]);
  });
});

describe('maybeWarnOwners', () => {
  it('warns each missing owner once across accounts and sign-ons', async () => {
    const sent: [string, string][] = [];
    const send = async (owner: string, text: string) => { sent.push([owner, text]); };
    const cfg = twoAccounts(['signal:uuid:x']);
    maybeWarnOwners({ cfg, accountId: 'two', bot: 'bottwo', send });
    maybeWarnOwners({ cfg, accountId: 'one', bot: 'botone', send });
    maybeWarnOwners({ cfg, accountId: 'one', bot: 'botone', send });
    maybeWarnOwners({ cfg, accountId: 'two', bot: 'bottwo', send });
    await flush();
    expect(sent).toEqual([['alice', copy.ownersMissing('oscar:alice')]]);
  });

  it('waits for the first account to sign on', async () => {
    const sent: string[] = [];
    maybeWarnOwners({ cfg: twoAccounts(['signal:uuid:x']), accountId: 'two', bot: 'bottwo', send: async (o) => { sent.push(o); } });
    await flush();
    expect(sent).toEqual([]);
  });

  it('does not message itself', async () => {
    const sent: string[] = [];
    const cfg = cfgWith(['signal:uuid:x'], { owners: ['alice', 'botone'] });
    maybeWarnOwners({ cfg, accountId: 'default', bot: 'BotOne', send: async (o) => { sent.push(o); } });
    await flush();
    expect(sent).toEqual(['alice']);
  });

  it('says nothing when every owner is listed', async () => {
    const sent: string[] = [];
    maybeWarnOwners({ cfg: cfgWith(['oscar:alice']), accountId: 'default', bot: 'botone', send: async (o) => { sent.push(o); } });
    await flush();
    expect(sent).toEqual([]);
  });
});

describe('ownerFixHandler', () => {
  function harness(cfg: Obj, mutate?: (fn: (draft: Obj) => unknown) => Promise<unknown>) {
    const replies: [string, string][] = [];
    setHost({
      config: {
        current: () => cfg,
        ...(mutate ? { mutateConfigFile: (p: { afterWrite: unknown; mutate: (draft: Obj) => unknown }) => mutate(p.mutate) } : {}),
      },
    } as never);
    const handler = ownerFixHandler({ accountId: 'default', getCfg: () => cfg, reply: (to, text) => { replies.push([to, text]); } });
    return { handler, replies };
  }

  it('adds the missing owner and keeps the other entries', async () => {
    const drafts: Obj[] = [];
    const { handler, replies } = harness(cfgWith(['signal:uuid:x']), async (fn) => {
      const draft = structuredClone(cfgWith(['signal:uuid:x']));
      await fn(draft);
      drafts.push(draft);
      return { result: undefined };
    });
    expect(handler(im('Alice', '  Fix Owners '))).toBe('handled');
    await flush();
    expect((drafts[0]?.commands as Obj).ownerAllowFrom).toEqual(['signal:uuid:x', 'oscar:alice']);
    expect(replies).toEqual([['alice', copy.ownersFixed('oscar:alice')]]);
  });

  it('reports a failed write', async () => {
    const { handler, replies } = harness(cfgWith(['signal:uuid:x']), async () => { throw new Error('read-only file'); });
    expect(handler(im('alice', 'fix owners'))).toBe('handled');
    await flush();
    expect(replies).toEqual([['alice', copy.ownersFixFailed('read-only file')]]);
  });

  it('says so when the host cannot edit its config', async () => {
    const { handler, replies } = harness(cfgWith(['signal:uuid:x']));
    expect(handler(im('alice', 'fix owners'))).toBe('handled');
    await flush();
    expect(replies).toEqual([['alice', copy.ownersFixFailed('this OpenClaw cannot edit its config from a plugin')]]);
  });

  it('has nothing to add when every owner is listed', async () => {
    let calls = 0;
    const { handler, replies } = harness(cfgWith(['oscar:alice']), async () => { calls += 1; return {}; });
    expect(handler(im('alice', 'fix owners'))).toBe('handled');
    await flush();
    expect(calls).toBe(0);
    expect(replies).toEqual([['alice', copy.ownersNothingToFix()]]);
  });

  it('passes lines from others and longer lines', () => {
    const { handler } = harness(cfgWith(['signal:uuid:x']), async () => ({}));
    expect(handler(im('bob', 'fix owners'))).toBe('pass');
    expect(handler(im('alice', 'fix owners please'))).toBe('pass');
  });
});
