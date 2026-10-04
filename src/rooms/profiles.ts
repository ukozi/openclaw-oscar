import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonFileAtomically } from 'openclaw/plugin-sdk/json-store';
import { resolveStateDir } from 'openclaw/plugin-sdk/state-paths';
import type { RoomProfile, RoomTrust, RootPolicy } from '../config.js';
import { copy } from '../copy.js';
import { normalizeRoom, type RoomRef } from '../names.js';
import type { Logger } from '../oscar/index.js';
import { roomKey } from '../runtime.js';

export type StoredRoom = { profile?: RoomProfile; trustOverride?: 'public'; updatedAt: number };
type StoreFile = { version: 1; rooms: Record<string, StoredRoom> };

export class ProfileStore {
  private readonly rooms = new Map<string, StoredRoom>();
  private readonly file: string;
  private readonly log: Logger;
  private readonly now: () => number;
  private writing: Promise<void> = Promise.resolve();

  constructor(opts: { file: string; log: Logger; now: () => number }) {
    this.file = opts.file;
    this.log = opts.log;
    this.now = opts.now;
    this.load();
  }

  get(roomKey: string): StoredRoom | undefined {
    return this.rooms.get(roomKey);
  }

  setProfile(roomKey: string, profile: RoomProfile): void {
    this.rooms.set(roomKey, { profile, updatedAt: this.now() });
    this.save();
  }

  setTrustOverride(roomKey: string, override: 'public' | null): void {
    const { trustOverride: _, ...rest } = this.rooms.get(roomKey) ?? { updatedAt: 0 };
    const next: StoredRoom = { ...rest, ...(override ? { trustOverride: override } : {}), updatedAt: this.now() };
    if (!next.profile && !next.trustOverride) this.rooms.delete(roomKey);
    else this.rooms.set(roomKey, next);
    this.save();
  }

  flush(): Promise<void> {
    return this.writing;
  }

  private load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.log.warn(`room profiles: cannot read ${this.file}: ${String(err)}`);
      return;
    }
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      this.log.warn(`room profiles: ${this.file} is not valid JSON; starting empty`);
      return;
    }
    const file = data as Partial<StoreFile> | null;
    if (!file || file.version !== 1 || typeof file.rooms !== 'object' || file.rooms === null) {
      this.log.warn(`room profiles: ${this.file} has an unknown shape; starting empty`);
      return;
    }
    for (const [key, room] of Object.entries(file.rooms)) {
      if (room && typeof room === 'object' && typeof room.updatedAt === 'number') this.rooms.set(key, room);
    }
  }

  private save(): void {
    const body: StoreFile = { version: 1, rooms: Object.fromEntries(this.rooms) };
    this.writing = this.writing
      .then(() => writeJsonFileAtomically(this.file, body))
      .catch((err: unknown) => this.log.warn(`room profiles: cannot write ${this.file}: ${String(err)}`));
  }
}

export function storeFileFor(accountId: string): string {
  return join(resolveStateDir(), 'oscar', `rooms-${accountId}.json`);
}

const stores = new Map<string, ProfileStore>();

export function attachProfileStore(accountId: string, store: ProfileStore | null): void {
  if (store) stores.set(accountId, store);
  else stores.delete(accountId);
}

export function profileStore(accountId: string): ProfileStore | undefined {
  return stores.get(accountId);
}

export type Effective = { source: 'config' | 'stored'; profile: RoomProfile } | { source: 'pending' };

export function effectiveProfile(accountId: string, policy: RootPolicy, ref: RoomRef): Effective {
  const key = roomKey(ref);
  const stored = stores.get(accountId)?.get(key);
  const home = policy.room && roomKey(policy.room.ref) === key ? policy.room.profile : undefined;
  const configured = home ?? policy.rooms[normalizeRoom(ref.name)]?.profile;
  if (configured) {
    return { source: 'config', profile: stored?.trustOverride ? { ...configured, trust: stored.trustOverride } : configured };
  }
  if (stored?.profile) return { source: 'stored', profile: stored.profile };
  return { source: 'pending' };
}

export function trustPrompt(trust: RoomTrust | undefined): string {
  return trust ? copy.trustLine(trust) : '';
}
