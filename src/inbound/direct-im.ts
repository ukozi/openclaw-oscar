import { readPolicy } from '../config.js';
import type { RootPolicy } from '../config.js';
import { normalizeName } from '../names.js';
import type { DirectImOfferEvent, DirectImStateEvent, DirectMessageEvent, Logger, OscarSession } from '../oscar/index.js';
import type { Timers } from '../runtime.js';
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

type Live = { peer: string; timer?: ReturnType<typeof setTimeout> };

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createDirectImIntake(
  session: Pick<OscarSession, 'on' | 'acceptDirectIm' | 'declineDirectIm' | 'closeDirectIm'>,
  deps: IntakeDeps,
): { stop(): void; idle(): Promise<void> } {
  const live = new Map<string, Live>();
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

  const end = (id: string): Live | undefined => {
    const s = live.get(id);
    if (!s) return undefined;
    live.delete(id);
    if (s.timer !== undefined) deps.timers.clearTimeout(s.timer);
    deps.slots.release(s.peer, 'direct-im');
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

  const decline = async (id: string): Promise<void> => {
    await session.declineDirectIm(id).catch((err: unknown) => {
      deps.log.warn('a Direct IM offer was not declined', { error: errText(err) });
    });
  };

  const onOffer = async (ev: DirectImOfferEvent): Promise<void> => {
    const from = normalizeName(ev.from);
    const verdict = await gate(from, readPolicy(deps.getCfg()));
    if (stopped) return;
    if (verdict !== 'allow') {
      if (verdict === 'stranger') deps.stranger(from, ev.fromDisplay);
      await decline(ev.id);
      return;
    }
    const slot = deps.slots.take(from, 'direct-im');
    if (slot !== 'ok') {
      await decline(ev.id);
      if (slot === 'busy-others') deps.refuse(from, 'busy-others');
      return;
    }
    const s: Live = { peer: from };
    live.set(ev.id, s);
    arm(ev.id, s);
    try {
      await session.acceptDirectIm(ev.id);
    } catch (err) {
      end(ev.id);
      deps.log.warn('a Direct IM offer was not accepted', { from, error: errText(err) });
    }
  };

  const onState = async (ev: DirectImStateEvent): Promise<void> => {
    if (ev.state !== 'closed') return;
    const s = end(ev.id);
    if (s && ev.end === 'too-large') deps.refuse(s.peer, 'too-large');
  };

  const onMessage = async (ev: DirectMessageEvent): Promise<void> => {
    const s = live.get(ev.id);
    if (!s) return;
    const policy = readPolicy(deps.getCfg());
    if ((await gate(s.peer, policy)) !== 'allow') {
      close(ev.id, 'the sender is no longer allowed');
      return;
    }
    if (stopped) return;
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
    if (media.length > 0 || ev.text.trim() !== '') deps.deliver({ from: s.peer, fromDisplay: ev.fromDisplay, text: ev.text, media });
  };

  const offs = [
    session.on('directImOffer', (ev) => queue('offer', () => onOffer(ev))),
    session.on('directIm', (ev) => queue('ending', () => onState(ev))),
    session.on('directMessage', (ev) => queue('message', () => onMessage(ev))),
  ];

  return {
    stop(): void {
      stopped = true;
      for (const off of offs) off();
      for (const id of [...live.keys()]) end(id);
    },
    idle: () => tail,
  };
}
