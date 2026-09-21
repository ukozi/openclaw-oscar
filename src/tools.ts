import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/channel-core';
import type { AnyAgentTool, OpenClawPluginToolContext } from 'openclaw/plugin-sdk/core';
import { CHANNEL_ID, TOOL_NAMES } from './config.js';

export type ToolName = (typeof TOOL_NAMES)[number];
export type ToolBuilder = (ctx: OpenClawPluginToolContext) => AnyAgentTool | null;

const builders = new Map<ToolName, ToolBuilder>();

export function installTool(name: ToolName, build: ToolBuilder): void {
  builders.set(name, build);
}

export function jsonSchema(schema: Record<string, unknown>): AnyAgentTool['parameters'] {
  return schema as unknown as AnyAgentTool['parameters'];
}

export function registerOscarTools(api: { registerTool: OpenClawPluginApi['registerTool'] }): void {
  for (const name of TOOL_NAMES) {
    api.registerTool((ctx: OpenClawPluginToolContext) => {
      if (ctx.messageChannel !== undefined && ctx.messageChannel !== CHANNEL_ID) return null;
      return builders.get(name)?.(ctx) ?? null;
    }, { names: [name] });
  }
}

export function resetToolsForTests(): void {
  builders.clear();
}
