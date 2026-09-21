import { describe, expect, it } from 'vitest';
import {
  RELOAD_NOOP_PREFIXES, ROOM_CHUNK_MAX, ROOT_ONLY_KEYS, buddyList, configProblems, defaultAccountId, listAccountIds,
  oscarChannelConfigSchema, readPolicy, resolveAccount, rosterHash,
} from '../../src/config.js';
import type { ChainConfig } from '../../src/config.js';

type Sec = Record<string, unknown>;
const cfgOf = (sec: Sec) => ({ channels: { oscar: sec } });
const good = (): Sec => ({
  host: 'oscar.example.net', screenName: 'Bot One', password: 'hunter22',
  owners: ['Alice'], allowFrom: ['alice', 'Bob'],
});

describe('accounts', () => {
  it('lists default for a root-only block, keys for accounts, nothing for no block', () => {
    expect(listAccountIds(cfgOf(good()))).toEqual(['default']);
    expect(listAccountIds(cfgOf({ ...good(), accounts: { botone: {}, bottwo: {} } }))).toEqual(['botone', 'bottwo']);
    expect(listAccountIds({})).toEqual([]);
    expect(listAccountIds(cfgOf({ owners: ['alice'] }))).toEqual([]);
  });

  it('picks the default account', () => {
    expect(defaultAccountId(cfgOf(good()))).toBe('default');
    expect(defaultAccountId(cfgOf({ ...good(), accounts: { botone: {}, bottwo: {} }, defaultAccount: 'bottwo' }))).toBe('bottwo');
    expect(defaultAccountId(cfgOf({ ...good(), accounts: { botone: {} }, defaultAccount: 'gone' }))).toBe('botone');
  });

  it('resolves defaults and normalises the screen name', () => {
    const a = resolveAccount(cfgOf(good()));
    expect(a).toMatchObject({
      accountId: 'default', enabled: true, configured: true, screenName: 'botone', display: 'Bot One',
      host: 'oscar.example.net', port: 5190, tls: false, redirect: 'auto', dangerouslyAllowUnauthenticatedServer: false,
      typing: true, textChunkLimit: 1800, roomTextChunkLimit: 900,
      away: { enabled: true, message: 'Working on something. Back in a bit.', blurb: 'agent', graceMs: 2000, maxLength: 100 },
    });
    expect(a.blockStreaming).toBeUndefined();
  });

  it('clamps the room chunk limit to what a room accepts', () => {
    const limit = (sec: Sec, id?: string) => resolveAccount(cfgOf(sec), id).roomTextChunkLimit;
    expect(ROOM_CHUNK_MAX).toBe(1024);
    expect(limit({ ...good(), roomTextChunkLimit: 2000 })).toBe(1024);
    expect(limit({ ...good(), roomTextChunkLimit: 1024 })).toBe(1024);
    expect(limit({ ...good(), roomTextChunkLimit: 500 })).toBe(500);
    expect(limit({ ...good(), accounts: { bottwo: { screenName: 'bottwo', password: 'hunter23', roomTextChunkLimit: 1500 } } }, 'bottwo')).toBe(1024);
    expect(configProblems(cfgOf({ ...good(), roomTextChunkLimit: 2000 }))).toEqual([]);
  });

  it('lets an account override root transport keys and merges away', () => {
    const cfg = cfgOf({
      ...good(), port: 5191, away: { maxLength: 80 },
      accounts: { bottwo: { screenName: 'bottwo', password: 'hunter23', tls: true, away: { enabled: false }, typing: false, blockStreaming: true } },
    });
    const a = resolveAccount(cfg, 'bottwo');
    expect(a).toMatchObject({ accountId: 'bottwo', screenName: 'bottwo', host: 'oscar.example.net', port: 5191, tls: true, typing: false, blockStreaming: true });
    expect(a.away).toMatchObject({ enabled: false, maxLength: 80 });
  });

  it.each([
    [{ password: undefined }, false],
    [{ password: '' }, false],
    [{ password: undefined, passwordFile: '/run/secrets/oscar' }, true],
    [{ password: { source: 'env', provider: 'default', id: 'OSCAR_PASSWORD' } }, true],
    [{ host: undefined }, false],
    [{ screenName: undefined }, false],
  ])('configured for %j is %s', (patch, want) => {
    expect(resolveAccount(cfgOf({ ...good(), ...patch })).configured).toBe(want);
  });

  it('reports a disabled account', () => {
    expect(resolveAccount(cfgOf({ ...good(), enabled: false })).enabled).toBe(false);
    expect(resolveAccount(cfgOf({ ...good(), accounts: { botone: { enabled: false } } }), 'botone').enabled).toBe(false);
  });

  it('returns an unconfigured shell for an unknown account', () => {
    expect(resolveAccount({}, 'nope')).toMatchObject({ accountId: 'nope', configured: false, screenName: '' });
  });

  it('answers an unknown account id with the root defaults', () => {
    const cfg = cfgOf({ ...good(), port: 5191, accounts: { botone: { screenName: 'botone' } } });
    expect(resolveAccount(cfg, 'nope')).toMatchObject({ accountId: 'nope', configured: true, screenName: 'botone', host: 'oscar.example.net', port: 5191 });
  });
});

