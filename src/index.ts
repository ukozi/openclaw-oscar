import { defineChannelPluginEntry } from 'openclaw/plugin-sdk/channel-core';
import { CHANNEL_ID, oscarPlugin } from './channel.js';

const entry: ReturnType<typeof defineChannelPluginEntry<typeof oscarPlugin>> = defineChannelPluginEntry({
  id: CHANNEL_ID,
  name: 'OSCAR',
  description: 'Native OSCAR channel for Open OSCAR Server.',
  plugin: oscarPlugin,
});

export default entry;
