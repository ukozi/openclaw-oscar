import type { RootPolicy } from './config.js';
import { formatTarget, senderLabel } from './names.js';
import type { PeerRef } from './names.js';
import type { OriginClass } from './policy.js';
import { roomKey, roomsExt } from './runtime.js';
import type { AccountRuntime, RoomLine } from './runtime.js';

const LINE_MAX = 300;
const ROOM_PREFIX = 'room:';

export type UntrustedEntry = { label: string; source?: string; type?: string; payload: unknown };
export type ContactAttemptView = { name: string; kind: 'im' | 'invite'; at: number };
export type AwarenessSource = (accountId: string) => string[];

export type AwarenessInput = {
  now: number;
  lines: number;
  current: string;
  rooms: { target: string; occupants: number; lastActivityAt: number | undefined; lines: RoomLine[] }[];
  directMessages: { target: string; lastActivityAt: number }[];
  openHandoffs: string[];
  contactAttempts: ContactAttemptView[];
};

export type AwarenessPayload = {
  asOf: number;
  rooms: {
    target: string;
    occupants: number;
    lastActivityAt: number | null;
    lines: { from: string; text: string; at: number }[];
  }[];
  directMessages: { target: string; lastActivityAt: number }[];
  openHandoffs: string[];
  contactAttempts: ContactAttemptView[];
};

const sources: AwarenessSource[] = [];

export function registerAwarenessSource(fn: AwarenessSource): () => void {
  sources.push(fn);
  return () => {
    const at = sources.indexOf(fn);
    if (at >= 0) sources.splice(at, 1);
  };
}

export function buildAwareness(input: AwarenessInput): UntrustedEntry | null {
  if (input.lines <= 0) return null;
  const rooms = input.rooms
    .filter((room) => room.target !== input.current)
    .map((room) => ({
      target: room.target,
      occupants: room.occupants,
      lastActivityAt: room.lastActivityAt ?? null,
      lines: room.lines
        .filter((line) => line.role !== 'unlisted')
        .slice(-input.lines)
        .map((line) => ({ from: senderLabel(line.from, line.role), text: line.text.slice(0, LINE_MAX), at: line.at })),
    }));
  const directMessages = input.directMessages.filter((dm) => dm.target !== input.current);
  const empty =
    rooms.length === 0 &&
    directMessages.length === 0 &&
    input.openHandoffs.length === 0 &&
    input.contactAttempts.length === 0;
  if (empty) return null;
  const payload: AwarenessPayload = {
    asOf: input.now,
    rooms,
    directMessages,
    openHandoffs: input.openHandoffs,
    contactAttempts: input.contactAttempts,
  };
  return { label: 'Other conversations on this account', source: 'oscar', type: 'awareness', payload };
}

export function awarenessFor(
  rt: AccountRuntime,
  policy: RootPolicy,
  current: PeerRef,
  origin: OriginClass,
  now: number,
  contacts: ContactAttemptView[],
): UntrustedEntry[] {
  if (origin !== 'owner') return [];
  const ext = roomsExt(rt);
  const entry = buildAwareness({
    now,
    lines: policy.awareness.lines,
    current: current.kind === 'room' ? roomKey(current.room) : formatTarget({ kind: 'im', name: current.peer }),
    rooms: [...rt.rooms.entries()]
      .filter(([key]) => ext.joined.has(key))
      .map(([key, state]) => ({
        target: key,
        occupants: state.occupants.size,
        lastActivityAt: ext.activity.get(key),
        lines: ext.recentLines.get(key) ?? [],
      })),
    directMessages: [...ext.activity.entries()]
      .filter(([target]) => !target.startsWith(ROOM_PREFIX))
      .map(([target, lastActivityAt]) => ({ target, lastActivityAt })),
    openHandoffs: sources.flatMap((fn) => fn(rt.accountId)),
    contactAttempts: contacts,
  });
  return entry ? [entry] : [];
}
