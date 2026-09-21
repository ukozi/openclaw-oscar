import type { RootPolicy } from '../config.js';
import { copy } from '../copy.js';
import { normalizeName } from '../names.js';
import type { RoomRef } from '../names.js';
import type { InviteEvent, Logger } from '../oscar/index.js';
import { toWireHtml } from '../oscar/text.js';
import { roleOf } from '../policy.js';
import { roomKey, roomsExt } from '../runtime.js';
import type { AccountRuntime } from '../runtime.js';

export type JoinDeps = { policy: () => RootPolicy; now: () => number; log: Logger };
export type AloneDeps = JoinDeps & { timers: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout } };
export type InviteDeps = JoinDeps & { noticeStranger: (name: string, display: string) => void };
export type JoinOutcome = 'joined' | 'already' | 'full' | 'failed';
export type InviteOutcome = JoinOutcome | 'stranger' | 'ignored';

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function joinExtraRoom(
  rt: AccountRuntime,
  deps: JoinDeps,
  ref: RoomRef,
  by: string | undefined,
  join: () => Promise<void>,
): Promise<JoinOutcome> {
  const key = roomKey(ref);
  const ext = roomsExt(rt);
  const policy = deps.policy();
  const home = policy.room ? roomKey(policy.room.ref) : null;
  // One chat session per screen name per room: a second join would evict the first.
  if (key === home || ext.joined.has(key) || ext.joining.has(key) || rt.rooms.has(key)) return 'already';
  const extra = new Set([...rt.rooms.keys(), ...ext.joining]);
  if (home !== null) extra.delete(home);
  if (extra.size >= policy.invites.maxRooms) return 'full';
  ext.joining.add(key);
  if (by !== undefined) ext.invitedBy.set(key, by);
  try {
    await join();
    return 'joined';
  } catch (err) {
    ext.invitedBy.delete(key);
    deps.log.warn('room join failed', { room: key, error: errText(err) });
    return 'failed';
  } finally {
    ext.joining.delete(key);
  }
}

export async function handleInvite(rt: AccountRuntime, deps: InviteDeps, ev: InviteEvent): Promise<InviteOutcome> {
  const policy = deps.policy();
  const from = normalizeName(ev.from);
  const role = roleOf(from, policy);
  if (role === 'bot') return 'ignored';
  if (role === 'unlisted') {
    deps.noticeStranger(from, ev.fromDisplay);
    return 'stranger';
  }
  const accept = policy.invites.accept;
  if (accept === 'off' || (accept === 'owners' && role !== 'owner')) {
    deps.log.debug('invite not accepted by policy', { from, accept });
    return 'ignored';
  }
  const outcome = await joinExtraRoom(rt, deps, ev.room, from, () => rt.session.joinInvited(ev));
  if (outcome === 'full') {
    await rt.session.sendIm(from, toWireHtml(copy.inviteFull()), { priority: 'notice' }).catch((err: unknown) => {
      deps.log.warn('invite decline failed', { to: from, error: errText(err) });
    });
  }
  return outcome;
}

export function watchAlone(rt: AccountRuntime, deps: AloneDeps, ref: RoomRef): void {
  const key = roomKey(ref);
  const ext = roomsExt(rt);
  const state = rt.rooms.get(key);
  const policy = deps.policy();
  const home = policy.room ? roomKey(policy.room.ref) : null;
  const minutes = policy.invites.leaveWhenAloneMinutes;
  const armed = ext.aloneTimers.get(key);
  if (!state || !ext.joined.has(key) || state.aloneSince === undefined || key === home || minutes <= 0) {
    if (armed !== undefined) {
      deps.timers.clearTimeout(armed);
      ext.aloneTimers.delete(key);
    }
    return;
  }
  if (armed !== undefined) return;
  const wait = Math.max(state.aloneSince + minutes * 60_000 - deps.now(), 0);
  const handle = deps.timers.setTimeout(() => {
    ext.aloneTimers.delete(key);
    const current = rt.rooms.get(key);
    const limit = deps.policy().invites.leaveWhenAloneMinutes;
    if (!current || current.aloneSince === undefined || limit <= 0) return;
    if (deps.now() - current.aloneSince < limit * 60_000) {
      watchAlone(rt, deps, ref);
      return;
    }
    deps.log.info('leaving a room after being alone', { room: key, minutes: limit });
    rt.session.leaveRoom(ref).catch((err: unknown) => {
      deps.log.warn('room leave failed', { room: key, error: errText(err) });
    });
  }, wait);
  ext.aloneTimers.set(key, handle);
}

export function clearAloneTimers(rt: AccountRuntime, timers: AloneDeps['timers']): void {
  const ext = roomsExt(rt);
  for (const handle of ext.aloneTimers.values()) timers.clearTimeout(handle);
  ext.aloneTimers.clear();
}
