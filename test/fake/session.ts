import type { InviteEvent, OscarEvents, OscarSession, Presence, RoomRef, SendPriority, SendReceipt, SessionState } from '../../src/oscar/index.js';

type Listener = (payload: never) => void;

export class FakeSession {
  sent: { to: string; html: string; priority: SendPriority }[] = [];
  joins: { room: RoomRef; persistent: boolean }[] = [];
  invitedJoins: InviteEvent[] = [];
  leaves: RoomRef[] = [];
  roomSent: { room: RoomRef; html: string; whisperTo?: string; priority: SendPriority }[] = [];
  typing: { to: string; state: 'typing' | 'typed' | 'none' }[] = [];
  away: (string | null)[] = [];
  buddyUpdates = 0;
  started = false;
  stopped = false;
  failNext: Error | null = null;
  probeResult: 'checks' | 'does-not-check' | 'unknown' = 'checks';
  probes = 0;
  self: { screenName: string; bot: boolean } | null = { screenName: 'botone', bot: false };

  private listeners = new Map<string, Set<Listener>>();
  private presence = new Map<string, Presence>();
  private state: SessionState = { phase: 'idle', since: 0, attempts: 0 };
  private nextId = 1;

  emit<E extends keyof OscarEvents>(event: E, payload: OscarEvents[E]): void {
    for (const fn of [...(this.listeners.get(event) ?? [])]) (fn as (p: OscarEvents[E]) => void)(payload);
  }

  setState(state: Partial<SessionState>): void {
    this.state = { ...this.state, ...state };
    this.emit('state', this.state);
  }

  setPresence(name: string, p: Partial<Presence>): void {
    const next: Presence = { online: false, away: false, bot: false, at: 0, ...this.presence.get(name), ...p };
    this.presence.set(name, next);
    this.emit('presence', { name, ...next });
  }

  asSession(): OscarSession {
    const self = this;
    const api = {
      start(): void { self.started = true; },
      async stop(): Promise<void> { self.stopped = true; self.state = { ...self.state, phase: 'stopped' }; },
      getState: (): SessionState => self.state,
      on<E extends keyof OscarEvents>(event: E, fn: (payload: OscarEvents[E]) => void): () => void {
        const set = self.listeners.get(event) ?? new Set<Listener>();
        set.add(fn as Listener);
        self.listeners.set(event, set);
        return () => { set.delete(fn as Listener); };
      },
      selfInfo: () => self.self,
      presenceOf: (name: string): Presence | undefined => self.presence.get(name),
      updateBuddies(): void { self.buddyUpdates += 1; },
      async sendIm(to: string, html: string, opts?: { priority?: SendPriority }): Promise<SendReceipt> {
        if (self.failNext) {
          const err = self.failNext;
          self.failNext = null;
          throw err;
        }
        self.sent.push({ to, html, priority: opts?.priority ?? 'reply' });
        const storedOffline = self.presence.get(to)?.online !== true;
        return { id: String(self.nextId++), storedOffline };
      },
      sendTyping(to: string, state: 'typing' | 'typed' | 'none'): void { self.typing.push({ to, state }); },
      async setAway(text: string | null): Promise<void> { self.away.push(text); },
      async probePasswordCheck(): Promise<'checks' | 'does-not-check' | 'unknown'> { self.probes += 1; return self.probeResult; },
      rooms: () => [],
      async joinRoom(room: RoomRef, opts?: { persistent?: boolean }): Promise<void> {
        self.joins.push({ room, persistent: opts?.persistent === true });
      },
      async joinInvited(invite: InviteEvent): Promise<void> {
        self.invitedJoins.push(invite);
      },
      async leaveRoom(room: RoomRef): Promise<void> {
        self.leaves.push(room);
      },
      async sendRoom(room: RoomRef, html: string, opts?: { whisperTo?: string; priority?: SendPriority }): Promise<SendReceipt> {
        self.roomSent.push({ room, html, whisperTo: opts?.whisperTo, priority: opts?.priority ?? 'reply' });
        return { id: String(self.nextId++), storedOffline: false };
      },
    };
    return api as unknown as OscarSession;
  }
}
