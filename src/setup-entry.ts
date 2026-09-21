import { defineSetupPluginEntry } from 'openclaw/plugin-sdk/channel-core';
import { oscarPlugin } from './channel.js';

const setupEntry: { plugin: typeof oscarPlugin } = defineSetupPluginEntry(oscarPlugin);

export default setupEntry;
