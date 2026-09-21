import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readPolicy, resolveAccount, type AwayConfig } from '../../src/config.js';
import { createAwayController, type AwayController } from '../../src/presence/away.js';
import { forbiddenNames } from '../../src/presence/blurb.js';
import {
  createOscarStatusTool, createSummarizer, hostConfig, imPeerFor, originOf, presenceActions, presenceDispatch, presenceToolHints,
  registerPresence, startPresence, summarizeViaHost,
} from '../../src/presence/register.js';
import { RUN_QUIET_MS, TOOL_CAP_MS, createRunTracker } from '../../src/presence/runs.js';
import { resetRuntimeForTests, setRuntime } from '../../src/runtime.js';
import { channelLifecycleMock, createFakeAgentApi } from '../fake/openclaw.js';
import { FakeSession } from '../fake/session.js';
import { quietLog, stubSession } from '../fake/stub-session.js';

const IM = 'agent:main:oscar:group:botone/alice';
const ROOM = 'agent:main:oscar:group:botone#4.testroom';
const OTHER = 'agent:main:discord:group:12345';
const DEFAULT = 'Working on something. Back in a bit.';
const MINUTE = 60_000;

function world(overrides: Partial<AwayConfig> = {}, complete?: () => Promise<string>) {
  const away: AwayConfig = { enabled: true, message: DEFAULT, blurb: 'agent', graceMs: 2000, maxLength: 100, replyCooldownMinutes: 10, ...overrides };
  const cfg = {
    channels: {
      oscar: {
        enabled: true, host: 'oscar.example.net', port: 5190,
        owners: ['alice'], allowFrom: ['alice', 'bob'],
        accounts: { botone: { screenName: 'botone', password: 'hunter22', away } },
        defaultAccount: 'botone',
      },
    },
  };
  const tracker = createRunTracker();
  const fake = createFakeAgentApi({ complete, config: () => cfg });
  const stub = stubSession();
  const controllers = new Map<string, AwayController>();
  const wiring = { tracker, controllerFor: (id: string) => controllers.get(id) };
  controllers.set('botone', createAwayController({
    accountId: 'botone', tracker, session: stub.session,
    config: () => resolveAccount(cfg, 'botone').away,
    forbidden: () => forbiddenNames(readPolicy(cfg)),
    summarize: createSummarizer(fake.api.runtime), log: quietLog,
  }));
  registerPresence(fake.api, wiring);
  const dispatch = (sessionKey: string, text = 'hello') =>
    presenceDispatch({ sessionKey, accountId: 'botone', origin: 'owner', text }, wiring);
  return { away, cfg, tracker, fake, stub, wiring, dispatch };
}

async function tick(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
  resetRuntimeForTests();
});