describe('configProblems', () => {
  it('accepts the spec example shape', () => {
    expect(configProblems(cfgOf({
      enabled: true, host: 'oscar.example.net', port: 5190, tls: false, redirect: 'auto', screenName: 'botone',
      password: { source: 'env', provider: 'default', id: 'OSCAR_PASSWORD' }, dangerouslyAllowUnauthenticatedServer: false,
      owners: ['alice'], allowFrom: ['alice', 'bob'], dmPolicy: 'allowlist', dangerouslyAllowOpenDm: false,
      contactNotice: { cooldownHours: 6, maxPerHour: 5 },
      nonOwnerTools: { deny: ['group:runtime', 'group:fs', 'group:automation', 'group:nodes', 'sessions_spawn'] },
      outbound: { allowUnlisted: false },
      room: { name: 'alicek7f3', exchange: 4, historyFrom: 'listed', notifyOnUnlistedJoin: true },
      invites: { accept: 'approved', maxRooms: 5, leaveWhenAloneMinutes: 10 },
      rooms: { alicek7f3: { toolsBySender: {}, systemPrompt: '' } },
      away: { enabled: true, message: 'Working on something. Back in a bit.', blurb: 'agent', graceMs: 2000, maxLength: 100 },
      typing: true, awareness: { lines: 5 },
      chain: {
        roster: [{ screenName: 'botone', role: 'lead', aliases: [] }, { screenName: 'bottwo', role: 'writing' }],
        floorSeconds: 120, takeoverMs: 10000, ackAfterMs: 8000, ackText: 'on it', busyText: 'busy, will pick this up next',
        maxHops: 2, resultTimeoutMinutes: 20, reviewResults: false,
      },
      textChunkLimit: 1800, roomTextChunkLimit: 900,
      accounts: { botone: { screenName: 'botone' } }, defaultAccount: 'botone',
    }))).toEqual([]);
  });

  it('is empty when the block is absent', () => {
    expect(configProblems({})).toEqual([]);
  });

  it.each(ROOT_ONLY_KEYS.map((k) => [k]))('rejects %s under an account and names the key', (key) => {
    const problems = configProblems(cfgOf({ ...good(), accounts: { botone: { screenName: 'botone', [key]: [] } } }));
    expect(problems.some((p) => p.startsWith(`channels.oscar.accounts.botone.${key}:`) && p.includes('root-only'))).toBe(true);
  });

  it.each([
    ['unknown root key', { pairing: true }, 'channels.oscar.pairing:'],
    ['pairing policy', { dmPolicy: 'pairing' }, 'channels.oscar.dmPolicy:'],
    ['open without the flag', { dmPolicy: 'open' }, 'channels.oscar.dangerouslyAllowOpenDm:'],
    ['non-ASCII owner', { owners: ['аlice'] }, 'channels.oscar.owners.0:'],
    ['non-ASCII approved', { allowFrom: ['alice', 'bøb'] }, 'channels.oscar.allowFrom.1:'],
    ['a star in allowFrom', { allowFrom: ['alice', ' * '] }, 'channels.oscar.allowFrom.1:'],
    ['a star in owners', { owners: ['*'] }, 'channels.oscar.owners.0:'],
    ['home room with a dash', { room: { name: 'my-room' } }, 'channels.oscar.room.name:'],
    ['roster name that is an owner', { chain: { roster: [{ screenName: 'botone' }, { screenName: 'Alice' }] } }, 'channels.oscar.chain.roster.1.screenName:'],
    ['roster name that is approved', { chain: { roster: [{ screenName: 'botone' }, { screenName: 'bob' }] } }, 'channels.oscar.chain.roster.1.screenName:'],
    ['self missing from the roster', { chain: { roster: [{ screenName: 'bottwo' }] } }, 'channels.oscar.chain.roster:'],
    ['alias equal to a roster name', { chain: { roster: [{ screenName: 'botone', aliases: ['Bot Two'] }, { screenName: 'bottwo' }] } }, 'channels.oscar.chain.roster.0.aliases.0:'],
    ['duplicate alias', { chain: { roster: [{ screenName: 'botone', aliases: ['b'] }, { screenName: 'bottwo', aliases: ['B'] }] } }, 'channels.oscar.chain.roster.1.aliases.0:'],
    ['alias equal to an approved name', { chain: { roster: [{ screenName: 'botone', aliases: ['Bob'] }] } }, 'channels.oscar.chain.roster.0.aliases.0:'],
    ['no password on an enabled account', { password: undefined }, 'channels.oscar.password:'],
    ['no owners', { owners: [] }, 'channels.oscar.owners:'],
    ['owners left out', { owners: undefined }, 'channels.oscar.owners:'],
    ['owners that can never match', { owners: ['*', 'аlice'] }, 'channels.oscar.owners:'],
  ])('%s', (_label, patch, prefix) => {
    const problems = configProblems(cfgOf({ ...good(), ...patch }));
    expect(problems.some((p) => p.startsWith(prefix)), problems.join(' | ')).toBe(true);
  });

  it('names both accounts that share a screen name', () => {
    const problems = configProblems(cfgOf({ host: 'h', password: 'hunter22', accounts: { a: { screenName: 'Bot One' }, b: { screenName: 'botone' } } }));
    expect(problems.some((p) => p.startsWith('channels.oscar.accounts.b.screenName:') && p.includes('"a"'))).toBe(true);
  });

  it('does not ask a disabled account for a password', () => {
    expect(configProblems(cfgOf({ ...good(), password: undefined, enabled: false }))).toEqual([]);
  });

  it('asks for an owner once, only when an account would run, and says why', () => {
    const two = configProblems(cfgOf({ host: 'h', password: 'hunter22', accounts: { a: { screenName: 'botone' }, b: { screenName: 'bottwo' } } }));
    expect(two.filter((p) => p.startsWith('channels.oscar.owners:'))).toEqual([
      'channels.oscar.owners: list at least one owner; with none, OpenClaw treats every approved person as an owner',
    ]);
    expect(configProblems(cfgOf({ ...good(), owners: [], enabled: false }))).toEqual([]);
  });

  it('points at the account that lacks a password', () => {
    const problems = configProblems(cfgOf({ host: 'h', accounts: { a: { screenName: 'botone' } } }));
    expect(problems.some((p) => p.startsWith('channels.oscar.accounts.a.password:'))).toBe(true);
  });
});

