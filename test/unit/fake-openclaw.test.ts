import { describe, expect, it } from 'vitest';
import { createFakeAgentApi } from '../fake/openclaw.js';

describe('fake agent api', () => {
  it('delivers lifecycle events to matching subscriptions as copies', async () => {
    const fake = createFakeAgentApi();
    const got: unknown[] = [];
    fake.api.agent.events.registerAgentEventSubscription({ id: 'a', streams: ['lifecycle'], handle: (event) => void got.push(event) });
    fake.api.agent.events.registerAgentEventSubscription({ id: 'b', streams: ['tool'], handle: (event) => void got.push(event) });
    await fake.emitLifecycle('r1', 'start', 'agent:main:oscar:group:botone/alice');
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ runId: 'r1', seq: 1, stream: 'lifecycle', data: { phase: 'start' }, sessionKey: 'agent:main:oscar:group:botone/alice' });
    expect(fake.subscriptionIds()).toEqual(['a', 'b']);
  });

  it('fires hooks with the event and context shapes core uses', async () => {
    const fake = createFakeAgentApi();
    const seen: unknown[] = [];
    fake.api.on('before_tool_call', (event, ctx) => void seen.push(['before', event.toolName, event.params, event.runId, ctx.sessionKey, event.toolCallId]));
    fake.api.on('after_tool_call', (event, ctx) => void seen.push(['after', event.toolName, ctx.runId, event.toolCallId]));
    fake.api.on('before_prompt_build', (_event, ctx) => void seen.push(['prompt', ctx.runId, ctx.trigger]));
    fake.api.on('model_call_started', (event, ctx) => void seen.push(['model', event.runId, ctx.trigger]));
    fake.api.on('subagent_spawned', (event, ctx) => void seen.push(['spawn', event.childSessionKey, ctx.requesterSessionKey]));
    fake.api.on('subagent_ended', (event) => void seen.push(['ended', event.targetSessionKey]));
    const call = { toolName: 'exec', params: { command: 'ls' }, runId: 'r1', sessionKey: 's1', toolCallId: 't1' };
    await fake.startTool(call);
    await fake.finishTool(call);
    await fake.promptBuild('r1', 's1', 'heartbeat');
    await fake.modelCall('r1', 's1');
    await fake.subagentSpawned('child', 's1');
    await fake.subagentEnded('child');
    expect(seen).toEqual([
      ['before', 'exec', { command: 'ls' }, 'r1', 's1', 't1'],
      ['after', 'exec', 'r1', 't1'],
      ['prompt', 'r1', 'heartbeat'],
      ['model', 'r1', undefined],
      ['spawn', 'child', 's1'],
      ['ended', 'child'],
    ]);
    expect(fake.hookNames()).toEqual(['after_tool_call', 'before_prompt_build', 'before_tool_call', 'model_call_started', 'subagent_ended', 'subagent_spawned']);
  });

  it('runs a registered tool between its two hooks', async () => {
    const fake = createFakeAgentApi();
    const order: string[] = [];
    fake.api.on('before_tool_call', () => void order.push('before'));
    fake.api.on('after_tool_call', () => void order.push('after'));
    fake.api.registerTool(
      (ctx) => ({
        name: 'echo', label: 'Echo', description: 'echo', parameters: { type: 'object' },
        async execute(toolCallId, params) {
          order.push('execute');
          return { content: [{ type: 'text', text: `${toolCallId}:${ctx.agentAccountId}` }], details: params };
        },
      }),
      { names: ['echo'] },
    );
    const result = await fake.callTool(
      { toolName: 'echo', params: { a: 1 }, runId: 'r1', sessionKey: 's1', toolCallId: 't9' },
      { agentAccountId: 'botone' },
    );
    expect(result.content).toEqual([{ type: 'text', text: 't9:botone' }]);
    expect(order).toEqual(['before', 'execute', 'after']);
    await expect(fake.callTool({ toolName: 'nope', params: {}, runId: 'r1', sessionKey: 's1' }, {})).rejects.toThrow('no tool named nope');
  });

  it('records llm calls and returns the scripted text', async () => {
    const fake = createFakeAgentApi({ complete: async () => 'Drafting a reply' });
    const result = await fake.api.runtime.llm.complete({ messages: [{ role: 'user', content: 'hi' }], purpose: 'test' });
    expect(result.text).toBe('Drafting a reply');
    expect(fake.llmCalls).toHaveLength(1);
  });
});
