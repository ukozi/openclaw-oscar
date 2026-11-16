import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('openclaw/plugin-sdk/media-store', async () => (await import('../../fake/openclaw.js')).mediaStore);

import { saveInbound } from '../../../src/inbound/media-store.js';
import { sdk } from '../../fake/openclaw.js';

beforeEach(() => sdk.reset());

describe('saveInbound', () => {
  it('saves under inbound with the limit and the cleaned name', async () => {
    const bytes = Uint8Array.of(1, 2, 3);
    const saved = await saveInbound({ bytes, contentType: 'image/png', name: '..\\pics\\cat.png', maxBytes: 4096 });
    expect(sdk.media).toHaveLength(1);
    const call = sdk.media[0];
    expect(call).toMatchObject({ contentType: 'image/png', subdir: 'inbound', maxBytes: 4096, originalFilename: 'cat.png' });
    expect(Buffer.isBuffer(call?.buffer)).toBe(true);
    expect([...(call?.buffer ?? [])]).toEqual([1, 2, 3]);
    expect(saved).toEqual({ path: call?.path });
  });

  it('passes on the refusal of the store', async () => {
    await expect(saveInbound({ bytes: new Uint8Array(8), contentType: 'image/png', name: 'a.png', maxBytes: 4 })).rejects.toThrow();
    expect(sdk.media).toEqual([]);
  });
});
