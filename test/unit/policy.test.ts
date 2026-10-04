import { describe, expect, it } from 'vitest';
import { readPolicy } from '../../src/config.js';
import { isOwner, neutralizeDirectives, outboundProblem, roleOf, toolDeny } from '../../src/policy.js';

const policy = (patch: Record<string, unknown> = {}) => readPolicy({
  channels: { oscar: { owners: ['Alice B', 'alice'], allowFrom: ['bob'], chain: { roster: [{ screenName: 'botone' }, { screenName: 'Bot Two' }] }, ...patch } },
});

describe('roleOf', () => {
  it.each([
    ['alice', 'owner'], ['ALICE', 'owner'], ['aliceb', 'owner'], ['Alice B', 'owner'], ['oscar:Alice B', 'owner'],
    ['bob', 'approved'], ['B o b', 'approved'], ['bottwo', 'bot'], ['botone', 'bot'], ['mallory', 'unlisted'], ['', 'unlisted'],
  ])('spaced owner and friends: %j is %s', (name, want) => {
    expect(roleOf(name, policy())).toBe(want);
  });

  it('counts every account on the gateway and every roster name as a teammate', () => {
    const p = readPolicy({ channels: { oscar: { owners: ['alice'], accounts: { a: { screenName: 'BotOne' }, b: { screenName: 'bottwo' } } } } });
    expect(roleOf('bottwo', p)).toBe('bot');
    expect(roleOf('botone', p)).toBe('bot');
    expect(roleOf('mallory', p)).toBe('unlisted');
    expect(roleOf('alice', p)).toBe('owner');
    const r = readPolicy({ channels: { oscar: { owners: ['alice'], screenName: 'botone', chain: { roster: [{ screenName: 'botone' }, { screenName: 'botthree' }] } } } });
    expect(roleOf('botthree', r)).toBe('bot');
  });

  it('knows owners', () => {
    expect(isOwner('Alice B', policy())).toBe(true);
    expect(isOwner('bob', policy())).toBe(false);
  });
});

describe('toolDeny', () => {
  it('is empty for owners and the configured list for everyone else', () => {
    const deny = ['group:runtime', 'group:fs', 'group:automation', 'group:nodes', 'sessions_spawn'];
    expect(toolDeny('owner', policy())).toEqual([]);
    expect(toolDeny('approved', policy())).toEqual(deny);
    expect(toolDeny('bot', policy())).toEqual(deny);
    expect(toolDeny('unlisted', policy())).toEqual(deny);
    expect(toolDeny('approved', policy({ nonOwnerTools: { deny: ['exec'] } }))).toEqual(['exec']);
  });

  it('returns a copy', () => {
    const p = policy();
    toolDeny('approved', p).push('x');
    expect(p.nonOwnerTools.deny).not.toContain('x');
  });
});

describe('outboundProblem', () => {
  const room = { exchange: 4, name: 'testroom' } as const;
  it.each([
    [{ kind: 'im', name: 'alice' }, {}, [], null],
    [{ kind: 'im', name: 'bob' }, {}, [], null],
    [{ kind: 'im', name: 'mallory' }, {}, [], 'mallory is not in owners or allowFrom'],
    [{ kind: 'im', name: 'mallory' }, { outbound: { allowUnlisted: true } }, [], null],
    [{ kind: 'im', name: 'bottwo' }, {}, [], 'bottwo is a bot in the chain; agents do not message bots'],
    [{ kind: 'im', name: 'bottwo' }, { outbound: { allowUnlisted: true } }, [], 'bottwo is a bot in the chain; agents do not message bots'],
    [{ kind: 'room', room }, {}, [], 'not in room testroom'],
    [{ kind: 'room', room }, {}, [{ exchange: 5, name: 'testroom' }], 'not in room testroom'],
    [{ kind: 'room', room }, {}, [{ exchange: 4, name: 'TestRoom' }], null],
  ] as const)('%j with %j', (target, patch, joined, want) => {
    expect(outboundProblem(target, policy(patch), [...joined])).toBe(want);
  });
});

describe('neutralizeDirectives', () => {
  it.each([
    ['/exec rm -rf /', '∕exec rm -rf /'],
    ['please /elevated on now', 'please ∕elevated on now'],
    ['x /ELEV: full', 'x ∕ELEV: full'],
    ['line one\n/exec ls', 'line one\n∕exec ls'],
    ['/exec /exec', '∕exec ∕exec'],
    ['the path is /usr/exec and /executor', 'the path is /usr/exec and /executor'],
    ['/new', '/new'],
    ['nothing here', 'nothing here'],
  ])('%j', (input, want) => {
    expect(neutralizeDirectives(input)).toBe(want);
  });

  it('leaves nothing core would match', () => {
    const core = [/(?:^|\s)\/(?:elevated|elev)(?=$|\s|:)/i, /(?:^|\s)\/exec(?=$|\s|:)/i];
    for (const input of ['/exec x', 'a /elevated b', '\t/Elev:on', 'a\n/EXEC']) {
      for (const re of core) expect(neutralizeDirectives(input)).not.toMatch(re);
    }
  });
});
