import { readPolicy } from '../config.js';
import type { RootPolicy } from '../config.js';
import { normalizeName } from '../names.js';
import type { FileOfferEvent, FileSink, FileWriter, IncomingFile, OscarSession, TransferEvent, TransferFailure } from '../oscar/index.js';
import type { IntakeDeps } from './direct-im.js';
import { FILES_LIMITS, senderGate } from './media-gate.js';
import type { GateResult, Refusal, TurnMedia } from './media-gate.js';
import { baseName, sniff } from './sniff.js';

type Timer = ReturnType<typeof setTimeout>;
type Kept = { name: string; bytes: Uint8Array; contentType: string; kind: 'image' | 'document' };
type Live = {
  id: string;
  peer: string;
  display: string;
  maxBytes: number;
  begun: number;
  kept: Kept[];
  refusals: Set<Refusal>;
  over: boolean;
  stall?: Timer;
  deadline?: Timer;
};

const ENDINGS = new Set<TransferEvent['state']>(['done', 'declined', 'cancelled', 'failed']);

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createSendFileIntake(
  session: Pick<OscarSession, 'on' | 'acceptFileOffer' | 'declineFileOffer' | 'cancelTransfer'>,
  deps: IntakeDeps,
): { stop(): void; idle(): Promise<void> } {
  const live = new Map<string, Live>();
  let stopped = false;
  let tail: Promise<void> = Promise.resolve();

  // One step at a time, so an ending never overtakes the offer before it.
  const queue = (what: string, step: () => Promise<void>): void => {
    tail = tail.then(async () => {
      if (stopped) return;
      try {
        await step();
      } catch (err) {
        deps.log.warn(`file ${what} failed`, { error: errText(err) });
      }
    });
  };

  const gate = async (from: string, policy: RootPolicy): Promise<GateResult> => {
    try {
      return await senderGate({ from, self: deps.self(), policy, admit: deps.admit });
    } catch (err) {
      deps.log.warn('the sender of a file could not be checked', { from, error: errText(err) });
      return 'silent';
    }
  };

  const end = (id: string): Live | undefined => {
    const t = live.get(id);
    if (!t) return undefined;
    live.delete(id);
    t.over = true;
    if (t.stall !== undefined) deps.timers.clearTimeout(t.stall);
    if (t.deadline !== undefined) deps.timers.clearTimeout(t.deadline);
    deps.slots.release(t.peer, 'send-file');
    return t;
  };

  // The files that came whole go to the agent, however the transfer ended.
  const settle = async (t: Live, failure?: TransferFailure): Promise<void> => {
    const kept = t.kept;
    t.kept = [];
    const policy = readPolicy(deps.getCfg());
    if (!policy.files.sendFile || (await gate(t.peer, policy)) !== 'allow') {
      deps.log.info('dropped the files of a sender who is no longer allowed', { peer: t.peer, files: kept.length });
      return;
    }
    const media: TurnMedia[] = [];
    for (const file of kept) {
      if (stopped) return;
      try {
        const saved = await deps.save({ bytes: file.bytes, contentType: file.contentType, name: file.name, maxBytes: t.maxBytes });
        media.push({ path: saved.path, contentType: file.contentType, kind: file.kind, name: file.name, bytes: file.bytes.byteLength, via: 'send-file' });
      } catch (err) {
        deps.log.warn('a received file was not saved', { from: t.peer, error: errText(err) });
      }
    }
    if (stopped) return;
    if (failure === 'file-problem') t.refusals.add('damaged');
    for (const why of t.refusals) deps.refuse(t.peer, why);
    if (media.length > 0) deps.deliver({ from: t.peer, fromDisplay: t.display, text: '', media });
  };

  // The timers do not wait in the queue.
  const expire = (id: string, why: string): void => {
    const t = end(id);
    if (!t) return;
    deps.log.info('cancelling a transfer', { peer: t.peer, why });
    session.cancelTransfer(id).catch((err: unknown) => {
      deps.log.warn('a transfer was not cancelled', { peer: t.peer, error: errText(err) });
    });
    queue('ending', () => settle(t));
  };

  const moved = (t: Live): void => {
    if (t.over) return;
    if (t.stall !== undefined) deps.timers.clearTimeout(t.stall);
    t.stall = deps.timers.setTimeout(() => expire(t.id, 'stalled'), FILES_LIMITS.stallMs);
  };

  const sinkFor = (t: Live): FileSink => ({
    begin: async (file: IncomingFile): Promise<FileWriter> => {
      if (t.over) throw new Error('the transfer ended');
      const stop = (why: Refusal, text: string): never => {
        t.refusals.add(why);
        throw new Error(text);
      };
      if (t.begun >= FILES_LIMITS.perOffer || file.count > FILES_LIMITS.perOffer) stop('too-many', 'more files than the limit');
      if (file.name.includes('\u0001')) stop('too-many', 'a file inside a folder');
      if (file.bytes > t.maxBytes) stop('too-large', 'a file over the limit');
      t.begun += 1;
      moved(t);
      let chunks: Uint8Array[] = [];
      let got = 0;
      return {
        write: async (chunk) => {
          if (t.over) throw new Error('the transfer ended');
          got += chunk.byteLength;
          if (got > file.bytes) stop('damaged', 'more bytes than the file named');
          chunks.push(chunk.slice());
          moved(t);
        },
        finish: async () => {
          if (t.over) throw new Error('the transfer ended');
          const bytes = Buffer.concat(chunks);
          chunks = [];
          const found = sniff(bytes, file.name);
          if (found.kind === 'other') t.refusals.add('wrong-type');
          else t.kept.push({ name: baseName(file.name), bytes, contentType: found.contentType, kind: found.kind === 'image' ? 'image' : 'document' });
        },
        abort: async () => {
          chunks = [];
        },
      };
    },
  });

  const decline = async (id: string): Promise<void> => {
    await session.declineFileOffer(id).catch((err: unknown) => {
      deps.log.warn('a file offer was not declined', { error: errText(err) });
    });
  };

  const onOffer = async (ev: FileOfferEvent): Promise<void> => {
    const from = normalizeName(ev.from);
    const policy = readPolicy(deps.getCfg());
    const verdict = await gate(from, policy);
    if (stopped) return;
    // Anyone not allowed gets no answer: an answer costs a send.
    if (verdict !== 'allow') {
      if (verdict === 'stranger' && policy.files.sendFile) deps.stranger(from, ev.fromDisplay);
      return;
    }
    if (!policy.files.sendFile) {
      await decline(ev.id);
      return;
    }
    const maxBytes = policy.files.maxBytes;
    const refusal: Refusal | undefined =
      ev.folder || ev.count > FILES_LIMITS.perOffer ? 'too-many' : ev.totalBytes > Math.max(1, ev.count) * maxBytes ? 'too-large' : undefined;
    if (refusal !== undefined) {
      await decline(ev.id);
      deps.refuse(from, refusal);
      return;
    }
    const slot = deps.slots.take(from, 'send-file');
    if (slot !== 'ok') {
      await decline(ev.id);
      deps.refuse(from, slot);
      return;
    }
    const t: Live = { id: ev.id, peer: from, display: ev.fromDisplay, maxBytes, begun: 0, kept: [], refusals: new Set(), over: false };
    live.set(ev.id, t);
    moved(t);
    t.deadline = deps.timers.setTimeout(() => expire(ev.id, 'took too long'), FILES_LIMITS.transferMs);
    try {
      await session.acceptFileOffer(ev.id, sinkFor(t));
    } catch (err) {
      end(ev.id);
      deps.log.warn('a file offer was not accepted', { from, error: errText(err) });
    }
  };

  const onTransfer = async (ev: TransferEvent): Promise<void> => {
    if (ev.direction === 'out') return;
    const t = live.get(ev.id);
    if (!t) return;
    if (!ENDINGS.has(ev.state)) {
      moved(t);
      return;
    }
    end(ev.id);
    await settle(t, ev.failure);
  };

  const offs = [
    session.on('fileOffer', (ev) => queue('offer', () => onOffer(ev))),
    session.on('transfer', (ev) => queue('transfer', () => onTransfer(ev))),
  ];

  return {
    stop(): void {
      stopped = true;
      for (const off of offs) off();
      for (const id of [...live.keys()]) {
        const t = end(id);
        if (t) t.kept = [];
      }
    },
    idle: () => tail,
  };
}
