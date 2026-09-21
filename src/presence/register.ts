import type { ChannelMessageActionAdapter } from 'openclaw/plugin-sdk/channel-contract';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/channel-core';
import type { AnyAgentTool, OpenClawPluginToolContext } from 'openclaw/plugin-sdk/core';
import { CHANNEL_ID, listAccountIds, readPolicy, resolveAccount, type AwayConfig } from '../config.js';
import { sendAutoReply } from '../outbound.js';
import type { OriginClass, Role } from '../policy.js';
import { getRuntime } from '../runtime.js';
import type { Logger, OscarSession } from '../oscar/index.js';
import { createAutoReplier } from './auto-reply.js';
import { awayToolHints, createAwayController, type AwayController, type LineVerdict } from './away.js';
import { filterBlurb, forbiddenNames } from './blurb.js';
import { driveRunState, getRunTracker, handleLifecycle, type RunFeed, type RunTracker } from './runs.js';

export { CHANNEL_ID };
export const STATUS_TOOL = 'oscar_status';
const MESSAGE_TOOL = 'message';
const PRESENCE_ACTION = 'set-presence';

type ToolResult = Awaited<ReturnType<NonNullable<ChannelMessageActionAdapter['handleAction']>>>;
export type ControllerLookup = (accountId: string) => AwayController | undefined;
export type PresenceWiring = { tracker?: RunTracker & RunFeed; controllerFor: ControllerLookup };

export const runtimeWiring: PresenceWiring = { controllerFor: (accountId) => getRuntime(accountId)?.away };

type Summarizer = (text: string, signal: AbortSignal) => Promise<string>;
type HostSlot = { summarize?: Summarizer; config?: () => unknown };
const HOST_SLOT = Symbol.for('openclaw-oscar.presenceHost');

function hostSlot(): HostSlot {
  const holder = globalThis as unknown as Record<symbol, HostSlot | undefined>;
  let slot = holder[HOST_SLOT];
  if (!slot) {
    slot = {};
    holder[HOST_SLOT] = slot;
  }
  return slot;
}

export function hostConfig(): unknown {
  return hostSlot().config?.();
}

export const summarizeViaHost: Summarizer = (text, signal) => {
  const summarize = hostSlot().summarize;
  return summarize ? summarize(text, signal) : Promise.reject(new Error('no host runtime'));
};

const NOTES: Record<Exclude<LineVerdict, { accepted: true }>['reason'], string> = {
  off: 'Status lines from the agent are switched off for this account. A general phrase is shown instead.',
  'no-run': 'No task is being tracked right now, so there is no status line to set.',
  limit: 'The status line was already set twice for this task. The last one stays.',
  unsafe: 'That line looked like it held a name, a path, an address or a long number. A general phrase is shown instead. Try one vague sentence.',
};

function toolResult(payload: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], details: payload };
}

function verdictResult(verdict: LineVerdict): ToolResult {
  return verdict.accepted
    ? toolResult({ ok: true, status: verdict.shown })
    : toolResult({ ok: false, note: NOTES[verdict.reason] });
}

function lineFromToolCall(toolName: string, params: Record<string, unknown>): string | null {
  if (toolName === STATUS_TOOL) return typeof params['text'] === 'string' ? params['text'] : null;
  if (toolName !== MESSAGE_TOOL || params['action'] !== PRESENCE_ACTION) return null;
  const channel = params['channel'];
  if (typeof channel === 'string' && channel.trim().toLowerCase() !== CHANNEL_ID) return null;
  return typeof params['awayMessage'] === 'string' ? params['awayMessage'] : null;
}

