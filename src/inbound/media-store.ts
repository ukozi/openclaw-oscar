import { saveMediaBuffer } from 'openclaw/plugin-sdk/media-store';
import { baseName } from './sniff.js';

export async function saveInbound(p: { bytes: Uint8Array; contentType: string; name: string; maxBytes: number }): Promise<{ path: string }> {
  const saved = await saveMediaBuffer(Buffer.from(p.bytes), p.contentType, 'inbound', p.maxBytes, baseName(p.name));
  return { path: saved.path };
}