describe('away line', () => {
  it('goes up after the grace period and comes down within a second of the run ending', async () => {
    const { fake, stub, dispatch } = world();
    dispatch(IM).onAgentRunStart('r1');
    await fake.emitLifecycle('r1', 'start', IM);
    await tick(1999);
    expect(stub.calls).toEqual([]);
    await tick(1);
    expect(stub.calls).toEqual([DEFAULT]);
    await tick(60_000);
    const endedAt = Date.now();
    await fake.emitLifecycle('r1', 'end', IM);
    await tick(0);
    expect(stub.calls).toEqual([DEFAULT, null]);
    expect(stub.callTimes[1]! - endedAt).toBeLessThan(1000);
  });

  it('sends ASCII no longer than maxLength', async () => {
    const { fake, stub, dispatch } = world({ message: 'Très occupé — back in a little while, promise', maxLength: 20 });
    dispatch(IM);
    await fake.emitLifecycle('r1', 'start', IM);
    await tick(2000);
    const text = stub.calls[0]!;
    expect(text).toBe('Tres occupe - back');
    expect(/^[\x20-\x7E]+$/.test(text)).toBe(true);
  });

  it('stays up while either of two conversations is still running', async () => {
    const { fake, stub, dispatch } = world();
    dispatch(IM);
    dispatch(ROOM);
    await fake.emitLifecycle('r1', 'start', IM);
    await fake.emitLifecycle('r2', 'start', ROOM);
    await tick(2000);
    await fake.emitLifecycle('r1', 'end', IM);
    await tick(5000);
    expect(stub.calls).toEqual([DEFAULT]);
    await fake.emitLifecycle('r2', 'error', ROOM);
    await tick(0);
    expect(stub.calls).toEqual([DEFAULT, null]);
  });

  it('counts a queued follow-up run that core starts without telling the channel', async () => {
    const { fake, stub, dispatch } = world();
    dispatch(IM).onAgentRunStart('r1');
    await fake.emitLifecycle('r1', 'start', IM);
    await fake.emitLifecycle('r1', 'start', IM);
    await fake.emitLifecycle('r1', 'finishing', IM);
    await fake.emitLifecycle('r1', 'end', IM);
    await fake.emitLifecycle('r2', 'start', IM);
    await tick(2000);
    expect(stub.calls).toEqual([DEFAULT]);
    await fake.emitLifecycle('r2', 'end', IM);
    await tick(0);
    expect(stub.calls).toEqual([DEFAULT, null]);
  });

  it('is not away after a restart that lost a run mid-flight', async () => {
    const first = world();
    first.dispatch(IM);
    await first.fake.emitLifecycle('r1', 'start', IM);
    await tick(2000);
    expect(first.stub.calls).toEqual([DEFAULT]);
    const second = world();
    second.stub.signOn();
    await tick(RUN_QUIET_MS);
    expect(second.tracker.isBusy('botone')).toBe(false);
    expect(second.stub.calls).toEqual([]);
  });

  it('still sets a line when every tool is hidden from the agent', async () => {
    const { fake, stub, dispatch } = world();
    dispatch(IM);
    await fake.emitLifecycle('r1', 'start', IM);
    await fake.promptBuild('r1', IM, 'user');
    await fake.modelCall('r1', IM);
    await tick(2000);
    expect(stub.calls).toEqual([DEFAULT]);
  });

  it('shows a phrase for the kind of tool in use when only the message tool is hidden', async () => {
    const { fake, stub, dispatch } = world();
    dispatch(IM);
    await fake.emitLifecycle('r1', 'start', IM);
    const call = { toolName: 'exec', params: { command: 'make' }, runId: 'r1', sessionKey: IM };
    const toolCallId = await fake.startTool(call);
    await tick(2000);
    await fake.finishTool({ ...call, toolCallId });
    expect(stub.calls).toEqual(['Running some commands']);
  });

  it('takes the agent line from set-presence', async () => {
    const { fake, stub, dispatch } = world();
    dispatch(IM);
    await fake.emitLifecycle('r1', 'start', IM);
    await fake.startTool({ toolName: 'message', params: { action: 'set-presence', awayMessage: 'Tidying up a <b>report</b>' }, runId: 'r1', sessionKey: IM });
    await tick(2000);
    expect(stub.calls).toEqual(['Tidying up a report']);
  });

  it('replaces a path-like line with the phrase', async () => {
    const { fake, stub, dispatch } = world();
    dispatch(IM);
    await fake.emitLifecycle('r1', 'start', IM);
    await fake.startTool({ toolName: 'read', params: { path: '/srv/app/config.yml' }, runId: 'r1', sessionKey: IM });
    await fake.startTool({ toolName: 'message', params: { action: 'set-presence', awayMessage: 'Reading /srv/app/config.yml' }, runId: 'r1', sessionKey: IM });
    await tick(2000);
    expect(stub.calls).toEqual(['Working in some files']);
  });

  it('ignores set-presence aimed at another channel and ordinary sends', async () => {
    const { fake, stub, dispatch } = world();
    dispatch(IM);
    await fake.emitLifecycle('r1', 'start', IM);
    await fake.startTool({ toolName: 'message', params: { action: 'set-presence', channel: 'discord', awayMessage: 'Gaming' }, runId: 'r1', sessionKey: IM });
    await fake.startTool({ toolName: 'message', params: { action: 'send', to: 'alice', message: 'hi', awayMessage: 'Sneaky' }, runId: 'r1', sessionKey: IM });
    await tick(2000);
    expect(stub.calls).toEqual([DEFAULT]);
  });

  it('takes the agent line from oscar_status and reports the outcome', async () => {
    const { fake, stub, wiring, dispatch } = world();
    fake.api.registerTool((ctx) => createOscarStatusTool(ctx, wiring), { names: ['oscar_status'] });
    dispatch(IM);
    await fake.emitLifecycle('r1', 'start', IM);
    const toolCtx = { agentAccountId: 'botone', sessionKey: IM };
    const ok = await fake.callTool({ toolName: 'oscar_status', params: { text: 'Sorting notes' }, runId: 'r1', sessionKey: IM }, toolCtx);
    expect(ok.details).toEqual({ ok: true, status: 'Sorting notes' });
    const bad = await fake.callTool({ toolName: 'oscar_status', params: { text: 'Mailing bob@example.net' }, runId: 'r1', sessionKey: IM }, toolCtx);
    expect(bad.details).toMatchObject({ ok: false });
    await fake.callTool({ toolName: 'oscar_status', params: { text: 'Second line' }, runId: 'r1', sessionKey: IM }, toolCtx);
    const third = await fake.callTool({ toolName: 'oscar_status', params: { text: 'Third line' }, runId: 'r1', sessionKey: IM }, toolCtx);
    expect(third.details).toMatchObject({ ok: false, note: expect.stringContaining('twice') });
    await tick(2000);
    expect(stub.calls).toEqual(['Second line']);
  });

  it('oscar_status works without the tool hook and fails cleanly when signed off', async () => {
    const { tracker, wiring, dispatch } = world();
    dispatch(IM);
    tracker.seen('r1', IM);
    const tool = createOscarStatusTool({ agentAccountId: 'botone', sessionKey: IM }, wiring);
    const result = await tool.execute('t1', { text: 'Sorting notes' } as never);
    expect(result.details).toEqual({ ok: true, status: 'Sorting notes' });
    await expect(tool.execute('t2', { text: '  ' } as never)).rejects.toThrow('text is required');
    const signedOff = createOscarStatusTool({ agentAccountId: 'bottwo', sessionKey: IM }, wiring);
    await expect(signedOff.execute('t3', { text: 'Sorting notes' } as never)).rejects.toThrow('not signed on');
  });

  it.each(['heartbeat', 'cron'])('ignores a %s run on a tracked session', async (trigger) => {
    const { fake, stub, tracker, dispatch } = world();
    dispatch(IM);
    await fake.emitLifecycle('r1', 'start', IM);
    await fake.promptBuild('r1', IM, trigger);
    await fake.modelCall('r1', IM);
    await fake.startTool({ toolName: 'exec', params: {}, runId: 'r1', sessionKey: IM });
    await tick(10_000);
    expect(tracker.isBusy('botone')).toBe(false);
    expect(stub.calls).toEqual([]);
  });

  it('reads the trigger from model_call_started on hosts that send it there', async () => {
    const { fake, tracker, dispatch } = world();
    dispatch(IM);
    await fake.emitLifecycle('r1', 'start', IM);
    await fake.modelCall('r1', IM, 'heartbeat');
    expect(tracker.isBusy('botone')).toBe(false);
  });

  it('ignores runs of other channels', async () => {
    const { fake, stub, dispatch } = world();
    dispatch(IM);
    await fake.emitLifecycle('x1', 'start', OTHER);
    await fake.modelCall('x1', OTHER);
    await fake.startTool({ toolName: 'exec', params: {}, runId: 'x1', sessionKey: OTHER });
    await tick(10_000);
    expect(stub.calls).toEqual([]);
  });

  it('keeps the line through a ninety minute tool call', async () => {
    const { fake, stub, dispatch } = world();
    dispatch(IM);
    await fake.emitLifecycle('r1', 'start', IM);
    const call = { toolName: 'exec', params: { command: 'make world' }, runId: 'r1', sessionKey: IM };
    const toolCallId = await fake.startTool(call);
    await tick(90 * MINUTE);
    expect(stub.calls).toEqual(['Running some commands']);
    await fake.finishTool({ ...call, toolCallId });
    await fake.emitLifecycle('r1', 'end', IM);
    await tick(0);
    expect(stub.calls).toEqual(['Running some commands', null]);
  });

  it('drops a wedged run after fifteen minutes and a stuck tool call after two hours', async () => {
    const a = world();
    a.dispatch(IM);
    await a.fake.emitLifecycle('r1', 'start', IM);
    await tick(RUN_QUIET_MS + MINUTE);
    expect(a.stub.calls).toEqual([DEFAULT, null]);
    const b = world();
    b.dispatch(IM);
    await b.fake.emitLifecycle('r1', 'start', IM);
    await b.fake.startTool({ toolName: 'exec', params: {}, runId: 'r1', sessionKey: IM });
    await tick(TOOL_CAP_MS + MINUTE);
    expect(b.stub.calls).toEqual(['Running some commands', null]);
  });

  it('stays away while a subagent spawned by the run is still working', async () => {
    const { fake, stub, dispatch } = world();
    dispatch(IM);
    await fake.emitLifecycle('r1', 'start', IM);
    await fake.subagentSpawned('agent:main:subagent:1111', IM);
    await tick(2000);
    await fake.emitLifecycle('r1', 'end', IM);
    await tick(60_000);
    expect(stub.calls).toEqual([DEFAULT]);
    await fake.subagentEnded('agent:main:subagent:1111');
    await tick(0);
    expect(stub.calls).toEqual([DEFAULT, null]);
  });

  it('summarizes through llm.complete with a bounded request', async () => {
    const { fake, stub, dispatch } = world({ blurb: 'summarize' }, async () => 'Drafting a reply');
    dispatch(IM, 'x'.repeat(5000));
    await fake.emitLifecycle('r1', 'start', IM);
    await tick(2000);
    expect(stub.calls).toEqual(['Drafting a reply']);
    expect(fake.llmCalls).toHaveLength(1);
    const call = fake.llmCalls[0]!;
    expect(call.purpose).toBe('oscar.away-blurb');
    expect(call.maxTokens).toBe(40);
    expect(call.messages[0]!.content).toHaveLength(2000);
    expect(call.signal).toBeInstanceOf(AbortSignal);
    expect(call).not.toHaveProperty('model');
    expect(call).not.toHaveProperty('agentId');
  });
});

