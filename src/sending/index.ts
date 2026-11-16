import { readPolicy } from '../config.js';
import type { FilesPolicy } from '../config.js';
import type { createDirectImIntake } from '../inbound/direct-im.js';
import { FILES_LIMITS } from '../inbound/media-gate.js';
import { normalizeName } from '../names.js';
import type { RoomRef } from '../names.js';
import type { Logger, Presence } from '../oscar/index.js';
import { checkTarget } from '../outbound.js';
import { roleOf } from '../policy.js';
import { getRuntime } from '../runtime.js';
import { linkOf, loadOutgoing } from './load.js';
import type { HostAccess } from './load.js';
import type { SendProblem } from './notes.js';
import { classify, routeOf } from './plan.js';
import type { OutFile, Picture } from './plan.js';
import type { SendOutcome, createFileSender } from './send-file.js';

export type MediaSender = {
  // Never throws for a file problem. Returns once the sends are started; the endings are told by a line.
  sendMediaTo(p: { cfg: unknown; accountId: string; to: string; urls: string[]; agentId?: string; host?: HostAccess }): Promise<void>;
  stop(): void;
};

type Deps = {
  accountId: string; self: () => string; getCfg: () => unknown; now: () => number; log: Logger;
  presenceOf: (name: string) => Presence | undefined;
  files: ReturnType<typeof createFileSender> | undefined;
  directIm: Pick<ReturnType<typeof createDirectImIntake>, 'send'> | undefined;
  note: (to: string, why: SendProblem, link?: string) => void;
  roomNote: (room: RoomRef, why: SendProblem) => void;
};

export function createMediaSender(deps: Deps): MediaSender {
  let stopped = false;

  const note = (to: string, why: SendProblem, link?: string): void => {
    if (!stopped) deps.note(to, why, link);
  };
  const failed = (to: string, urls: string[]): void => {
    for (const url of urls) note(to, 'failed', linkOf(url));
  };

  // What the settings allow, for an owner or an approved person only.
  const allowed = (to: string): { role: 'owner' | 'approved'; files: FilesPolicy } | undefined => {
    const policy = readPolicy(deps.getCfg());
    const role = roleOf(to, policy);
    if ((role !== 'owner' && role !== 'approved') || to === normalizeName(deps.self())) return undefined;
    const files = { ...policy.files, directIm: policy.files.directIm && deps.directIm !== undefined, sendFile: policy.files.sendFile && deps.files !== undefined };
    return { role, files };
  };

  const send = async (p: Parameters<MediaSender['sendMediaTo']>[0]): Promise<void> => {
    const urls = p.urls.filter((url) => typeof url === 'string' && url.trim() !== '');
    if (urls.length === 0) return;
    const checked = checkTarget({ cfg: deps.getCfg(), accountId: deps.accountId, to: p.to });
    if (!checked.ok) {
      deps.log.info('no file goes to this target', { to: p.to });
      return;
    }
    if (checked.target.kind === 'room') {
      if (!stopped) deps.roomNote(checked.target.room, 'off');
      return;
    }
    const to = normalizeName(checked.target.name);
    const first = allowed(to);
    if (!first) {
      deps.log.info('no file goes to this name', { to });
      return;
    }
    const { role, files } = first;
    if (!files.directIm && !files.sendFile) {
      note(to, 'off');
      return;
    }
    const rt = getRuntime(deps.accountId);
    const online = rt !== undefined && !rt.halted && rt.session.getState().phase === 'online';
    if (!online || deps.presenceOf(to)?.online === false) {
      failed(to, urls);
      return;
    }
    if (urls.length > FILES_LIMITS.perSend) note(to, 'too-many');

    const pictures: { url: string; picture: Picture }[] = [];
    const others: { url: string; file: OutFile }[] = [];
    for (const url of urls.slice(0, FILES_LIMITS.perSend)) {
      const got = await loadOutgoing({
        url, cfg: p.cfg, role, maxBytes: files.maxBytes, log: deps.log,
        ...(p.agentId !== undefined ? { agentId: p.agentId } : {}),
        ...(role === 'owner' && p.host ? { host: p.host } : {}),
      });
      if (stopped) return;
      if (!got.ok) {
        if (got.why === 'too-large') note(to, 'too-large');
        else note(to, 'failed', linkOf(url));
        continue;
      }
      const found = classify(got.bytes, got.name);
      const route = routeOf(found.kind, files);
      if (route === 'off') note(to, 'off');
      else if (route === 'direct-im' && found.kind === 'picture') pictures.push({ url, picture: found.picture });
      else others.push({ url, file: found.kind === 'picture' ? { name: found.picture.name, bytes: found.picture.bytes } : found.file });
    }
    // The lists may have changed while the files loaded.
    if (!allowed(to)) return;

    // No line goes to a person who was taken off the lists while the send waited.
    const ended = (list: { url: string }[]) => (outcome: SendOutcome): void => {
      if (outcome !== 'done' && allowed(to)) failed(to, list.map((item) => item.url));
    };
    if (pictures.length > 0) {
      const taken = deps.directIm?.send(to, pictures.map((item) => item.picture), ended(pictures));
      if (taken === 'too-many') note(to, 'too-many');
    }
    if (others.length > 0) {
      const offered = deps.files?.offer(to, others.map((item) => item.file), ended(others), () => allowed(to)?.files.sendFile === true);
      if (offered === 'too-many') note(to, 'too-many');
    }
  };

  return {
    async sendMediaTo(p): Promise<void> {
      if (stopped) return;
      try {
        await send(p);
      } catch (err) {
        deps.log.warn('a file was not sent', { to: p.to, error: err instanceof Error ? err.message : String(err) });
      }
    },
    stop(): void {
      stopped = true;
      deps.files?.stop();
    },
  };
}
