import { describe, expect, it } from 'vitest';
import { handoffToolPolicy, intersectToolPolicy, senderToolPolicy } from '../../../src/policy.js';
import { policyFixture } from './fixtures.js';

const DENY = ['group:runtime', 'group:fs', 'group:automation', 'group:nodes', 'sessions_spawn'];

describe('intersectToolPolicy', () => {
  it('no restriction on either side is no restriction', () => {
    expect(intersectToolPolicy(undefined, undefined)).toBeUndefined();
  });
  it('one side alone wins', () => {
    expect(intersectToolPolicy({ deny: ['exec'] }, undefined)).toEqual({ deny: ['exec'] });
    expect(intersectToolPolicy(undefined, { allow: ['read'] })).toEqual({ allow: ['read'] });
  });
  it('denies add up without duplicates', () => {
    expect(intersectToolPolicy({ deny: ['exec', 'read'] }, { deny: ['read', 'write'] })).toEqual({ deny: ['exec', 'read', 'write'] });
  });
  it('allow lists intersect', () => {
    expect(intersectToolPolicy({ allow: ['read', 'exec'] }, { allow: ['read', 'write'] })).toEqual({ allow: ['read'] });
  });
  it('an empty intersection denies everything the first side allowed', () => {
    expect(intersectToolPolicy({ allow: ['exec'] }, { allow: ['read'] })).toEqual({ allow: ['exec'], deny: ['exec'] });
  });
  it('alsoAllow survives only when both sides carry it', () => {
    expect(intersectToolPolicy({ alsoAllow: ['message', 'x'] }, { alsoAllow: ['message'] })).toEqual({ alsoAllow: ['message'] });
    expect(intersectToolPolicy({ alsoAllow: ['message'] }, { deny: ['exec'] })).toEqual({ deny: ['exec'] });
  });
});

describe('handoffToolPolicy', () => {
  const policy = policyFixture();

  it("an owner's hand-off keeps shell", () => {
    expect(handoffToolPolicy({ originator: 'alice', delegator: 'botone' }, policy, 'testroom')).toBeUndefined();
  });

  it("an approved person's hand-off does not", () => {
    expect(handoffToolPolicy({ originator: 'bob', delegator: 'botone' }, policy, 'testroom')?.deny).toEqual(DENY);
  });

  it('a direct wake uses the sender alone', () => {
    expect(handoffToolPolicy({ originator: 'bob' }, policy, 'testroom')).toEqual(senderToolPolicy('bob', policy, 'testroom'));
    expect(handoffToolPolicy({ originator: 'alice' }, policy, 'testroom')).toBeUndefined();
  });

  it('an operator entry for the delegating bot narrows an owner hand-off too', () => {
    const narrowed = policyFixture({ rooms: { testroom: { toolsBySender: { 'id:botone': { deny: ['exec'] } } } } });
    const viaBot = senderToolPolicy('botone', narrowed, 'testroom');
    expect(viaBot).toEqual({ deny: ['exec'] });
    expect(handoffToolPolicy({ originator: 'alice', delegator: 'botone' }, narrowed, 'testroom')).toEqual(viaBot);
  });
});