describe('readPolicy', () => {
  it('fills defaults and puts owners into allowFrom', () => {
    const p = readPolicy(cfgOf({ ...good(), owners: ['Alice B'], allowFrom: ['Sam Smith'] }));
    expect(p.owners).toEqual(['aliceb']);
    expect(p.allowFrom).toEqual(['aliceb', 'samsmith']);
    expect(p).toMatchObject({
      dmPolicy: 'allowlist', contactNotice: { cooldownHours: 6, maxPerHour: 5 },
      nonOwnerTools: { deny: ['group:runtime', 'group:fs', 'group:automation', 'group:nodes', 'sessions_spawn'] },
      outbound: { allowUnlisted: false }, invites: { accept: 'approved', maxRooms: 5, leaveWhenAloneMinutes: 10 },
      rooms: {}, awareness: { lines: 5 },
      chain: { roster: [], floorSeconds: 120, takeoverMs: 10000, ackAfterMs: 8000, ackText: 'on it', busyText: 'busy, will pick this up next', maxHops: 2, resultTimeoutMinutes: 20, reviewResults: false },
    });
    expect(p.room).toBeUndefined();
  });

  it('never throws and fails closed', () => {
    const owned = (patch: Sec) => cfgOf({ owners: ['alice'], ...patch });
    expect(readPolicy(owned({})).dmPolicy).toBe('allowlist');
    expect(readPolicy({ channels: { oscar: 7 } }).owners).toEqual([]);
    expect(readPolicy(owned({ dmPolicy: 'open' })).dmPolicy).toBe('allowlist');
    expect(readPolicy(owned({ dmPolicy: 'open', dangerouslyAllowOpenDm: true })).dmPolicy).toBe('open');
    expect(readPolicy(owned({ dmPolicy: 'pairing' })).dmPolicy).toBe('allowlist');
    expect(readPolicy(owned({ dmPolicy: 'disabled' })).dmPolicy).toBe('disabled');
  });

  it('approves nobody while there is no owner', () => {
    for (const cfg of [undefined, cfgOf({ allowFrom: ['bob'] }), cfgOf({ owners: [], allowFrom: ['bob'], dmPolicy: 'open', dangerouslyAllowOpenDm: true, outbound: { allowUnlisted: true } }), cfgOf({ owners: ['*'], allowFrom: ['bob'] })]) {
      expect(readPolicy(cfg)).toMatchObject({ owners: [], allowFrom: [], dmPolicy: 'disabled', outbound: { allowUnlisted: false } });
    }
    expect(readPolicy(cfgOf({ owners: ['alice'], allowFrom: ['bob'] })).allowFrom).toEqual(['alice', 'bob']);
  });

  it('drops names that can never match', () => {
    const p = readPolicy(cfgOf({ owners: ['alice', 'аlice', '', 42, '*'], allowFrom: ['bob', 'bob', ' Bob ', '*', 'oscar:*'] }));
    expect(p.owners).toEqual(['alice']);
    expect(p.allowFrom).toEqual(['alice', 'bob']);
  });

  it('reads the home room and the roster', () => {
    const p = readPolicy(cfgOf({
      room: { name: ' TestRoom ', exchange: 5, historyFrom: 'all', notifyOnUnlistedJoin: false },
      chain: { roster: [{ screenName: 'Bot One', role: 'lead', aliases: ['One'] }, { screenName: 'bottwo' }], maxHops: 3 },
    }));
    expect(p.room).toEqual({ ref: { exchange: 5, name: 'testroom' }, historyFrom: 'all', notifyOnUnlistedJoin: false });
    expect(p.chain.roster).toEqual([{ screenName: 'botone', role: 'lead', aliases: ['one'] }, { screenName: 'bottwo', role: '', aliases: [] }]);
    expect(p.chain.maxHops).toBe(3);
  });
});

