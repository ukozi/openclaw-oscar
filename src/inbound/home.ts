import type { RootPolicy } from '../config.js';
import { copy } from '../copy.js';
import { isAsciiName, normalizeName } from '../names.js';
import type { RoomRef } from '../names.js';
import { roleOf } from '../policy.js';
import { applyRoomClosed, applyRoomJoin, applyRoomLeave, applyRoomReady, roomKey, roomsExt } from '../runtime.js';
import type { AccountRuntime } from '../runtime.js';
import { clearAloneTimers, handleInvite, watchAlone } from './invite.js';
import { onRoomMessage, registerRooms, unregisterRooms } from './room.js';
import type { RoomDeps } from './room.js';

export const JOIN_MISSING_CODE = 'no-such-room';
const HOUR_MS = 3_600_000;
const NOTE_MEMORY_MAX = 500;

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function codeOf(err: unknown): unknown {
  return typeof err === 'object' && err !== null && 'code' in err ? (err as { code: unknown }).code : undefined;
}

function homeKey(policy: RootPolicy): string | null {
  return policy.room ? roomKey(policy.room.ref) : null;
}

function kickHome(rt: AccountRuntime, deps: RoomDeps): void {
  ensureHome(rt, deps).catch((err: unknown) => {
    deps.log.error('home room check failed', { error: errText(err) });
  });
}

export async function ensureHome(rt: AccountRuntime, deps: RoomDeps): Promise<void> {
  const ext = roomsExt(rt);
  const room = deps.policy().room;
  if (!room) {
    ext.home = { status: 'unset' };
    return;
  }
  if (ext.homeRegistered || ext.homeBusy) return;
  ext.homeBusy = true;
  ext.homeRegistered = true;
  ext.home = { status: 'pending' };
  try {
    await rt.session.joinRoom(room.ref, { persistent: true });
    ext.home = { status: ext.joined.has(roomKey(room.ref)) ? 'joined' : 'pending' };
  } catch (err) {
    const missing = codeOf(err) === JOIN_MISSING_CODE;
    ext.home = { status: missing ? 'missing' : 'failed', detail: errText(err) };
    deps.log.warn('home room join failed', { room: roomKey(room.ref), error: errText(err) });
  } finally {
    ext.homeBusy = false;
  }
}

function noteUnlistedJoin(rt: AccountRuntime, deps: RoomDeps, ref: RoomRef, name: string, display: string): void {
  const policy = deps.policy();
  if (!policy.room?.notifyOnUnlistedJoin || homeKey(policy) !== roomKey(ref)) return;
  if (roleOf(name, policy) !== 'unlisted') return;
  const notes = roomsExt(rt).joinNotes;
  const now = deps.now();
  const cooldown = policy.contactNotice.cooldownHours * HOUR_MS;
  const last = notes.last.get(name);
  if (last !== undefined && now - last < cooldown) return;
  notes.sentAt = notes.sentAt.filter((at) => now - at < HOUR_MS);
  if (notes.sentAt.length >= policy.contactNotice.maxPerHour) return;
  if (notes.last.size >= NOTE_MEMORY_MAX) {
    for (const [who, at] of notes.last) {
      if (now - at >= cooldown) notes.last.delete(who);
    }
  }
  notes.last.set(name, now);
  notes.sentAt.push(now);
  const odd = isAsciiName(display) ? '' : ` ${copy.noticeOddName()}`;
  deps.tellOwners(`${copy.unlistedJoin(display, ref.name)}${odd}`).catch((err: unknown) => {
    deps.log.warn('unlisted-join note failed', { room: roomKey(ref), error: errText(err) });
  });
}

export function attachRooms(rt: AccountRuntime, deps: RoomDeps): () => void {
  const ext = roomsExt(rt);
  const self = (): string => normalizeName(deps.self());
  registerRooms(rt, deps);

  const offs = [
    rt.session.on('state', (state) => {
      if (state.phase === 'online') kickHome(rt, deps);
    }),
    rt.session.on('roomReady', (ev) => {
      applyRoomReady(rt, ev.room, ev.occupants, self(), deps.now());
      if (homeKey(deps.policy()) === roomKey(ev.room)) ext.home = { status: 'joined' };
      watchAlone(rt, deps, ev.room);
    }),
    rt.session.on('roomJoin', (ev) => {
      const name = normalizeName(ev.name);
      applyRoomJoin(rt, ev.room, name, self(), deps.now());
      watchAlone(rt, deps, ev.room);
      if (name !== self()) noteUnlistedJoin(rt, deps, ev.room, name, ev.display);
    }),
    rt.session.on('roomLeave', (ev) => {
      applyRoomLeave(rt, ev.room, ev.name, self(), deps.now());
      watchAlone(rt, deps, ev.room);
    }),
    rt.session.on('roomClosed', (ev) => {
      applyRoomClosed(rt, ev.room, ev.willRejoin);
      watchAlone(rt, deps, ev.room);
      if (homeKey(deps.policy()) !== roomKey(ev.room)) return;
      if (ev.willRejoin) {
        ext.home = { status: 'pending' };
        return;
      }
      ext.homeRegistered = false;
      ext.home = { status: 'failed', detail: 'the room closed' };
      if (rt.session.getState().phase === 'online') kickHome(rt, deps);
    }),
    rt.session.on('roomMessage', (ev) => {
      onRoomMessage(rt, deps, ev);
    }),
    rt.session.on('invite', (ev) => {
      handleInvite(rt, deps, ev).catch((err: unknown) => {
        deps.log.error('invite handling failed', { from: ev.from, error: errText(err) });
      });
    }),
  ];

  if (rt.session.getState().phase === 'online') kickHome(rt, deps);
  else if (!deps.policy().room) ext.home = { status: 'unset' };

  return () => {
    for (const off of offs) off();
    clearAloneTimers(rt, deps.timers);
    unregisterRooms(rt.accountId);
  };
}
