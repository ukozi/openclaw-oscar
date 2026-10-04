import { afterEach, describe, expect, it } from 'vitest';
import type { RootPolicy } from '../../../src/config.js';
import { copy } from '../../../src/copy.js';
import type { RoomRef } from '../../../src/names.js';
import type { ImEvent } from '../../../src/oscar/index.js';
import { attachProfileStore, effectiveProfile, ProfileStore, storeFileFor } from '../../../src/rooms/profiles.js';
import { RoomSetup } from '../../../src/rooms/setup.js';
import { onUnlistedJoin } from '../../../src/rooms/trust.js';
import type { RoomState } from '../../../src/runtime.js';
import { KEY, policyFixture, ROOM } from '../rooms-fixtures.js';

const DEN: RoomRef = { exchange: 4, name: 'den' };
const DEN_KEY = 'room:4:den';
const silent = { debug() {}, info() {}, warn() {}, error() {} };
let seq = 0;

function harness(over: Partial<RootPolicy> = {}) {
  seq += 1;
  const accountId = `trust${seq}`;
  const store = new ProfileStore({ file: storeFileFor(accountId), log: silent, now: () => 7 });
  attachProfileStore(accountId, store);
  const policy = policyFixture({ owners: ['alice', 'bob'], teammates: ['botone', 'bottwo'], ...over });
  const notes: string[] = [];
  const join = (ref: RoomRef, name: string, display = name): boolean =>
    onUnlistedJoin(accountId, policy, ref, name, display, (text) => notes.push(text));
  return { accountId, store, policy, notes, join };
}

function privateHome(): Partial<RootPolicy> {
  return { room: { ref: ROOM, historyFrom: 'listed', notifyOnUnlistedJoin: true, profile: { mode: 'team', trust: 'private' } } };
}

afterEach(() => {
  for (let i = 1; i <= seq; i++) attachProfileStore(`trust${i}`, null);
});

describe('trust downgrade', () => {
  it('makes a private stored room public when an unlisted name joins, and says so once', () => {
    const h = harness();
    h.store.setProfile(DEN_KEY, { mode: 'lounge', trust: 'private', rank: ['botone'] });
    expect(h.join(DEN, 'mallory', 'Mallory')).toBe(true);
    expect(h.store.get(DEN_KEY)?.profile).toEqual({ mode: 'lounge', trust: 'public', rank: ['botone'] });
    expect(h.notes).toEqual([copy.trustDowngraded('Mallory', 'den')]);
    expect(h.notes[0]).toBe("Mallory joined den, who isn't on my lists. I'm treating den as public now. Reply 'den private' to change it back.");
    expect(h.join(DEN, 'mallory', 'Mallory')).toBe(false);
    expect(h.notes).toHaveLength(1);
  });

  it('does nothing in a public room, a pending room, or for a listed name', () => {
    const h = harness();
    h.store.setProfile(DEN_KEY, { mode: 'team', trust: 'public' });
    expect(h.join(DEN, 'mallory')).toBe(false);
    expect(h.join({ exchange: 4, name: 'attic' }, 'mallory')).toBe(false);
    h.store.setProfile(DEN_KEY, { mode: 'team', trust: 'private' });
    expect(h.join(DEN, 'bob')).toBe(false);
    expect(h.join(DEN, 'bottwo')).toBe(false);
    expect(h.store.get(DEN_KEY)?.profile?.trust).toBe('private');
    expect(h.notes).toEqual([]);
  });

  it('sets an override on a configured private room', () => {
    const h = harness(privateHome());
    expect(h.join(ROOM, 'mallory')).toBe(true);
    expect(h.store.get(KEY)?.trustOverride).toBe('public');
    const eff = effectiveProfile(h.accountId, h.policy, ROOM);
    expect(eff.source === 'config' && eff.profile.trust).toBe('public');
  });

  it('leaves a configured room without trust alone', () => {
    const h = harness();
    expect(h.join(ROOM, 'mallory')).toBe(false);
    expect(h.store.get(KEY)).toBeUndefined();
  });
});

describe('restoring trust', () => {
  function setupFor(h: ReturnType<typeof harness>) {
    const rooms = new Map<string, RoomState>(
      [ROOM, DEN].map((ref) => [`room:4:${ref.name}`, { ref, occupants: new Set(), joinSeenAt: new Map(), selfJoinedAt: 0, omittedCount: 0 }]),
    );
    const asks: { owner: string; text: string }[] = [];
    const setup = new RoomSetup({
      accountId: h.accountId,
      self: () => 'botone',
      policy: () => h.policy,
      now: () => 7,
      log: silent,
      rooms: () => rooms,
      invitedBy: () => undefined,
      ask: async (owner, text) => {
        asks.push({ owner, text });
      },
      record: () => {},
      replay: () => {},
      leave: async () => 'left',
    });
    const im = (text: string) => setup.onIm({ from: 'alice', fromDisplay: 'alice', text, cookie: 1n } as ImEvent);
    return { asks, im };
  }

  it("clears the override on a configured room when the owner replies '<room> private'", () => {
    const h = harness(privateHome());
    h.join(ROOM, 'mallory');
    const s = setupFor(h);
    expect(s.im('testroom private')).toBe('handled');
    expect(h.store.get(KEY)).toBeUndefined();
    const eff = effectiveProfile(h.accountId, h.policy, ROOM);
    expect(eff.source === 'config' && eff.profile.trust).toBe('private');
    expect(s.asks).toEqual([{ owner: 'alice', text: copy.setupApplied('testroom', 'team, private') }]);
  });

  it('still refuses a mode change on a configured room', () => {
    const h = harness(privateHome());
    const s = setupFor(h);
    s.im('testroom lounge public');
    expect(s.asks).toEqual([{ owner: 'alice', text: copy.setupConfigRoom('testroom') }]);
    expect(h.store.get(KEY)).toBeUndefined();
  });

  it('sets trust back on a stored room', () => {
    const h = harness();
    h.store.setProfile(DEN_KEY, { mode: 'team', trust: 'private' });
    h.join(DEN, 'mallory');
    const s = setupFor(h);
    s.im('den private');
    expect(h.store.get(DEN_KEY)?.profile).toEqual({ mode: 'team', trust: 'private' });
  });
});