export function registerPresence(api: OpenClawPluginApi, wiring: PresenceWiring): void {
  if (api.registrationMode !== 'full') return;
  const tracker = wiring.tracker ?? getRunTracker();
  const slot = hostSlot();
  slot.summarize = createSummarizer(api.runtime);
  slot.config = () => api.runtime.config.current();

  api.agent.events.registerAgentEventSubscription({
    id: 'oscar-presence',
    description: 'Tracks agent runs for the away line',
    streams: ['lifecycle'],
    handle: (event) => handleLifecycle(tracker, event),
  });

  // At 2026.7.1-2 the model_call_started context has no trigger; before_prompt_build has it.
  api.on('before_prompt_build', (_event, ctx) => {
    if (ctx.runId) tracker.trigger(ctx.runId, ctx.trigger, ctx.sessionKey);
  });
  api.on('model_call_started', (event, ctx) => {
    tracker.trigger(event.runId, ctx.trigger, event.sessionKey ?? ctx.sessionKey);
  });

  api.on('before_tool_call', (event, ctx) => {
    const runId = event.runId ?? ctx.runId;
    if (!runId) return;
    tracker.toolStart(runId, event.toolCallId ?? ctx.toolCallId, event.toolName, ctx.sessionKey);
    const run = tracker.runInfo(runId);
    const controller = run ? wiring.controllerFor(run.accountId) : undefined;
    if (!controller) return;
    controller.noteTool(runId, event.toolName);
    const line = lineFromToolCall(event.toolName, event.params);
    if (line !== null) controller.offerLine(runId, line, event.toolCallId ?? ctx.toolCallId);
  });
  api.on('after_tool_call', (event, ctx) => {
    const runId = event.runId ?? ctx.runId;
    if (runId) tracker.toolEnd(runId, event.toolCallId ?? ctx.toolCallId, event.toolName, ctx.sessionKey);
  });

  api.on('subagent_spawned', (event, ctx) => {
    tracker.subagentSpawned(event.childSessionKey, ctx.requesterSessionKey);
  });
  api.on('subagent_ended', (event) => {
    tracker.subagentEnded(event.targetSessionKey);
  });
}

function awayFor(cfg: unknown, accountId: string | null | undefined): AwayConfig | null {
  try {
    const account = resolveAccount(cfg, accountId);
    return listAccountIds(cfg).includes(account.accountId) ? account.away : null;
  } catch {
    return null;
  }
}

export const presenceActions: ChannelMessageActionAdapter = {
  describeMessageTool: ({ cfg, accountId }) => {
    const away = awayFor(cfg, accountId);
    if (!away || !away.enabled || away.blurb === 'phrases') return null;
    return {
      actions: [PRESENCE_ACTION],
      schema: {
        properties: {
          awayMessage: {
            type: 'string',
            description: 'One vague sentence shown next to your name while you work. No names, paths, addresses, numbers or secrets.',
          },
        },
        actions: [PRESENCE_ACTION],
        visibility: 'current-channel',
      },
    };
  },
  supportsAction: ({ action }) => action === PRESENCE_ACTION,
  handleAction: async (ctx) => {
    if (ctx.action !== PRESENCE_ACTION) throw new Error(`Action ${ctx.action} is not supported on this channel.`);
    const raw = typeof ctx.params['awayMessage'] === 'string' ? ctx.params['awayMessage'] : '';
    if (!raw.trim()) throw new Error('awayMessage is required for set-presence.');
    const away = awayFor(ctx.cfg, ctx.accountId);
    if (!away || !away.enabled || away.blurb === 'phrases') return verdictResult({ accepted: false, reason: 'off' });
    const line = filterBlurb(raw, forbiddenNames(readPolicy(ctx.cfg)), away.maxLength);
    return verdictResult(line ? { accepted: true, shown: line } : { accepted: false, reason: 'unsafe' });
  },
};

export function presenceToolHints(params: { cfg: unknown; accountId?: string | null }): string[] {
  const away = awayFor(params.cfg, params.accountId);
  return away ? awayToolHints(away) : [];
}

