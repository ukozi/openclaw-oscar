import type { RootPolicy } from '../config.js';
import { escapeNonAscii, normalizeName } from '../names.js';
import { roleOf } from '../policy.js';
import { roomsExt } from '../runtime.js';
import type { AccountRuntime } from '../runtime.js';

export type RoomIssue = {
  kind: 'config' | 'runtime';
  severity: 'error' | 'warning' | 'info';
  message: string;
  fix: string;
};

export function roomIssues(rt: AccountRuntime | undefined, policy: RootPolicy, self: string): RoomIssue[] {
  if (!rt) return [];
  const issues: RoomIssue[] = [];
  const ext = roomsExt(rt);
  if (policy.room && ext.home.status === 'missing') {
    issues.push({
      kind: 'config',
      severity: 'error',
      message: `home room ${policy.room.ref.name} does not exist on exchange ${policy.room.ref.exchange}`,
      fix: 'ask the server operator to create the public room, or set channels.oscar.room.exchange to 4',
    });
  }
  if (policy.room && ext.home.status === 'failed') {
    issues.push({
      kind: 'runtime',
      severity: 'warning',
      message: `home room ${policy.room.ref.name} is not joined: ${ext.home.detail ?? 'unknown error'}`,
      fix: 'the join is retried automatically; check the server log',
    });
  }
  const me = normalizeName(self);
  for (const [key, state] of rt.rooms) {
    if (!ext.joined.has(key)) continue;
    const unlisted = [...state.occupants]
      .filter((name) => name !== me && roleOf(name, policy) === 'unlisted')
      .map((name) => escapeNonAscii(name))
      .sort();
    if (unlisted.length > 0) {
      issues.push({
        kind: 'runtime',
        severity: 'info',
        message: `unlisted occupants in ${key}: ${unlisted.join(', ')}`,
        fix: 'they can read the room; add them to channels.oscar.allowFrom or move to a new room name',
      });
    }
  }
  return issues;
}
