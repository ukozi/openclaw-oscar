import { describe, expect, it } from 'vitest';
import type { ResolverContext } from 'openclaw/plugin-sdk/channel-secret-basic-runtime';
import * as contract from '../../src/secret-contract-api.js';

const ref = { source: 'env', provider: 'default', id: 'OSCAR_PASSWORD' };

function collect(oscar: Record<string, unknown>) {
  const config = { channels: { oscar } };
  const context = {
    sourceConfig: config,
    env: {},
    cache: {},
    warnings: [],
    warningKeys: new Set<string>(),
    assignments: [],
  } as unknown as ResolverContext;
  contract.collectRuntimeConfigAssignments({ config, context });
  return {
    assigned: context.assignments.map((a) => a.path).sort(),
    skipped: context.warnings.map((w) => w.path).sort(),
  };
}

describe('secret contract', () => {
  it('exports what the host loader looks for', () => {
    expect(typeof contract.collectRuntimeConfigAssignments).toBe('function');
    expect(contract.secretTargetRegistryEntries.map((e) => e.pathPattern).sort()).toEqual([
      'channels.oscar.accounts.*.password',
      'channels.oscar.password',
    ]);
    for (const e of contract.secretTargetRegistryEntries) {
      expect(e).toMatchObject({ id: e.pathPattern, configFile: 'openclaw.json', secretShape: 'secret_input', expectedResolvedValue: 'string' });
    }
  });

  it.each<[string, Record<string, unknown>, string[], string[]]>([
    ['top-level ref, no accounts', { password: ref }, ['channels.oscar.password'], []],
    ['top-level ref beside passwordFile', { password: ref, passwordFile: '/run/secrets/oscar' }, [], ['channels.oscar.password']],
    ['channel disabled', { enabled: false, password: ref }, [], ['channels.oscar.password']],
    ['plain string password', { password: 'hunter2' }, [], []],
    ['no password at all', { screenName: 'botone' }, [], []],
    [
      'account ref',
      { accounts: { botone: { password: ref } } },
      ['channels.oscar.accounts.botone.password'],
      [],
    ],
    [
      'account ref beside account passwordFile',
      { accounts: { botone: { password: ref, passwordFile: '/run/secrets/botone' } } },
      [],
      ['channels.oscar.accounts.botone.password'],
    ],
    [
      'disabled account',
      { accounts: { botone: { enabled: false, password: ref } } },
      [],
      ['channels.oscar.accounts.botone.password'],
    ],
    [
      'top-level ref inherited by an account without its own',
      { password: ref, accounts: { botone: { screenName: 'botone' } } },
      ['channels.oscar.password'],
      [],
    ],
    [
      'top-level ref shadowed by every account',
      { password: ref, accounts: { botone: { password: ref } } },
      ['channels.oscar.accounts.botone.password'],
      ['channels.oscar.password'],
    ],
  ])('%s', (_name, oscar, assigned, skipped) => {
    expect(collect(oscar)).toEqual({ assigned, skipped });
  });

  it('does nothing when the channel block is absent', () => {
    const context = { sourceConfig: {}, env: {}, cache: {}, warnings: [], warningKeys: new Set<string>(), assignments: [] } as unknown as ResolverContext;
    contract.collectRuntimeConfigAssignments({ config: {}, context });
    expect(context.assignments).toEqual([]);
  });
});