describe('wiring', () => {
  it('registers one lifecycle subscription and the ungated hooks only', () => {
    const { fake } = world();
    expect(fake.subscriptionIds()).toEqual(['oscar-presence']);
    expect(fake.hookNames()).toEqual([
      'after_tool_call', 'before_prompt_build', 'before_tool_call', 'model_call_started', 'subagent_ended', 'subagent_spawned',
    ]);
  });

  it('registers nothing outside full mode', () => {
    const fake = createFakeAgentApi({ registrationMode: 'tool-discovery' });
    registerPresence(fake.api, { tracker: createRunTracker(), controllerFor: () => undefined });
    expect(fake.subscriptionIds()).toEqual([]);
    expect(fake.hookNames()).toEqual([]);
  });

  it('hands the host config and summarizer to code outside registerFull', async () => {
    const { cfg } = world({}, async () => 'Drafting a reply');
    expect(hostConfig()).toBe(cfg);
    await expect(summarizeViaHost('hello', new AbortController().signal)).resolves.toBe('Drafting a reply');
  });

  it('finds the IM peer of a session key and nothing else', () => {
    setRuntime({
      accountId: 'botone', session: new FakeSession().asSession(), rooms: new Map(), lastReplyAt: new Map(),
      counters: { droppedSends: 0, eventGaps: 0 },
      sessionKeys: new Map([
        [IM, { accountId: 'botone', peer: { kind: 'im' as const, bot: 'botone', peer: 'alice' } }],
        [ROOM, { accountId: 'botone', peer: { kind: 'room' as const, bot: 'botone', room: { exchange: 4 as const, name: 'testroom' } } }],
      ]),
    });
    expect(imPeerFor('botone', IM)).toBe('alice');
    expect(imPeerFor('botone', IM.toUpperCase())).toBe('alice');
    expect(imPeerFor('botone', ROOM)).toBe(null);
    expect(imPeerFor('botone', 'agent:main:oscar:group:botone/bob')).toBe(null);
    expect(imPeerFor('bottwo', IM)).toBe(null);
  });

  it('maps roles to origin classes', () => {
    expect([originOf('owner'), originOf('approved'), originOf('bot'), originOf('unlisted')]).toEqual(['owner', 'approved', 'bot', 'approved']);
  });
});

