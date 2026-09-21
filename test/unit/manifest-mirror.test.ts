import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CHANNEL_ID, PLUGIN_ID, TOOL_NAMES, UI_HINTS, oscarChannelConfigSchema } from '../../src/config.js';

const manifest = JSON.parse(readFileSync(new URL('../../openclaw.plugin.json', import.meta.url), 'utf8')) as {
  id: string; channels?: string[]; version?: string; channelEnvVars?: unknown;
  contracts?: { tools?: string[] };
  channelConfigs?: Record<string, { schema?: unknown; uiHints?: Record<string, { sensitive?: boolean }> }>;
};

describe('manifest', () => {
  it('has the plugin and channel ids the code uses', () => {
    expect(manifest.id).toBe(PLUGIN_ID);
    expect(manifest.channels).toEqual([CHANNEL_ID]);
  });

  it('mirrors the exported channel schema', () => {
    expect(manifest.channelConfigs?.[CHANNEL_ID]?.schema).toEqual(JSON.parse(JSON.stringify(oscarChannelConfigSchema.schema)));
  });

  it('mirrors the ui hints and marks the password sensitive', () => {
    expect(manifest.channelConfigs?.[CHANNEL_ID]?.uiHints).toEqual(UI_HINTS);
    expect(manifest.channelConfigs?.[CHANNEL_ID]?.uiHints?.password?.sensitive).toBe(true);
  });

  it('declares every tool name', () => {
    expect([...(manifest.contracts?.tools ?? [])].sort()).toEqual([...TOOL_NAMES].sort());
  });

  it('declares no env vars and no version', () => {
    expect(manifest.channelEnvVars).toBeUndefined();
    expect(manifest.version).toBeUndefined();
  });
});
