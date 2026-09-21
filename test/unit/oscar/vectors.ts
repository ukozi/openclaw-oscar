import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fromHex } from '../../../src/oscar/bytes.js';

export type Vector = { name: string; hex: string; note?: string; inputs?: Record<string, string> };
export type VectorFile = { source: string; vectors: Vector[] };

export function loadVectors(file: string): VectorFile {
  const path = fileURLToPath(new URL(`../../vectors/${file}`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as VectorFile;
}

export function vector(file: VectorFile, name: string): Vector {
  const found = file.vectors.find((v) => v.name === name);
  if (!found) throw new Error(`no vector named "${name}"`);
  return found;
}

export function bytesOf(file: VectorFile, name: string): Uint8Array {
  return fromHex(vector(file, name).hex);
}
