import type { ChainConfig, RootPolicy } from '../../../src/config.js';
import type { RoomRef } from '../../../src/names.js';
import type { RoomState } from '../../../src/runtime.js';

export const ROOM: RoomRef = { exchange: 4, name: 'testroom' };

export function chainConfig(over: Partial<ChainConfig> = {}): ChainConfig {
  return {
    roster: [
      { screenName: 'botone', role: 'lead, planning, anything unassigned', aliases: [] },
      { screenName: 'bottwo', role: 'writing and editing', aliases: ['writer'] },
      { screenName: 'botthree', role: 'code and shell work', aliases: [] },
    ],
    floorSeconds: 120,
    takeoverMs: 10000,
    ackAfterMs: 8000,
    ackText: 'on it',
    busyText: 'busy, will pick this up next',
    maxHops: 2,
    resultTimeoutMinutes: 20,
    reviewResults: false,
    ...over,
  };
}

export function policyFixture(over: Partial<RootPolicy> = {}): RootPolicy {
  return {
    owners: ['alice'],
    allowFrom: ['alice', 'bob'],
    dmPolicy: 'allowlist',
    contactNotice: { cooldownHours: 6, maxPerHour: 5 },
    nonOwnerTools: { deny: ['group:runtime', 'group:fs', 'group:automation', 'group:nodes', 'sessions_spawn'] },
    outbound: { allowUnlisted: false },
    room: { ref: ROOM, historyFrom: 'listed', notifyOnUnlistedJoin: true },
    invites: { accept: 'approved', maxRooms: 5, leaveWhenAloneMinutes: 10 },
    rooms: {},
    awareness: { lines: 5 },
    chain: chainConfig(),
    ...over,
  };
}

export function roomFixture(over: Partial<RoomState> = {}): RoomState {
  return {
    ref: ROOM,
    occupants: new Set(['alice', 'bob', 'botone', 'bottwo', 'botthree']),
    joinSeenAt: new Map(),
    selfJoinedAt: 0,
    omittedCount: 0,
    ...over,
  };
}
