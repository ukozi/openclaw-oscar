import type { RootPolicy } from '../config.js';
import { normalizeName, type RoomRef } from '../names.js';
import { applyRoomClosed, roomKey, type AccountRuntime } from '../runtime.js';

export type LeaveResult = 'left' | 'home' | 'not-in';

type Forgetter = { forget(roomKey: string): void };

const setups = new Map<string, Forgetter>();

export function attachRoomSetup(accountId: string, setup: Forgetter | null): void {
  if (setup) setups.set(accountId, setup);
  else setups.delete(accountId);
}

export async function leaveRoomNow(rt: AccountRuntime, ref: RoomRef, policy: RootPolicy): Promise<LeaveResult> {
  const key = roomKey(ref);
  if (policy.room && roomKey(policy.room.ref) === key) return 'home';
  if (!rt.rooms.has(key)) return 'not-in';
  await rt.session.leaveRoom(ref);
  applyRoomClosed(rt, ref, false);
  rt.chain?.resetRoom(key);
  setups.get(rt.accountId)?.forget(key);
  return 'left';
}

export function parseLeaveLine(text: string): { all: true } | { names: string[] } | null {
  const [cmd, ...rest] = text.trim().split(/\s+/);
  if (cmd?.toLowerCase() !== '/leave') return null;
  if (rest.length === 0) return { all: true };
  return { names: [...new Set(rest.map(normalizeName))] };
}
