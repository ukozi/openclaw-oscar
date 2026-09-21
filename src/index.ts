import { defineChannelPluginEntry } from 'openclaw/plugin-sdk/channel-core';
import { oscarPlugin } from './channel.js';
import { PLUGIN_ID, TOOL_NAMES } from './config.js';
import { setHost } from './runtime.js';
import { registerOscarTools } from './tools.js';

const entry: ReturnType<typeof defineChannelPluginEntry<typeof oscarPlugin>> = defineChannelPluginEntry({
  id: PLUGIN_ID,
  name: 'OSCAR',
  description: 'Native OSCAR channel for an Open OSCAR Server.',
  plugin: oscarPlugin,
  setRuntime: (runtime) => setHost(runtime),
  registerFull(api) {
    registerOscarTools(api);
    // registerFull also runs in tool-discovery, where there is no channel runtime.
    if (api.registrationMode !== 'full') return;
    api.logger.info(`${PLUGIN_ID}: channel and ${TOOL_NAMES.length} tool names registered`);
  },
});

export default entry;
