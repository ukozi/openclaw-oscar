import type { ChannelPlugin } from 'openclaw/plugin-sdk/channel-core';

export const CHANNEL_ID = 'oscar';

export type ScaffoldAccount = { accountId: string; enabled: boolean; configured: boolean };

export const oscarPlugin: ChannelPlugin<ScaffoldAccount> = {
  id: CHANNEL_ID,
  meta: {
    id: CHANNEL_ID,
    label: 'OSCAR',
    selectionLabel: 'OSCAR (Open OSCAR Server)',
    docsPath: '/channels/oscar',
    blurb: 'Native OSCAR messaging through an Open OSCAR Server.',
  },
  capabilities: {
    chatTypes: ['direct', 'group'],
    media: false,
    reactions: false,
    reply: false,
    threads: false,
    polls: false,
    edit: false,
    unsend: false,
  },
  reload: { configPrefixes: ['channels.oscar'] },
  config: {
    listAccountIds: () => [],
    resolveAccount: (_cfg, accountId) => ({ accountId: accountId ?? 'default', enabled: false, configured: false }),
    isConfigured: () => false,
  },
};
