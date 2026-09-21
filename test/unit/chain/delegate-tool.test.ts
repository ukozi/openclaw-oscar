import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChainController } from '../../../src/chain/controller.js';
import type { OscarSession } from '../../../src/oscar/index.js';
import { clearRuntime, setRuntime } from '../../../src/runtime.js';
import { DELEGATE_TOOL, createDelegateTool, registerOscarTools } from '../../../src/tools.js';
import { ROOM } from './fixtures.js';

function install(delegate: ChainController['delegate'] | null) {
  setRuntime({
    accountId: 'botone',
    session: {} as OscarSession,
    rooms: new Map(),
    lastReplyAt: new Map(),
    counters: { droppedSends: 0, eventGaps: 0 },
    sessionKeys: new Map([
      ['sk-room', { accountId: 'botone', peer: { kind: 'room', bot: 'botone', room: ROOM } }],
      ['sk-im', { accountId: 'botone', peer: { kind: 'im', bot: 'botone', peer: 'alice' } }],
    ]),
    ...(delegate ? { chain: { delegate } as unknown as ChainController } : {}),
  });
}

afterEach(() => clearRuntime('botone'));

describe('oscar_delegate', () => {
  it('hands the call to the controller with the room and the trusted requester', async () => {
    const delegate = vi.fn(async () => 'handed to bottwo as 1-k7f3');
    install(delegate);
    const tool = createDelegateTool({ sessionKey: 'sk-room', requesterSenderId: 'alice' });
    const result = await tool.execute('call-1', { to: 'bottwo', task: 'tighten the intro' });
    expect(delegate).toHaveBeenCalledWith({ roomKey: 'room:4:testroom', requester: 'alice', to: 'bottwo', task: 'tighten the intro' });
    expect(result.content).toEqual([{ type: 'text', text: 'handed to bottwo as 1-k7f3' }]);
  });

  it.each([
    ['an IM session', 'sk-im'],
    ['an unknown session', 'sk-other'],
    ['no session', undefined],
  ])('refuses from %s', async (_label, sessionKey) => {
    install(vi.fn());
    const tool = createDelegateTool({ sessionKey, requesterSenderId: 'alice' });
    await expect(tool.execute('call-1', { to: 'bottwo', task: 'x' })).rejects.toThrow('hand-offs only work in a room; tell the owner');
  });

  it('refuses when the chain is not running', async () => {
    install(null);
    await expect(createDelegateTool({ sessionKey: 'sk-room' }).execute('c', { to: 'bottwo', task: 'x' })).rejects.toThrow('hand-offs only work in a room');
  });

  it('passes a refusal on as the tool error', async () => {
    install(vi.fn(async () => { throw new Error('too many hops'); }));
    await expect(createDelegateTool({ sessionKey: 'sk-room' }).execute('c', { to: 'bottwo', task: 'x' })).rejects.toThrow('too many hops');
  });

  it('coerces odd parameters to strings', async () => {
    const delegate = vi.fn(async () => 'ok');
    install(delegate);
    await createDelegateTool({ sessionKey: 'sk-room' }).execute('c', { to: 7, task: undefined });
    expect(delegate).toHaveBeenCalledWith({ roomKey: 'room:4:testroom', requester: undefined, to: '7', task: '' });
  });

  it('is a fresh object per call with a fixed name', () => {
    const a = createDelegateTool({});
    const b = createDelegateTool({});
    expect(a).not.toBe(b);
    expect(a.name).toBe(DELEGATE_TOOL);
    expect(a.description).toContain('not a subagent');
  });

  it('is the builder behind the registered name', () => {
    const registered: { factory: (ctx: Record<string, unknown>) => unknown; names?: string[] }[] = [];
    registerOscarTools({
      registerTool: (factory: unknown, opts?: { names?: string[] }) => {
        registered.push({ factory: factory as (ctx: Record<string, unknown>) => unknown, names: opts?.names });
      },
    } as never);
    const factory = registered.find((r) => r.names?.[0] === DELEGATE_TOOL)?.factory;
    expect(factory).toBeTypeOf('function');
    const built = factory?.({ messageChannel: 'oscar', sessionKey: 'sk-room' }) as { name?: string } | null;
    expect(built?.name).toBe(DELEGATE_TOOL);
    expect(factory?.({ messageChannel: 'slack' })).toBeNull();
  });

  it('is declared in the manifest', () => {
    const manifest = JSON.parse(readFileSync('openclaw.plugin.json', 'utf8')) as { contracts?: { tools?: string[] } };
    expect(manifest.contracts?.tools).toContain('oscar_delegate');
  });
});