describe('message tool set-presence', () => {
  it('lists the action with an awayMessage field scoped to this channel', () => {
    const { cfg } = world();
    const described = presenceActions.describeMessageTool({ cfg: cfg as never, accountId: 'botone' });
    expect(described?.actions).toEqual(['set-presence']);
    expect(described?.schema).toMatchObject({
      properties: { awayMessage: { type: 'string' } }, actions: ['set-presence'], visibility: 'current-channel',
    });
    expect(presenceActions.supportsAction?.({ action: 'set-presence' })).toBe(true);
    expect(presenceActions.supportsAction?.({ action: 'send' })).toBe(false);
  });

  it('hides the action when agent lines are off or the account is unknown', () => {
    const { cfg } = world({ blurb: 'phrases' });
    expect(presenceActions.describeMessageTool({ cfg: cfg as never, accountId: 'botone' })).toBeNull();
    expect(presenceActions.describeMessageTool({ cfg: cfg as never, accountId: 'nobody' })).toBeNull();
    expect(presenceToolHints({ cfg, accountId: 'botone' })).toEqual([]);
  });

  it('only validates in handleAction', async () => {
    const { cfg, stub, tracker } = world();
    const base = { channel: 'oscar', action: 'set-presence', cfg, accountId: 'botone' };
    const ok = await presenceActions.handleAction!({ ...base, params: { awayMessage: 'Sorting notes' } } as never);
    expect(ok.details).toEqual({ ok: true, status: 'Sorting notes' });
    const bad = await presenceActions.handleAction!({ ...base, params: { awayMessage: 'Helping alice' } } as never);
    expect(bad.details).toMatchObject({ ok: false });
    await expect(presenceActions.handleAction!({ ...base, params: {} } as never)).rejects.toThrow('awayMessage is required');
    await expect(presenceActions.handleAction!({ ...base, action: 'react', params: {} } as never)).rejects.toThrow('not supported');
    await tick(5000);
    expect(tracker.isBusy('botone')).toBe(false);
    expect(stub.calls).toEqual([]);
  });

  it('gives the agent its hints', () => {
    const { cfg } = world();
    expect(presenceToolHints({ cfg, accountId: 'botone' }).join(' ')).toContain('set-presence');
  });
});

