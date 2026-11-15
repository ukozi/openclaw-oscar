import type { OscarClientEvents, SendImOptions, SentIm, TypingEvent } from 'open-oscar-client-kit/client';
import { roomConversationId } from 'open-oscar-client-kit/model';
import type { BuddyPresence, ImBody, RichText, RoomId, RoomStatus, SelfInfo, SessionState } from 'open-oscar-client-kit/model';
import type { KitClient } from '../../src/oscar/kit-client.js';

export type Outcome<T> = { resolve: T } | { reject: unknown } | 'hold';
export type Held<T> = { resolve: (value: T) => void; reject: (error: unknown) => void };
export type StubCall = { method: string; args: unknown[] };
type Scripted = 'sendIm' | 'sendTyping' | 'setAway' | 'joinRoom' | 'leaveRoom' | 'sendRoomMessage' | 'refreshSessionBuddies';
type Listeners = { [E in keyof OscarClientEvents]?: Set<(payload: OscarClientEvents[E]) => void> };

export class StubClient implements KitClient {
  state: SessionState = 'online';
  self: SelfInfo | null = null;
  readonly calls: StubCall[] = [];
  // Calls a test holds open, in the order they were made.
  readonly held: Held<unknown>[] = [];
  readonly presence = new Map<string, BuddyPresence>();
  joined: RoomStatus[] = [];
  private readonly scripts = new Map<Scripted, Outcome<unknown>[]>();
  private readonly listeners: Listeners = {};
  private sends = 0;

  script(method: Scripted, ...outcomes: Outcome<unknown>[]): void {
    this.scripts.set(method, [...(this.scripts.get(method) ?? []), ...outcomes]);
  }

  callsTo(method: string): unknown[][] {
    return this.calls.filter((c) => c.method === method).map((c) => c.args);
  }

  emit<E extends keyof OscarClientEvents>(event: E, payload: OscarClientEvents[E]): void {
    for (const fn of [...(this.listeners[event] ?? [])]) fn(payload);
  }

  on<E extends keyof OscarClientEvents>(event: E, fn: (payload: OscarClientEvents[E]) => void): () => void {
    const set: Set<(payload: OscarClientEvents[E]) => void> = this.listeners[event] ?? new Set();
    (this.listeners as Record<string, unknown>)[event] = set;
    set.add(fn);
    return () => {
      set.delete(fn);
    };
  }

  private next<T>(method: Scripted, args: unknown[], fallback: () => T): Promise<T> {
    this.calls.push({ method, args });
    const outcome = this.scripts.get(method)?.shift();
    if (outcome === undefined) return Promise.resolve(fallback());
    if (outcome === 'hold') {
      return new Promise<T>((resolve, reject) => {
        this.held.push({ resolve: resolve as (value: unknown) => void, reject });
      });
    }
    return 'reject' in outcome ? Promise.reject(outcome.reject) : Promise.resolve(outcome.resolve as T);
  }

  async signOnWith(...args: unknown[]): Promise<'online' | 'cancelled'> {
    this.calls.push({ method: 'signOnWith', args });
    this.state = 'online';
    return 'online';
  }

  async signOff(): Promise<void> {
    this.calls.push({ method: 'signOff', args: [] });
    this.state = 'offline';
  }

  presenceOf(screenName: string): BuddyPresence | undefined {
    return this.presence.get(screenName);
  }

  refreshSessionBuddies(): Promise<void> {
    return this.next('refreshSessionBuddies', [], () => undefined);
  }

  sendIm(to: string, body: ImBody, opts?: SendImOptions): Promise<SentIm> {
    return this.next('sendIm', [to, body, opts], () => {
      this.sends += 1;
      return { id: this.sends.toString(16).padStart(16, '0'), stored: false };
    });
  }

  sendTyping(to: string, event: TypingEvent): Promise<void> {
    return this.next('sendTyping', [to, event], () => undefined);
  }

  setAway(message: ImBody | null, opts?: { source?: string }): Promise<void> {
    return this.next('setAway', opts ? [message, opts] : [message], () => undefined);
  }

  joinRoom(room: RoomId): Promise<RoomStatus> {
    return this.next('joinRoom', [room], () => {
      const status: RoomStatus = {
        id: roomConversationId(room),
        exchange: room.exchange,
        name: room.name,
        state: 'joined',
        occupants: [],
        createdAt: null,
        maxOccupancy: null,
      };
      this.joined.push(status);
      this.emit('room', status);
      return status;
    });
  }

  leaveRoom(roomId: string): Promise<void> {
    return this.next('leaveRoom', [roomId], () => {
      this.joined = this.joined.filter((r) => r.id !== roomId);
    });
  }

  rooms(): RoomStatus[] {
    return [...this.joined];
  }

  sendRoomMessage(
    roomId: string,
    body: ImBody,
    opts?: { whisperTo?: string },
  ): Promise<{ replacedBy: RichText | null; id: string }> {
    return this.next('sendRoomMessage', opts ? [roomId, body, opts] : [roomId, body], () => {
      this.sends += 1;
      return { replacedBy: null, id: this.sends.toString(16).padStart(16, '0') };
    });
  }

  forgetInvite(inviteId: string): void {
    this.calls.push({ method: 'forgetInvite', args: [inviteId] });
  }
}
