import type { FilesPolicy } from '../config.js';
import { FILES_LIMITS } from '../inbound/media-gate.js';
import { baseName, sniff } from '../inbound/sniff.js';
import { sniffImage } from '../oscar/index.js';

export type Picture = { name: string; bytes: Uint8Array; width: number; height: number };
export type OutFile = { name: string; bytes: Uint8Array };
export type Planned = { pictures: Picture[]; files: OutFile[]; left: number };
export type Route = 'direct-im' | 'send-file' | 'off';

// A picture must pass the inbound check and have a size the client library can read.
export function classify(bytes: Uint8Array, name: string): { kind: 'picture'; picture: Picture } | { kind: 'file'; file: OutFile } {
  const clean = baseName(name);
  const found = sniff(bytes, clean);
  const size = found.kind === 'image' ? sniffImage(bytes) : null;
  if (size === null) return { kind: 'file', file: { name: clean, bytes } };
  return { kind: 'picture', picture: { name: clean, bytes, width: size.width, height: size.height } };
}

export function routeOf(kind: 'picture' | 'file', files: FilesPolicy): Route {
  if (kind === 'picture' && files.directIm) return 'direct-im';
  return files.sendFile ? 'send-file' : 'off';
}

export function planSend(items: { bytes: Uint8Array; name: string }[], files: FilesPolicy): Planned {
  const plan: Planned = { pictures: [], files: [], left: Math.max(0, items.length - FILES_LIMITS.perSend) };
  for (const item of items.slice(0, FILES_LIMITS.perSend)) {
    const found = classify(item.bytes, item.name);
    const route = routeOf(found.kind, files);
    if (route === 'direct-im' && found.kind === 'picture') plan.pictures.push(found.picture);
    else if (route === 'send-file') plan.files.push(found.kind === 'picture' ? { name: found.picture.name, bytes: found.picture.bytes } : found.file);
  }
  return plan;
}
