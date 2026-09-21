import { beforeEach, describe, expect, it } from 'vitest';
import { TOOL_NAMES } from '../../src/config.js';
import { installTool, jsonSchema, registerOscarTools, resetToolsForTests } from '../../src/tools.js';

type Factory = (ctx: Record<string, unknown>) => unknown;
const registered: { factory: Factory; opts?: { names?: string[] } }[] = [];
const api = { registerTool: (factory: unknown, opts?: { names?: string[] }) => { registered.push({ factory: factory as Factory, opts }); } };
const factoryFor = (name: string) => registered.find((r) => r.opts?.names?.[0] === name)?.factory as Factory;

beforeEach(() => {
  registered.length = 0;
  resetToolsForTests();
  registerOscarTools(api as never);
});

describe('tools', () => {
  it('registers one named factory per tool', () => {
    expect(registered.map((r) => r.opts?.names)).toEqual(TOOL_NAMES.map((n) => [n]));
    for (const r of registered) expect(typeof r.factory).toBe('function');
  });

  it('answers null until a builder is installed', () => {
    for (const name of TOOL_NAMES) expect(factoryFor(name)({ messageChannel: 'oscar' })).toBeNull();
  });

  it('builds a fresh tool per call once installed and only for this channel', () => {
    installTool('oscar_status', (ctx) => ({
      name: 'oscar_status', label: 'Status line', description: 'Set the status line.',
      parameters: jsonSchema({ type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }),
      execute: async () => ({ content: [{ type: 'text' as const, text: String(ctx.agentAccountId) }], details: {} }),
    }));
    const factory = factoryFor('oscar_status');
    const a = factory({ messageChannel: 'oscar', agentAccountId: 'botone' });
    const b = factory({ messageChannel: 'oscar', agentAccountId: 'botone' });
    expect(a).toMatchObject({ name: 'oscar_status' });
    expect(a).not.toBe(b);
    expect(factory({ messageChannel: 'slack' })).toBeNull();
    expect(factory({})).toMatchObject({ name: 'oscar_status' });
    expect(factoryFor('oscar_room')({ messageChannel: 'oscar' })).toBeNull();
  });
});
