import { FILES_LIMITS } from '../inbound/media-gate.js';
import type { Slots } from '../inbound/media-gate.js';
import { normalizeName } from '../names.js';
import type { Logger, OscarSession, OutgoingFile, TransferEvent } from '../oscar/index.js';
import type { Timers } from '../runtime.js';
import type { OutFile } from './plan.js';

export type SendOutcome = 'done' | 'failed';

type Timer = ReturnType<typeof setTimeout>;
type Offer = {
  to: string;
  files: OutFile[];
  onEnd: (outcome: SendOutcome) => void;
  check?: () => boolean;
  over: boolean;
  id?: string;
  // What the session told before the id was known.
  early: TransferEvent[];
  wait?: Timer;
  stall?: Timer;
  deadline?: Timer;
};
type Person = { moving?: Offer; waiting: Offer[] };

const CHUNK = 64 * 1024;
const MOVING = new Set<TransferEvent['state']>(['connecting', 'transferring']);
const ENDINGS = new Set<TransferEvent['state']>(['done', 'declined', 'cancelled', 'failed']);

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function outgoing(file: OutFile, at: number): OutgoingFile {
  return {
    name: file.name,
    bytes: file.bytes.byteLength,
    modifiedAt: at,
    read: async function* () {
      for (let from = 0; from < file.bytes.byteLength; from += CHUNK) yield file.bytes.subarray(from, from + CHUNK);
    },
  };
}

export function createFileSender(
  session: Pick<OscarSession, 'on' | 'sendFiles' | 'cancelTransfer'>,
  deps: { now: () => number; timers: Timers; log: Logger; slots: Slots },
): {
  // 'too-many' when the person already has 3 files waiting or moving. onEnd is called once.
  // check is asked when the offer goes out; an offer it refuses ends as failed.
  offer(to: string, files: OutFile[], onEnd: (outcome: SendOutcome) => void, check?: () => boolean): 'queued' | 'too-many';
  stop(): void;
  idle(): Promise<void>;
} {
  const people = new Map<string, Person>();
  const byId = new Map<string, Offer>();
  const pending = new Set<Promise<void>>();
  let stopped = false;

  const track = (work: Promise<void>): void => {
    pending.add(work);
    void work.finally(() => pending.delete(work));
  };

  const clear = (o: Offer): void => {
    for (const timer of [o.wait, o.stall, o.deadline]) if (timer !== undefined) deps.timers.clearTimeout(timer);
    o.wait = undefined;
    o.stall = undefined;
    o.deadline = undefined;
  };

  const cancel = (id: string, to: string): void => {
    track(
      session.cancelTransfer(id).catch((err: unknown) => {
        deps.log.warn('a transfer was not cancelled', { peer: to, error: errText(err) });
      }),
    );
  };

  const finish = (o: Offer, outcome: SendOutcome): void => {
    if (o.over) return;
    o.over = true;
    clear(o);
    const person = people.get(o.to);
    if (person?.moving === o) {
      person.moving = undefined;
      deps.slots.release(o.to, 'send-file-out');
    } else if (person) {
      person.waiting = person.waiting.filter((w) => w !== o);
    }
    if (person && !person.moving && person.waiting.length === 0) people.delete(o.to);
    if (o.id !== undefined) byId.delete(o.id);
    try {
      o.onEnd(outcome);
    } catch (err) {
      deps.log.warn('the end of a transfer was not handled', { peer: o.to, error: errText(err) });
    }
    pump();
  };

  const expire = (o: Offer, why: string): void => {
    if (o.over) return;
    deps.log.info('cancelling a transfer', { peer: o.to, why });
    if (o.id !== undefined) cancel(o.id, o.to);
    finish(o, 'failed');
  };

  const onTransfer = (o: Offer, ev: TransferEvent): void => {
    if (o.over) return;
    if (ENDINGS.has(ev.state)) {
      finish(o, ev.state === 'done' ? 'done' : 'failed');
      return;
    }
    if (!MOVING.has(ev.state)) return;
    if (o.stall !== undefined) deps.timers.clearTimeout(o.stall);
    o.stall = deps.timers.setTimeout(() => expire(o, 'stalled'), FILES_LIMITS.stallMs);
    o.deadline ??= deps.timers.setTimeout(() => expire(o, 'took too long'), FILES_LIMITS.transferMs);
  };

  const start = (o: Offer): void => {
    if (o.wait !== undefined) deps.timers.clearTimeout(o.wait);
    o.wait = undefined;
    const at = Math.floor(deps.now() / 1000);
    track(
      session
        .sendFiles(
          o.to,
          o.files.map((f) => outgoing(f, at)),
        )
        .then(
          (id) => {
            // Stopped, or ended by a timer, while the offer went out.
            if (stopped || o.over) {
              cancel(id, o.to);
              return;
            }
            o.id = id;
            byId.set(id, o);
            const early = o.early;
            o.early = [];
            for (const ev of early) if (ev.id === id) onTransfer(o, ev);
          },
          (err: unknown) => {
            if (stopped) return;
            deps.log.warn('a file offer was not sent', { to: o.to, error: errText(err) });
            finish(o, 'failed');
          },
        ),
    );
  };

  const still = (o: Offer): boolean => {
    try {
      return o.check === undefined || o.check();
    } catch (err) {
      deps.log.warn('a file offer could not be checked', { to: o.to, error: errText(err) });
      return false;
    }
  };

  // Starts the first offer of each person who has none moving, while slots are free.
  function pump(): void {
    if (stopped) return;
    for (const [to, person] of [...people]) {
      const next = person.waiting[0];
      if (person.moving || !next) continue;
      if (!still(next)) {
        deps.log.info('a file offer is no longer allowed', { to });
        // Ending it starts what waits behind it.
        finish(next, 'failed');
        continue;
      }
      if (deps.slots.take(to, 'send-file-out') !== 'ok') continue;
      person.waiting.shift();
      person.moving = next;
      start(next);
    }
  }

  const off = session.on('transfer', (ev) => {
    if (stopped || ev.direction !== 'out') return;
    const known = byId.get(ev.id);
    if (known) {
      onTransfer(known, ev);
      return;
    }
    const moving = people.get(normalizeName(ev.peer))?.moving;
    if (moving && moving.id === undefined) moving.early.push(ev);
  });

  return {
    offer(to, files, onEnd, check) {
      const name = normalizeName(to);
      const person = people.get(name) ?? { waiting: [] };
      const held = (person.moving?.files.length ?? 0) + person.waiting.reduce((sum, w) => sum + w.files.length, 0);
      if (stopped || held + files.length > FILES_LIMITS.perSend) return 'too-many';
      const o: Offer = { to: name, files, onEnd, over: false, early: [], ...(check ? { check } : {}) };
      people.set(name, person);
      person.waiting.push(o);
      o.wait = deps.timers.setTimeout(() => expire(o, 'no free slot in time'), FILES_LIMITS.transferMs);
      pump();
      return 'queued';
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      off();
      for (const [to, person] of people) {
        for (const o of person.waiting) clear(o);
        const o = person.moving;
        if (!o) continue;
        clear(o);
        o.over = true;
        deps.slots.release(to, 'send-file-out');
        if (o.id !== undefined) cancel(o.id, to);
      }
      people.clear();
      byId.clear();
    },
    async idle(): Promise<void> {
      while (pending.size > 0) await Promise.all([...pending]);
    },
  };
}
