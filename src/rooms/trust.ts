import type { RootPolicy } from '../config.js';
import { copy } from '../copy.js';
import type { RoomRef } from '../names.js';
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
