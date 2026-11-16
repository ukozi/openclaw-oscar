import { readPolicy } from '../config.js';
import type { RootPolicy } from '../config.js';
import { normalizeName } from '../names.js';
import { directImLimits } from '../oscar/index.js';
import type { DirectImOfferEvent, DirectImStateEvent, DirectMessageEvent, Logger, OscarSession } from '../oscar/index.js';
import type { Timers } from '../runtime.js';
import type { Picture } from '../sending/plan.js';
import type { SendOutcome } from '../sending/send-file.js';
import { FILES_LIMITS, senderGate } from './media-gate.js';
import type { GateResult, MediaEvent, Refusal, Slots, TurnMedia } from './media-gate.js';
import type { saveInbound } from './media-store.js';
import { baseName, sniff } from './sniff.js';

export type IntakeDeps = {
  self: () => string; getCfg: () => unknown; now: () => number; timers: Timers; log: Logger; slots: Slots;
  admit: (from: string, policy: RootPolicy) => Promise<boolean>;
  save: typeof saveInbound;
  deliver: (ev: MediaEvent) => void;
  refuse: (to: string, why: Refusal) => void;
  stranger: (name: string, display: string) => void;
};

type Batch = { peer: string; pictures: Picture[]; onEnd: (outcome: SendOutcome) => void; over: boolean };
// waiting: what goes out once the session is open. sending: the last message on its way.
type Live = { peer: string; bytes: number; open: boolean; waiting: Batch[]; sending: Promise<void>; timer?: ReturnType<typeof setTimeout> };

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// An IM carries about this much; a Direct IM message could carry megabytes.
function cutText(text: string): string {
  if (text.length <= FILES_LIMITS.textChars) return text;
  const cut = text.slice(0, FILES_LIMITS.textChars);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

export function createDirectImIntake(
  session: Pick<OscarSession, 'on' | 'acceptDirectIm' | 'declineDirectIm' | 'closeDirectIm' | 'openDirectIm' | 'sendDirectMessage'>,
  deps: IntakeDeps,
): {
  // Sends the pictures in the live session with the person, or in a new one. onEnd is called once.
  // 'too-many' when the person would have more than 3 pictures waiting or on their way.
  send(to: string, pictures: Picture[], onEnd: (outcome: SendOutcome) => void): 'queued' | 'too-many';
  stop(): void;
  idle(): Promise<void>;
} {
  const live = new Map<string, Live>();
  // Offers of a listed person the host does not admit, left with no answer.
  const unanswered = new Set<string>();
  // Pictures handed over and not yet sent, by person.
  const held = new Map<string, number>();
  const pending = new Set<Promise<void>>();
  let stopped = false;
  let tail: Promise<void> = Promise.resolve();

  // One step at a time, so an ending never overtakes the offer or the message before it.
  const queue = (what: string, step: () => Promise<void>): void => {
    tail = tail.then(async () => {
      if (stopped) return;
      try {
        await step();
      } catch (err) {
        deps.log.warn(`Direct IM ${what} failed`, { error: errText(err) });
      }
    });
  };

  const gate = async (from: string, policy: RootPolicy): Promise<GateResult> => {
    try {
      return await senderGate({ from, self: deps.self(), policy, admit: deps.admit });
    } catch (err) {
      deps.log.warn('the sender of a Direct IM could not be checked', { from, error: errText(err) });
      return 'silent';
    }
  };

  // Nothing is told once the intake has stopped.
  const tell = (batch: Batch, outcome: SendOutcome): void => {
    if (batch.over) return;
    batch.over = true;
    const left = (held.get(batch.peer) ?? 0) - batch.pictures.length;
    if (left > 0) held.set(batch.peer, left);
    else held.delete(batch.peer);
    if (stopped) return;
    try {
      batch.onEnd(outcome);
    } catch (err) {
      deps.log.warn('the end of a Direct IM send was not handled', { error: errText(err) });
    }
  };

  const end = (id: string): Live | undefined => {
    const s = live.get(id);
    if (!s) return undefined;
    live.delete(id);
    if (s.timer !== undefined) deps.timers.clearTimeout(s.timer);
    deps.slots.release(s.peer, 'direct-im');
    for (const batch of s.waiting.splice(0)) tell(batch, 'failed');
    return s;
  };

  const close = (id: string, why: string): void => {
    const s = end(id);
    if (!s) return;
    deps.log.info('closing a Direct IM session', { peer: s.peer, why });
    session.closeDirectIm(id).catch((err: unknown) => {
      deps.log.warn('a Direct IM session did not close', { peer: s.peer, error: errText(err) });
    });
  };

  const arm = (id: string, s: Live): void => {
    if (s.timer !== undefined) deps.timers.clearTimeout(s.timer);
    s.timer = deps.timers.setTimeout(() => close(id, 'idle'), FILES_LIMITS.idleMs);
  };

  // The pictures go out in the order given; a message holds at most three, and no more bytes than one file may have.
  const post = (id: string, s: Live, batches: Batch[]): void => {
    const maxBytes = readPolicy(deps.getCfg()).files.maxBytes;
    const items = batches.flatMap((batch) => batch.pictures.map((picture) => ({ batch, picture })));
    const lastOf = new Map(items.map((item, at) => [item.batch, at]));
    const failed = new Set<Batch>();
    let from = 0;
    while (from < items.length) {
      let to = from + 1;
      let bytes = items[from]?.picture.bytes.byteLength ?? 0;
      while (to < items.length && to - from < FILES_LIMITS.perOffer) {
        const next = items[to]?.picture.bytes.byteLength ?? 0;
        if (bytes + next > maxBytes) break;
        bytes += next;
        to += 1;
      }
      const part = items.slice(from, to);
      const [first, end] = [from, to];
      const over = batches.filter((batch) => {
        const at = lastOf.get(batch) ?? 0;
        return at >= first && at < end;
      });
      from = to;
      s.sending = s.sending.then(async () => {
        let sent = false;
        if (live.get(id) === s) {
          arm(id, s);
          try {
            await session.sendDirectMessage(id, { pictures: part.map((item) => item.picture) });
            sent = true;
            if (live.get(id) === s) arm(id, s);
          } catch (err) {
            deps.log.warn('a Direct IM message was not sent', { to: s.peer, error: errText(err) });
          }
        }
        if (!sent) for (const item of part) failed.add(item.batch);
        for (const batch of over) tell(batch, failed.has(batch) ? 'failed' : 'done');
      });
    }
    const work = s.sending;
    pending.add(work);
    void work.finally(() => pending.delete(work));
  };

  // What waited goes out only if the setting and the person still allow it.
  const opened = async (id: string, s: Live): Promise<void> => {
    if (s.open) return;
    s.open = true;
    if (s.waiting.length === 0) return;
    const policy = readPolicy(deps.getCfg());
    if (!policy.files.directIm) {
      close(id, 'the setting is off');
      return;
    }
    const verdict = await gate(s.peer, policy);
    if (stopped || live.get(id) !== s) return;
    if (verdict !== 'allow') {
      close(id, 'the sender is no longer allowed');
      return;
    }
    post(id, s, s.waiting.splice(0));
  };

  const give = async (peer: string, batch: Batch): Promise<void> => {
    const policy = readPolicy(deps.getCfg());
    if (!policy.files.directIm || (await gate(peer, policy)) !== 'allow') {
      deps.log.info('no Direct IM goes to this name', { to: peer });
      tell(batch, 'failed');
      return;
    }
    if (stopped) return;
    for (const [id, s] of live) {
      if (s.peer !== peer) continue;
      if (s.open) post(id, s, [batch]);
      else s.waiting.push(batch);
      return;
    }
    if (deps.slots.take(peer, 'direct-im') !== 'ok') {
      deps.log.info('no free slot to open Direct IM', { to: peer });
      tell(batch, 'failed');
      return;
    }
    let id: string;
    try {
      id = await session.openDirectIm(peer);
    } catch (err) {
      deps.slots.release(peer, 'direct-im');
      deps.log.warn('Direct IM was not opened', { to: peer, error: errText(err) });
      tell(batch, 'failed');
      return;
    }
    const s: Live = { peer, bytes: 0, open: false, waiting: [batch], sending: Promise.resolve() };
    live.set(id, s);
    if (stopped) {
      close(id, 'stopped');
      return;
    }
    // The wait for an answer ends here too, should the session never report its end.
    arm(id, s);
    // The id of an offer the person made and the bot left unanswered: that offer is taken.
    if (!unanswered.delete(id)) return;
    try {
      await session.acceptDirectIm(id);
    } catch (err) {
      end(id);
      deps.log.warn('a Direct IM offer was not accepted', { from: peer, error: errText(err) });
    }
  };

  const decline = async (id: string): Promise<void> => {
    await session.declineDirectIm(id).catch((err: unknown) => {
      deps.log.warn('a Direct IM offer was not declined', { error: errText(err) });
    });
  };

  const onOffer = async (ev: DirectImOfferEvent): Promise<void> => {
    const from = normalizeName(ev.from);
    const policy = readPolicy(deps.getCfg());
    const verdict = await gate(from, policy);
    if (stopped) return;
    // Anyone not allowed gets no answer: an answer costs a send.
    if (verdict !== 'allow') {
      if (verdict === 'stranger' && policy.files.directIm) deps.stranger(from, ev.fromDisplay);
      else unanswered.add(ev.id);
      return;
    }
    if (!policy.files.directIm) {
      await decline(ev.id);
      return;
    }
    // The bot may already hold this offer: it asked to open a session as the offer came.
    let s = live.get(ev.id);
    if (!s) {
      const slot = deps.slots.take(from, 'direct-im');
      if (slot !== 'ok') {
        await decline(ev.id);
        if (slot === 'busy-others') deps.refuse(from, 'busy-others');
        return;
      }
      s = { peer: from, bytes: 0, open: false, waiting: [], sending: Promise.resolve() };
      live.set(ev.id, s);
    }
    arm(ev.id, s);
    try {
      await session.acceptDirectIm(ev.id);
    } catch (err) {
      end(ev.id);
      deps.log.warn('a Direct IM offer was not accepted', { from, error: errText(err) });
    }
  };

  const onState = async (ev: DirectImStateEvent): Promise<void> => {
    if (ev.state === 'open') {
      const s = live.get(ev.id);
      if (s) await opened(ev.id, s);
      return;
    }
    unanswered.delete(ev.id);
    const s = end(ev.id);
    if (!s || ev.end !== 'too-large') return;
    // The session's total ends it the same way, after a message that was taken.
    const limits = directImLimits(readPolicy(deps.getCfg()).files.maxBytes);
    if (s.bytes + limits.maxMessageBytes > limits.maxSessionBytes) deps.log.info('a Direct IM session reached its total', { peer: s.peer });
    else deps.refuse(s.peer, 'too-large');
  };

  const onMessage = async (ev: DirectMessageEvent): Promise<void> => {
    const s = live.get(ev.id);
    if (!s) return;
    s.bytes += ev.pictures.reduce((sum, picture) => sum + picture.bytes.byteLength, ev.text.length);
    const policy = readPolicy(deps.getCfg());
    if (!policy.files.directIm) {
      close(ev.id, 'the setting is off');
      return;
    }
    const verdict = await gate(s.peer, policy);
    // The idle close does not wait in the queue.
    if (stopped || live.get(ev.id) !== s) return;
    if (verdict !== 'allow') {
      close(ev.id, 'the sender is no longer allowed');
      return;
    }
    arm(ev.id, s);
    if (ev.autoResponse) return;
    if (ev.damaged) {
      deps.refuse(s.peer, 'damaged');
      return;
    }
    const refusals = new Set<Refusal>();
    const media: TurnMedia[] = [];
    if (ev.pictures.length > FILES_LIMITS.perOffer) refusals.add('too-many');
    else {
      for (const picture of ev.pictures) {
        if (picture.bytes.byteLength > policy.files.maxBytes) {
          refusals.add('too-large');
          continue;
        }
        const found = sniff(picture.bytes, picture.name);
        if (found.kind !== 'image') {
          refusals.add('wrong-type');
          continue;
        }
        const name = baseName(picture.name);
        try {
          const saved = await deps.save({ bytes: picture.bytes, contentType: found.contentType, name, maxBytes: policy.files.maxBytes });
          media.push({ path: saved.path, contentType: found.contentType, kind: 'image', name, bytes: picture.bytes.byteLength, via: 'direct-im' });
        } catch (err) {
          deps.log.warn('a Direct IM picture was not saved', { from: s.peer, error: errText(err) });
        }
      }
    }
    if (stopped) return;
    for (const why of refusals) deps.refuse(s.peer, why);
    const text = cutText(ev.text);
    if (text !== ev.text) deps.log.warn('the text of a Direct IM was cut', { from: s.peer, length: ev.text.length });
    if (media.length > 0 || text.trim() !== '') deps.deliver({ from: s.peer, fromDisplay: ev.fromDisplay, text, media });
  };

  const offs = [
    session.on('directImOffer', (ev) => queue('offer', () => onOffer(ev))),
    session.on('directIm', (ev) => queue('state', () => onState(ev))),
    session.on('directMessage', (ev) => queue('message', () => onMessage(ev))),
  ];

  return {
    send(to, pictures, onEnd) {
      const peer = normalizeName(to);
      if (stopped || !peer) {
        onEnd('failed');
        return 'queued';
      }
      if (pictures.length === 0) {
        onEnd('done');
        return 'queued';
      }
      const count = (held.get(peer) ?? 0) + pictures.length;
      if (count > FILES_LIMITS.perSend) return 'too-many';
      held.set(peer, count);
      const batch: Batch = { peer, pictures, onEnd, over: false };
      queue('send', async () => {
        try {
          await give(peer, batch);
        } catch (err) {
          tell(batch, 'failed');
          throw err;
        }
      });
      return 'queued';
    },
    stop(): void {
      stopped = true;
      for (const off of offs) off();
      for (const id of [...live.keys()]) end(id);
      held.clear();
    },
    async idle(): Promise<void> {
      for (;;) {
        const step = tail;
        await step;
        await Promise.all([...pending]);
        if (step === tail && pending.size === 0) return;
      }
    },
  };
}
