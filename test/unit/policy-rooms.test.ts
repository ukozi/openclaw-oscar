import { describe, expect, it } from 'vitest';
import { senderToolPolicy, toolsBySenderEntry } from '../../src/policy.js';
import { policyFixture } from './rooms-fixtures.js';

const DENY = ['group:runtime', 'group:fs', 'group:automation', 'group:nodes', 'sessions_spawn'];

describe('toolsBySenderEntry', () => {
  const map = {
    '*': { deny: ['wild'] },
    'name:bob': { deny: ['by-name'] },
    'username:@Bob': { deny: ['by-username'] },
    bob: { deny: ['legacy'] },
    'channel:discord:bob': { deny: ['other-channel'] },
    'e164:+15550100': { deny: ['phone'] },
  };

  it.each([
    ['channel key wins', { ...map, 'id:bob': { deny: ['by-id'] }, 'channel:oscar:Bob': { deny: ['by-channel'] } }, 'bob', ['by-channel']],
    ['typed id and legacy key share a rank, first wins', { ...map, 'id:bob': { deny: ['by-id'] } }, 'bob', ['legacy']],
    ['legacy bare key', map, 'bob', ['legacy']],
    ['username beats name', { '*': map['*'], 'name:bob': map['name:bob'], 'username:@Bob': map['username:@Bob'] }, 'bob', ['by-username']],
    ['name key', { '*': map['*'], 'name:bob': map['name:bob'] }, 'bob', ['by-name']],
    ['wildcard', map, 'alice', ['wild']],
    ['spaces and case are normalised on both sides', { 'id:Bob Smith': { deny: ['spaced'] } }, 'BobSmith', ['spaced']],
  ])('%s', (_name, input, sender, deny) => {
    expect(toolsBySenderEntry(input, sender)?.deny).toEqual(deny);
  });

  it('ignores other channels, phone keys and malformed entries', () => {
    expect(toolsBySenderEntry({ 'channel:discord:bob': { deny: ['x'] }, 'e164:+1': { deny: ['y'] }, 'id:bob': 'nope' }, 'bob')).toBeUndefined();
    expect(toolsBySenderEntry(undefined, 'bob')).toBeUndefined();
    expect(toolsBySenderEntry({}, 'bob')).toBeUndefined();
  });

  it('keeps only string arrays', () => {
    expect(toolsBySenderEntry({ 'id:bob': { allow: ['read', 7], alsoAllow: 'x', deny: [] } }, 'bob')).toEqual({ allow: ['read'], deny: [] });
  });
});

describe('senderToolPolicy', () => {
  const rooms = { testroom: { toolsBySender: { 'id:bob': { allow: ['read'], deny: ['web_fetch'] }, 'id:alice': { deny: ['exec'] } } } };

  it('gives an approved person the built-in deny', () => {
    expect(senderToolPolicy('bob', policyFixture(), 'testroom')).toEqual({ deny: DENY });
    expect(senderToolPolicy('Bob', policyFixture(), null)).toEqual({ deny: DENY });
  });

  it('merges the operator entry and keeps the built-in deny', () => {
    expect(senderToolPolicy('bob', policyFixture({ rooms }), 'TestRoom')).toEqual({ allow: ['read'], deny: [...DENY, 'web_fetch'] });
  });

  it('an operator entry cannot remove the built-in deny', () => {
    const open = { testroom: { toolsBySender: { 'id:bob': { alsoAllow: ['exec'], deny: [] } } } };
    expect(senderToolPolicy('bob', policyFixture({ rooms: open }), 'testroom')).toEqual({ alsoAllow: ['exec'], deny: DENY });
  });

  it('does not look at room entries for an IM session', () => {
    expect(senderToolPolicy('bob', policyFixture({ rooms }), null)).toEqual({ deny: DENY });
  });

  it('gives an owner the operator entry or nothing', () => {
    expect(senderToolPolicy('alice', policyFixture(), 'testroom')).toBeUndefined();
    expect(senderToolPolicy('alice', policyFixture({ rooms }), 'testroom')).toEqual({ deny: ['exec'] });
  });

  it('gives an unlisted sender the built-in deny and a roster bot the operator entry', () => {
    const roster = [
      { screenName: 'botone', role: 'lead', aliases: [] },
      { screenName: 'bottwo', role: 'writing', aliases: [] },
    ];
    const policy = policyFixture({ chain: { ...policyFixture().chain, roster } });
    expect(senderToolPolicy('mallory', policy, 'testroom')).toEqual({ deny: DENY });
    expect(senderToolPolicy('bottwo', policy, 'testroom')).toBeUndefined();
  });

  it('honours a changed nonOwnerTools.deny and returns nothing when there is nothing to say', () => {
    expect(senderToolPolicy('bob', policyFixture({ nonOwnerTools: { deny: ['exec'] } }), 'testroom')).toEqual({ deny: ['exec'] });
    expect(senderToolPolicy('bob', policyFixture({ nonOwnerTools: { deny: [] } }), 'testroom')).toBeUndefined();
  });

  it('does not repeat a deny the operator also listed and drops empty lists', () => {
    const dup = { testroom: { toolsBySender: { 'id:bob': { allow: [], deny: ['group:fs', 'browser'] } } } };
    expect(senderToolPolicy('bob', policyFixture({ rooms: dup }), 'testroom')).toEqual({ deny: [...DENY, 'browser'] });
  });
});
