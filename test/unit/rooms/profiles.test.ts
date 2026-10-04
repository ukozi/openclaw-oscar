import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  attachProfileStore,
  effectiveProfile,
  ProfileStore,
  profileStore,
  storeFileFor,
  trustPrompt,
} from '../../../src/rooms/profiles.js';
import { KEY, policyFixture, ROOM } from '../rooms-fixtures.js';

const OTHER = { exchange: 4 as const, name: 'lounge' };
const OTHER_KEY = 'room:4:lounge';
let seq = 0;

function logger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function fresh(prefix: string): string {
  seq += 1;
  return `${prefix}${seq}`;
}

function open(accountId: string, log = logger()) {
  return new ProfileStore({ file: storeFileFor(accountId), log, now: () => 1000 });
}

function writeRaw(accountId: string, body: string): void {
  const file = storeFileFor(accountId);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
}

afterEach(() => {
  attachProfileStore('eff', null);
});

describe('ProfileStore', () => {
  it('keeps the file under the state dir', () => {
    expect(storeFileFor('botone')).toBe(join(process.env.OPENCLAW_STATE_DIR ?? '', 'oscar', 'rooms-botone.json'));
  });

  it('round-trips profiles and overrides across instances', async () => {
    const id = fresh('rt');
    const a = open(id);
    a.setProfile(OTHER_KEY, { mode: 'lounge', trust: 'private', rank: ['botone', 'bottwo'] });
    a.setTrustOverride(KEY, 'public');
    await a.flush();
    const b = open(id);
    expect(b.get(OTHER_KEY)).toEqual({ profile: { mode: 'lounge', trust: 'private', rank: ['botone', 'bottwo'] }, updatedAt: 1000 });
    expect(b.get(KEY)).toEqual({ trustOverride: 'public', updatedAt: 1000 });
  });

  it('starts empty and quiet when there is no file', () => {
    const log = logger();
    const store = open(fresh('missing'), log);
    expect(store.get(KEY)).toBeUndefined();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it.each([
    ['truncated JSON', '{"version":1,"rooms":{"room:4:test'],
    ['an older shape', '{"version":2,"rooms":{"room:4:testroom":{"updatedAt":1}}}'],
  ])('starts empty and warns once on %s', (_label, body) => {
    const id = fresh('bad');
    writeRaw(id, body);
    const log = logger();
    const store = open(id, log);
    expect(store.get(KEY)).toBeUndefined();
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('clears a trust override when a profile is set', () => {
    const store = open(fresh('clear'));
    store.setTrustOverride(KEY, 'public');
    store.setProfile(KEY, { mode: 'watch' });
    expect(store.get(KEY)).toEqual({ profile: { mode: 'watch' }, updatedAt: 1000 });
  });

  it('removes an override set back to null', () => {
    const store = open(fresh('null'));
    store.setTrustOverride(KEY, 'public');
    store.setTrustOverride(KEY, null);
    expect(store.get(KEY)).toBeUndefined();
  });
});

describe('effectiveProfile', () => {
  const policy = policyFixture({
    room: { ref: ROOM, historyFrom: 'listed', notifyOnUnlistedJoin: true, profile: { mode: 'team', trust: 'private' } },
    rooms: { configured: { profile: { mode: 'watch', trust: 'private' } } },
  });

  function withStore(): ProfileStore {
    const store = open(fresh('eff'));
    attachProfileStore('eff', store);
    return store;
  }

  it('uses the config for the home room and rooms entries', () => {
    withStore();
    expect(effectiveProfile('eff', policy, ROOM)).toEqual({ source: 'config', profile: { mode: 'team', trust: 'private' } });
    expect(effectiveProfile('eff', policy, { exchange: 4, name: 'Configured' })).toEqual({
      source: 'config',
      profile: { mode: 'watch', trust: 'private' },
    });
  });

  it('applies a stored trust override on top of the config', () => {
    withStore().setTrustOverride(KEY, 'public');
    expect(effectiveProfile('eff', policy, ROOM)).toEqual({ source: 'config', profile: { mode: 'team', trust: 'public' } });
  });

  it('prefers the config over a stored profile for a configured room', () => {
    withStore().setProfile(KEY, { mode: 'lounge' });
    expect(effectiveProfile('eff', policy, ROOM)).toMatchObject({ source: 'config', profile: { mode: 'team' } });
  });

  it('returns the stored profile for an unconfigured room', () => {
    withStore().setProfile(OTHER_KEY, { mode: 'lounge', trust: 'public' });
    expect(effectiveProfile('eff', policy, OTHER)).toEqual({ source: 'stored', profile: { mode: 'lounge', trust: 'public' } });
  });

  it('is pending with nothing stored, or with no store attached', () => {
    withStore();
    expect(effectiveProfile('eff', policy, OTHER)).toEqual({ source: 'pending' });
    attachProfileStore('eff', null);
    expect(profileStore('eff')).toBeUndefined();
    expect(effectiveProfile('eff', policy, OTHER)).toEqual({ source: 'pending' });
  });

  it('treats the home name on another exchange as unconfigured', () => {
    withStore();
    expect(effectiveProfile('eff', policyFixture({ rooms: {} }), { exchange: 5, name: 'testroom' })).toEqual({ source: 'pending' });
  });
});

describe('trustPrompt', () => {
  it('gives the spec lines and nothing without trust', () => {
    expect(trustPrompt('private')).toBe(
      'This room is private: only your owner and your teammates are here. You may talk about personal details your owner has shared with you.',
    );
    expect(trustPrompt('public')).toBe(
      'This room is public: anyone on the server can read it. Do not share personal details about your owner, such as where they live, family, money, health or contacts. Offer to continue by IM instead.',
    );
    expect(trustPrompt(undefined)).toBe('');
  });
});