describe('rosterHash', () => {
  const chain = (roster: ChainConfig['roster']): ChainConfig => ({ ...readPolicy({}).chain, roster });
  const a = chain([{ screenName: 'botone', role: 'lead', aliases: ['one'] }, { screenName: 'bottwo', role: 'w', aliases: [] }]);

  it('is 8 hex and ignores roles', () => {
    expect(rosterHash(a)).toMatch(/^[0-9a-f]{8}$/);
    expect(rosterHash(chain([{ screenName: 'botone', role: 'x', aliases: ['one'] }, { screenName: 'bottwo', role: 'y', aliases: [] }]))).toBe(rosterHash(a));
  });

  it('changes with order, names and aliases', () => {
    expect(rosterHash(chain([...a.roster].reverse()))).not.toBe(rosterHash(a));
    expect(rosterHash(chain([{ screenName: 'botone', role: '', aliases: [] }, { screenName: 'bottwo', role: '', aliases: [] }]))).not.toBe(rosterHash(a));
    expect(rosterHash(chain([{ screenName: 'botone', role: '', aliases: ['one'] }, { screenName: 'botthree', role: '', aliases: [] }]))).not.toBe(rosterHash(a));
  });
});

describe('buddies, reload and schema export', () => {
  it('lists owners, approved people and roster peers without self', () => {
    const p = readPolicy(cfgOf({ owners: ['alice'], allowFrom: ['bob'], chain: { roster: [{ screenName: 'botone' }, { screenName: 'bottwo' }] } }));
    expect(buddyList(p, 'botone')).toEqual(['alice', 'bob', 'bottwo']);
  });

  it('marks people keys as no-restart and transport keys as restart', () => {
    for (const path of ['channels.oscar.allowFrom', 'channels.oscar.owners', 'channels.oscar.contactNotice', 'channels.oscar.away', 'channels.oscar.chain.ackText', 'channels.oscar.room.historyFrom']) {
      expect(RELOAD_NOOP_PREFIXES).toContain(path);
    }
    for (const path of ['channels.oscar', 'channels.oscar.host', 'channels.oscar.password', 'channels.oscar.screenName', 'channels.oscar.room', 'channels.oscar.room.name', 'channels.oscar.chain', 'channels.oscar.chain.roster', 'channels.oscar.accounts']) {
      expect(RELOAD_NOOP_PREFIXES).not.toContain(path);
    }
  });

  it('exports a JSON Schema with the real properties', () => {
    const schema = oscarChannelConfigSchema.schema as { type?: string; properties?: Record<string, unknown> };
    expect(schema.type).toBe('object');
    for (const key of ['host', 'port', 'password', 'owners', 'allowFrom', 'accounts', 'chain', 'room']) {
      expect(schema.properties, key).toHaveProperty(key);
    }
    expect((oscarChannelConfigSchema.uiHints as Record<string, { sensitive?: boolean }>).password?.sensitive).toBe(true);
  });
});