describe('account start and stop', () => {
  function account() {
    const base = world();
    const stub = stubSession();
    const status: Record<string, unknown>[] = [];
    const lifecycle = channelLifecycleMock();
    const machine = lifecycle.createRunStateMachine({
      setStatus: lifecycle.createAccountStatusSink({ accountId: 'botone', setStatus: (next) => status.push(next) }),
    });
    base.tracker.seen('stale', IM);
    base.dispatch(IM);
    base.tracker.seen('stale', IM);
    const presence = startPresence({
      accountId: 'botone', session: stub.session, getCfg: () => base.cfg, machine, log: quietLog, tracker: base.tracker,
    });
    return { ...base, stub, status, presence };
  }

  it('starts with an empty tracker even when the process kept old runs', async () => {
    const { tracker, stub } = account();
    expect(tracker.isBusy('botone')).toBe(false);
    await tick(10_000);
    expect(stub.calls).toEqual([]);
  });

  it('publishes busy and the run count for status', async () => {
    const { fake, status, dispatch } = account();
    dispatch(ROOM);
    expect(status.at(-1)).toMatchObject({ accountId: 'botone', busy: false, activeRuns: 0 });
    await fake.emitLifecycle('r1', 'start', IM);
    await fake.emitLifecycle('r2', 'start', ROOM);
    await fake.emitLifecycle('r2', 'start', ROOM);
    expect(status.at(-1)).toMatchObject({ accountId: 'botone', busy: true, activeRuns: 2 });
    await fake.emitLifecycle('r1', 'end', IM);
    expect(status.at(-1)).toMatchObject({ busy: true, activeRuns: 1 });
    await fake.emitLifecycle('r2', 'end', ROOM);
    expect(status.at(-1)).toMatchObject({ busy: false, activeRuns: 0 });
  });

  it('stop clears the line, empties the tracker and freezes status', async () => {
    const { fake, stub, tracker, status, presence } = account();
    await fake.emitLifecycle('r1', 'start', IM);
    await tick(2000);
    await presence.stop();
    expect(stub.calls).toEqual([DEFAULT, null]);
    expect(tracker.isBusy('botone')).toBe(false);
    expect(status.at(-1)).toMatchObject({ busy: false, activeRuns: 0 });
    const frozen = status.length;
    await fake.emitLifecycle('r2', 'start', IM);
    expect(status).toHaveLength(frozen);
  });
});