export function createOscarStatusTool(ctx: OpenClawPluginToolContext, wiring: PresenceWiring): AnyAgentTool {
  const tracker = wiring.tracker ?? getRunTracker();
  return {
    name: STATUS_TOOL,
    label: 'Status line',
    description:
      'Set the short status line people see next to your name while you work on a longer task. One vague sentence. No names, paths, addresses, numbers or secrets.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: 'The status line, one vague sentence.' } },
      required: ['text'],
      additionalProperties: false,
    },
    async execute(toolCallId, params) {
      const raw = (params as { text?: unknown } | null)?.text;
      if (typeof raw !== 'string' || !raw.trim()) throw new Error('text is required.');
      const controller = ctx.agentAccountId ? wiring.controllerFor(ctx.agentAccountId) : undefined;
      if (!controller) throw new Error('This account is not signed on, so there is no status line to set.');
      const recorded = controller.verdictFor(toolCallId);
      if (recorded) return verdictResult(recorded);
      const run = ctx.sessionKey ? tracker.activeRun(ctx.sessionKey) : null;
      return verdictResult(run ? controller.offerLine(run.runId, raw, toolCallId) : { accepted: false, reason: 'no-run' });
    },
  };
}

export function originOf(role: Role): OriginClass {
  return role === 'owner' || role === 'bot' ? role : 'approved';
}

export function imPeerFor(accountId: string, sessionKey: string): string | null {
  const keys = getRuntime(accountId)?.sessionKeys;
  if (!keys) return null;
  const wanted = sessionKey.toLowerCase();
  const entry = keys.get(sessionKey) ?? [...keys.entries()].find(([key]) => key.toLowerCase() === wanted)?.[1];
  return entry?.peer.kind === 'im' ? entry.peer.peer : null;
}

export function presenceDispatch(
  input: { sessionKey: string; accountId: string; origin: OriginClass; text: string },
  wiring: PresenceWiring,
): { onAgentRunStart: (runId: string) => void } {
  const tracker = wiring.tracker ?? getRunTracker();
  tracker.bind(input.sessionKey, input.accountId, input.origin);
  wiring.controllerFor(input.accountId)?.noteInbound(input.sessionKey, input.text);
  return { onAgentRunStart: (runId) => tracker.seen(runId, input.sessionKey) };
}

const SUMMARY_PROMPT =
  'Write one vague sentence of at most ten words saying what kind of task this message asks for. ' +
  'No names, no file paths, no addresses, no numbers, nothing private. Reply with the sentence only.';

export function createSummarizer(runtime: Pick<OpenClawPluginApi['runtime'], 'llm'>): Summarizer {
  return async (text, signal) => {
    const result = await runtime.llm.complete({
      messages: [{ role: 'user', content: text.slice(0, 2000) }],
      systemPrompt: SUMMARY_PROMPT,
      maxTokens: 40,
      temperature: 0.2,
      signal,
      purpose: 'oscar.away-blurb',
    });
    return result.text;
  };
}

export type RunStateMachine = { onRunStart(): void; onRunEnd(): void; deactivate(): void };

export function startPresence(input: {
  accountId: string;
  session: Pick<OscarSession, 'setAway' | 'getState' | 'on'>;
  getCfg: () => unknown;
  machine: RunStateMachine;
  log: Logger;
  tracker?: RunTracker & RunFeed;
}): { away: AwayController; stop(): Promise<void> } {
  const { accountId, machine } = input;
  const tracker = input.tracker ?? getRunTracker();
  const cfg = input.getCfg;
  tracker.reset(accountId);
  const stopRunState = driveRunState(tracker, accountId, machine);
  const away = createAwayController({
    accountId,
    tracker,
    session: input.session,
    config: () => resolveAccount(cfg(), accountId).away,
    forbidden: () => forbiddenNames(readPolicy(cfg())),
    summarize: summarizeViaHost,
    log: input.log,
  });
  const autoReply = createAutoReplier({
    accountId,
    tracker,
    away,
    config: () => resolveAccount(cfg(), accountId).away,
    peerFor: (sessionKey) => imPeerFor(accountId, sessionKey),
    repliedAt: (peer) => getRuntime(accountId)?.lastReplyAt.get(peer),
    send: async (to, text) => {
      await sendAutoReply({ cfg: cfg(), accountId, to, text });
    },
    log: input.log,
  });
  return {
    away,
    async stop() {
      autoReply.stop();
      await autoReply.idle();
      await away.stop();
      tracker.reset(accountId);
      stopRunState();
      machine.deactivate();
    },
  };
}
