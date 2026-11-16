import type { RoomTrust, RootPolicy } from '../config.js';
import { copy } from '../copy.js';
import { isAsciiName, normalizeName, type RoomRef } from '../names.js';
import { roleOf } from '../policy.js';
import { roomKey } from '../runtime.js';
import { effectiveProfile, profileStore } from './profiles.js';

export function onUnlistedJoin(
  accountId: string,
  policy: RootPolicy,
  ref: RoomRef,
  name: string,
  display: string,
  tell: (text: string) => void,
): boolean {
  if (roleOf(name, policy) !== 'unlisted') return false;
  const eff = effectiveProfile(accountId, policy, ref);
  if (eff.source === 'pending' || eff.profile.trust !== 'private') return false;
  const store = profileStore(accountId);
  if (!store) return false;
  const key = roomKey(ref);
  if (eff.source === 'config') store.setTrustOverride(key, 'public');
  else store.setProfile(key, { ...eff.profile, trust: 'public' });
  tell(copy.trustDowngraded(display, ref.name));
  return true;
}

const HOUR_MS = 3_600_000;
const TOLD_MAX = 500;
const told = new Map<string, { last: Map<string, number>; sentAt: number[] }>();

export function unlistedPresent(occupants: Iterable<string>, self: string, policy: RootPolicy): string[] {
  const me = normalizeName(self);
  return [...occupants].filter((name) => normalizeName(name) !== me && roleOf(name, policy) === 'unlisted');
}

export function trustNow(accountId: string, policy: RootPolicy, ref: RoomRef, occupants: Iterable<string>, self: string): RoomTrust | undefined {
  const eff = effectiveProfile(accountId, policy, ref);
  if (eff.source === 'pending') return undefined;
  return unlistedPresent(occupants, self, policy).length > 0 ? 'public' : eff.profile.trust;
}

export function noteUnlistedPresent(p: {
  accountId: string;
  policy: RootPolicy;
  ref: RoomRef;
  occupants: Iterable<string>;
  self: string;
  now: number;
  tell: (text: string) => void;
}): void {
  const eff = effectiveProfile(p.accountId, p.policy, p.ref);
  if (eff.source === 'pending' || eff.profile.trust !== 'private') return;
  const cooldown = p.policy.contactNotice.cooldownHours * HOUR_MS;
  const room = roomKey(p.ref);
  const state = told.get(p.accountId) ?? { last: new Map<string, number>(), sentAt: [] };
  told.set(p.accountId, state);
  const seen = state.last;
  state.sentAt = state.sentAt.filter((at) => p.now - at < HOUR_MS);
  for (const name of unlistedPresent(p.occupants, p.self, p.policy)) {
    if (state.sentAt.length >= p.policy.contactNotice.maxPerHour) return;
    const key = `${room}|${normalizeName(name)}`;
    const last = seen.get(key);
    if (last !== undefined && p.now - last < cooldown) continue;
    seen.delete(key);
    if (seen.size >= TOLD_MAX) {
      for (const [k, at] of seen) if (p.now - at >= cooldown) seen.delete(k);
      if (seen.size >= TOLD_MAX) seen.delete(seen.keys().next().value!);
    }
    seen.set(key, p.now);
    state.sentAt.push(p.now);
    const odd = isAsciiName(name) ? '' : ` ${copy.noticeOddName()}`;
    p.tell(`${copy.trustExposed(name, p.ref.name)}${odd}`);
  }
}

export function forgetUnlistedPresent(accountId: string): void {
  told.delete(accountId);
}

export function toldCountForTests(accountId: string): number {
  return told.get(accountId)?.last.size ?? 0;
}
