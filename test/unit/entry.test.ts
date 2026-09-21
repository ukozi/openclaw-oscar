import { describe, expect, it, vi } from 'vitest';
import type { OpenClawConfig, OpenClawPluginApi } from 'openclaw/plugin-sdk/channel-core';
import { CHANNEL_ID, oscarPlugin } from '../../src/channel.js';
import entry from '../../src/index.js';
import setupEntry from '../../src/setup-entry.js';

type Mode = OpenClawPluginApi['registrationMode'];

function fakeApi(mode: Mode) {
  const registerChannel = vi.fn();
  const api = { registrationMode: mode, registerChannel, runtime: {} } as unknown as OpenClawPluginApi;
  return { api, registerChannel };
}

describe('entry', () => {
  it('uses the channel id as the plugin id', () => {
    expect(CHANNEL_ID).toBe('oscar');
    expect(entry.id).toBe('oscar');
    expect(entry.channelPlugin).toBe(oscarPlugin);
  });

  it.each<[Mode, number]>([
    ['full', 1],
    ['discovery', 1],
    ['setup-only', 1],
    ['setup-runtime', 1],
    ['tool-discovery', 0],
    ['cli-metadata', 0],
  ])('in %s mode registers the channel %i time(s)', (mode, times) => {
    const { api, registerChannel } = fakeApi(mode);
    entry.register(api);
    expect(registerChannel).toHaveBeenCalledTimes(times);
    if (times > 0) expect(registerChannel).toHaveBeenCalledWith({ plugin: oscarPlugin });
  });

  it('setup entry exposes the same plugin object', () => {
    expect(setupEntry.plugin).toBe(oscarPlugin);
  });
});

describe('empty channel', () => {
  const cfg = { channels: { oscar: { screenName: 'botone' } } } as unknown as OpenClawConfig;

  it('lists no accounts even when the config has a block', () => {
    expect(oscarPlugin.config.listAccountIds(cfg)).toEqual([]);
  });

  it.each<[string | null | undefined, string]>([
    [undefined, 'default'],
    [null, 'default'],
    ['botone', 'botone'],
  ])('resolves account id %s to a disabled account named %s', (given, accountId) => {
    expect(oscarPlugin.config.resolveAccount(cfg, given)).toEqual({ accountId, enabled: false, configured: false });
  });

  it('carries every metadata field the host fills in with a warning when missing', () => {
    const { meta } = oscarPlugin;
    expect(meta.id).toBe(oscarPlugin.id);
    for (const value of [meta.label, meta.selectionLabel, meta.docsPath, meta.blurb]) {
      expect(typeof value).toBe('string');
      expect(value.trim().length).toBeGreaterThan(0);
    }
  });

  it('declares direct and group chats and no rich features', () => {
    expect(oscarPlugin.capabilities).toEqual({
      chatTypes: ['direct', 'group'],
      media: false,
      reactions: false,
      reply: false,
      threads: false,
      polls: false,
      edit: false,
      unsend: false,
    });
  });

  it('asks for a restart when channels.oscar changes', () => {
    expect(oscarPlugin.reload).toEqual({ configPrefixes: ['channels.oscar'] });
  });

  it('has no gateway adapter yet, so the host starts nothing', () => {
    expect(oscarPlugin.gateway).toBeUndefined();
  });
});
