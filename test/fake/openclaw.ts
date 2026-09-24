import { vi } from 'vitest';
import { z } from 'zod';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/channel-core';
import type { AnyAgentTool, OpenClawPluginToolContext } from 'openclaw/plugin-sdk/core';
import type { AgentToolResult } from 'openclaw/plugin-sdk/tool-results';

export type Rec = Record<string, unknown>;
export type FakeReply = { text: string; kind?: string };

type Outbound = {
  sanitizeText?: (p: { text: string; payload: Rec }) => string;
  chunker?: ((text: string, limit: number) => string[]) | null;
  textChunkLimit?: number;
  resolveTarget?: (p: Rec) => { ok: true; to: string } | { ok: false; error: Error };
  sendText?: (ctx: Rec) => Promise<Rec>;
};

function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const cut = rest.lastIndexOf(' ', limit);
    const at = cut > 0 ? cut : limit;
    out.push(rest.slice(0, at));
    rest = rest.slice(at).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

async function deliverThroughPlugin(p: { cfg: unknown; to: string; accountId?: string; payloads: Rec[] }): Promise<Rec[]> {
  const outbound = ((sdk.plugin ?? {}).outbound ?? {}) as Outbound;
  if (!outbound.sendText) throw new Error('fake sdk: usePlugin() was not called or the plugin has no outbound.sendText');
  const results: Rec[] = [];
  for (const payload of p.payloads) {
    let text = String(payload.text ?? '');
    if (outbound.sanitizeText) text = outbound.sanitizeText({ text, payload });
    const chunks = outbound.chunker ? outbound.chunker(text, outbound.textChunkLimit ?? 4000) : [text];
    for (const chunk of chunks) results.push(await outbound.sendText({ cfg: p.cfg, to: p.to, text: chunk, accountId: p.accountId }));
  }
  return results;
}

export const sdk = {
  inbound: [] as { channel: string; accountId?: string; input: Rec; turn: Rec; ctx: Rec; runId: string }[],
  durable: [] as { params: Rec; mirrorFailed: boolean }[],
  ingress: [] as { params: Rec; decision: 'allow' | 'block' | 'pairing' }[],
  routes: [] as Rec[],
  typing: [] as Rec[],
  foreign: [] as { channel: string; to: string; accountId?: string; text: string }[],
  foreignFail: 'none' as 'none' | 'failed' | 'throw',
  sessions: new Set<string>(),
  secretFiles: new Map<string, string>(),
  agent: (() => []) as (ctx: Rec) => Promise<FakeReply[]> | FakeReply[],
  plugin: undefined as Rec | undefined,
  usePlugin(plugin: unknown): void {
    sdk.plugin = plugin as Rec;
  },
  async messageTool(p: { cfg: unknown; accountId: string; to: string; text: string }): Promise<void> {
    const outbound = ((sdk.plugin ?? {}).outbound ?? {}) as Outbound;
    const resolved = outbound.resolveTarget?.({ cfg: p.cfg, to: p.to, accountId: p.accountId, mode: 'explicit' });
    if (resolved && !resolved.ok) throw resolved.error;
    await deliverThroughPlugin({ cfg: p.cfg, to: resolved?.to ?? p.to, accountId: p.accountId, payloads: [{ text: p.text }] });
  },
  reset(): void {
    sdk.inbound.length = 0;
    sdk.durable.length = 0;
    sdk.ingress.length = 0;
    sdk.routes.length = 0;
    sdk.typing.length = 0;
    sdk.foreign.length = 0;
    sdk.foreignFail = 'none';
    sdk.sessions.clear();
    sdk.secretFiles.clear();
    sdk.agent = () => [];
    sdk.plugin = undefined;
  },
};

async function runChannelInboundEvent(params: Rec): Promise<Rec> {
  const adapter = params.adapter as { ingest: (raw: unknown) => unknown; resolveTurn: (...a: unknown[]) => unknown };
  const input = (await adapter.ingest(params.raw)) as Rec | null;
  if (!input) return { admission: { kind: 'drop', reason: 'ingest-null' }, dispatched: false };
  const eventClass = { kind: 'message', canStartAgentTurn: true };
  const preflightFn = (params.adapter as { preflight?: (input: unknown, eventClass: unknown) => unknown }).preflight;
  const preflight = ((await preflightFn?.(input, eventClass)) ?? {}) as KernelPreflight;
  if (preflight.admission && preflight.admission.kind !== 'dispatch' && preflight.admission.kind !== 'observeOnly') {
    recordDroppedHistory(input as KernelInput, preflight);
    return { admission: preflight.admission, dispatched: false };
  }
  const turn = (await adapter.resolveTurn(input, eventClass, preflight)) as Rec;
  const ctx = (turn.ctxPayload ?? {}) as Rec;
  const runId = `run-${sdk.inbound.length + 1}`;
  sdk.inbound.push({ channel: String(params.channel), accountId: params.accountId as string | undefined, input, turn, ctx, runId });
  sdk.sessions.add(String(turn.routeSessionKey));
  const replyOptions = (turn.replyOptions ?? {}) as { onAgentRunStart?: (id: string) => void };
  const typing = (turn.dispatcherOptions as { typingCallbacks?: { onReplyStart(): Promise<void>; onIdle?(): void } } | undefined)?.typingCallbacks;
  const delivery = turn.delivery as { deliver(p: FakeReply, info: Rec): Promise<unknown>; onError?(e: unknown, info: { kind: string }): void };
  replyOptions.onAgentRunStart?.(runId);
  await typing?.onReplyStart();
  try {
    for (const reply of await sdk.agent(ctx)) {
      const info = { kind: reply.kind ?? 'final' };
      try {
        await delivery.deliver(reply, info);
      } catch (err) {
        delivery.onError?.(err, info);
      }
    }
  } finally {
    typing?.onIdle?.();
  }
  return { admission: { kind: 'dispatch' }, dispatched: true, ctxPayload: ctx, routeSessionKey: turn.routeSessionKey, dispatchResult: {} };
}

function buildChannelInboundEventContext(params: Rec): Rec {
  const message = params.message as Rec;
  const route = params.route as Rec;
  const reply = params.reply as Rec;
  const sender = params.sender as Rec;
  const conversation = params.conversation as Rec;
  const access = (params.access ?? {}) as { commands?: { authorized?: boolean }; mentions?: Rec };
  const supplemental = (params.supplemental ?? {}) as { untrustedContext?: unknown[]; groupSystemPrompt?: string };
  return {
    Body: message.body ?? message.rawBody,
    InboundEventKind: message.inboundEventKind ?? 'user_request',
    BodyForAgent: message.bodyForAgent ?? message.rawBody,
    RawBody: message.rawBody,
    CommandBody: message.commandBody ?? message.rawBody,
    BodyForCommands: message.commandBody ?? message.rawBody,
    From: params.from,
    To: reply.to,
    SessionKey: route.dispatchSessionKey ?? route.routeSessionKey,
    AgentId: route.agentId,
    AccountId: route.accountId ?? params.accountId,
    MessageSid: params.messageId,
    ChatType: conversation.kind,
    ChatId: conversation.id,
    ConversationLabel: conversation.label,
    GroupSubject: conversation.kind !== 'direct' ? conversation.label : undefined,
    InboundHistory: message.inboundHistory,
    SenderName: sender.name ?? sender.displayLabel,
    SenderId: sender.id,
    SenderIsBot: sender.isBot,
    Timestamp: params.timestamp,
    Provider: params.provider ?? params.channel,
    Surface: params.surface ?? params.provider ?? params.channel,
    WasMentioned: access.mentions?.wasMentioned,
    CommandAuthorized: access.commands?.authorized === true,
    ChannelContext: params.channelContext,
    OriginatingChannel: params.channel,
    OriginatingTo: reply.originatingTo ?? reply.to,
    UntrustedStructuredContext: supplemental.untrustedContext,
    GroupSystemPrompt: supplemental.groupSystemPrompt,
    ...((params.extra ?? {}) as Rec),
  };
}

function resolveAgentRoute(input: Rec): Rec {
  sdk.routes.push(input);
  const cfg = (input.cfg ?? {}) as { bindings?: { agentId: string; match: { channel: string; accountId?: string } }[] };
  const accountId = String(input.accountId ?? 'default');
  const bindings = (cfg.bindings ?? []).filter((b) => b.match.channel === input.channel);
  const hit = bindings.find((b) => b.match.accountId === accountId || b.match.accountId === '*')
    ?? bindings.find((b) => !b.match.accountId && accountId === 'default');
  const agentId = hit?.agentId ?? 'main';
  const peer = input.peer as { kind: string; id: string } | null | undefined;
  // Under the default dmScope core folds every direct peer into the agent's main session.
  const sessionKey = !peer || peer.kind === 'direct'
    ? `agent:${agentId}:main`
    : `agent:${agentId}:${String(input.channel)}:${peer.kind}:${peer.id.toLowerCase()}`;
  return {
    agentId, channel: input.channel, accountId, sessionKey, mainSessionKey: `agent:${agentId}:main`,
    lastRoutePolicy: 'session', matchedBy: hit ? 'binding.account' : 'default',
  };
}

async function resolveStableChannelMessageIngress(params: Rec): Promise<Rec> {
  const identity = (params.identity ?? {}) as { normalize?: (v: string) => string | null | undefined };
  const normalize = (v: unknown): string => (identity.normalize ? identity.normalize(String(v)) ?? '' : String(v));
  const subject = normalize((params.subject as { stableId?: unknown } | undefined)?.stableId ?? '');
  const allow = ((params.allowFrom ?? []) as unknown[]).map(normalize).filter((v) => v.length > 0);
  const event = (params.event ?? {}) as { mayPair?: boolean };
  const conversation = params.conversation as { kind: string };
  const dmPolicy = (params.dmPolicy as string | undefined) ?? 'pairing';
  let decision: 'allow' | 'block' | 'pairing' = 'block';
  let reasonCode = 'dm_policy_not_allowlisted';
  const raw = ((params.allowFrom ?? []) as unknown[]).map(String);
  if (conversation.kind !== 'direct') {
    reasonCode = 'group_policy_disabled';
  } else if (dmPolicy === 'disabled') {
    reasonCode = 'dm_policy_disabled';
  } else if (raw.includes('*') || (subject.length > 0 && allow.includes(subject))) {
    decision = 'allow';
    reasonCode = raw.includes('*') && dmPolicy === 'open' ? 'dm_policy_open' : 'dm_policy_allowlisted';
  } else if (dmPolicy === 'pairing' && (event.mayPair ?? true)) {
    decision = 'pairing';
    reasonCode = 'dm_policy_pairing_required';
  }
  sdk.ingress.push({ params, decision });
  const admission = decision === 'allow' ? 'dispatch' : decision === 'pairing' ? 'pairing-required' : 'drop';
  return {
    state: {},
    ingress: { admission, decision, decisiveGateId: 'fake', reasonCode, graph: {} },
    senderAccess: { allowed: decision === 'allow', decision, reasonCode, effectiveAllowFrom: allow, effectiveGroupAllowFrom: [], providerMissingFallbackApplied: false },
    routeAccess: { allowed: true },
    commandAccess: { requested: false, authorized: false, shouldBlockControlCommand: false, reasonCode },
    activationAccess: { ran: false, allowed: true, shouldSkip: false, reasonCode },
  };
}

async function sendDurableMessageBatch(params: Rec): Promise<Rec> {
  if (params.channel !== undefined && params.channel !== 'oscar') {
    if (sdk.foreignFail === 'throw') throw new Error('fake foreign send threw');
    if (sdk.foreignFail === 'failed') return { status: 'failed', error: new Error('fake foreign send failed'), stage: 'platform_send' };
    for (const payload of (params.payloads ?? []) as Rec[]) {
      sdk.foreign.push({ channel: String(params.channel), to: String(params.to), ...(params.accountId ? { accountId: String(params.accountId) } : {}), text: String(payload.text ?? '') });
    }
    return { status: 'sent', results: [{ messageId: 'f1' }], receipt: {} };
  }
  const mirror = params.mirror as { sessionKey: string } | undefined;
  sdk.durable.push({ params, mirrorFailed: Boolean(mirror) && !sdk.sessions.has(mirror?.sessionKey ?? '') });
  try {
    const results = await deliverThroughPlugin({
      cfg: params.cfg, to: String(params.to), accountId: params.accountId as string | undefined, payloads: (params.payloads ?? []) as Rec[],
    });
    return { status: 'sent', results, receipt: {} };
  } catch (error) {
    return { status: 'failed', error, stage: 'platform_send' };
  }
}

function createTypingCallbacks(params: Rec): Rec {
  sdk.typing.push(params);
  const p = params as { start(): Promise<void>; stop?(): Promise<void>; onStartError(e: unknown): void };
  return {
    onReplyStart: async () => {
      try {
        await p.start();
      } catch (err) {
        p.onStartError(err);
      }
    },
    onIdle: () => { void p.stop?.(); },
    onCleanup: () => { void p.stop?.(); },
  };
}

function defineChannelPluginEntry(o: Rec): Rec {
  const plugin = o.plugin;
  const setRuntime = o.setRuntime as ((r: unknown) => void) | undefined;
  const registerCliMetadata = o.registerCliMetadata as ((api: unknown) => void) | undefined;
  const registerFull = o.registerFull as ((api: unknown) => void) | undefined;
  return {
    id: o.id, name: o.name, description: o.description, configSchema: o.configSchema, channelPlugin: plugin,
    register(api: { registrationMode: string; runtime: unknown; registerChannel(r: unknown): void }): void {
      if (api.registrationMode === 'cli-metadata') return void registerCliMetadata?.(api);
      if (api.registrationMode === 'tool-discovery') return void registerFull?.(api);
      api.registerChannel({ plugin });
      setRuntime?.(api.runtime);
      if (api.registrationMode === 'discovery') return void registerCliMetadata?.(api);
      if (api.registrationMode !== 'full') return;
      registerCliMetadata?.(api);
      registerFull?.(api);
    },
  };
}

function createChatChannelPlugin(params: Rec): Rec {
  const base = params.base as Rec;
  const outbound = params.outbound as { base?: Rec; attachedResults?: { channel: string; sendText?: (ctx: Rec) => Promise<Rec> | Rec } } | undefined;
  const attached = outbound?.attachedResults;
  const resolvedOutbound = attached
    ? { ...outbound?.base, sendText: async (ctx: Rec) => ({ channel: attached.channel, ...(await attached.sendText?.(ctx)) }) }
    : outbound;
  const threading = params.threading as { topLevelReplyToMode?: string } | undefined;
  return {
    ...base,
    conversationBindings: { supportsCurrentConversationBinding: true },
    ...(threading ? { threading: { resolveReplyToMode: () => threading.topLevelReplyToMode } } : {}),
    ...(resolvedOutbound ? { outbound: resolvedOutbound } : {}),
  };
}

const secretRef = z.object({ source: z.enum(['env', 'file', 'exec']), provider: z.string(), id: z.string() }).strict();

export const channelInbound: Rec = { runChannelInboundEvent, buildChannelInboundEventContext };
export const routing: Rec = { resolveAgentRoute };
export const sessionStoreRuntime: Rec = { resolveStorePath: (_store?: string, opts?: { agentId?: string }) => `/fake/state/${opts?.agentId ?? 'main'}/sessions.json` };
export const conversationRuntime: Rec = { recordInboundSession: vi.fn(async () => undefined) };
export const replyDispatchRuntime: Rec = { dispatchReplyWithBufferedBlockDispatcher: vi.fn(async () => ({})) };
export const channelIngressRuntime: Rec = { resolveStableChannelMessageIngress };
export const channelOutbound: Rec = {
  sendDurableMessageBatch,
  createChannelMessageAdapterFromOutbound: (params: Rec) => ({ id: params.id, send: params.outbound }),
};
export const channelReplyPipeline: Rec = { createTypingCallbacks };
export const replyChunking: Rec = { chunkText };
export const channelCore: Rec = {
  createChatChannelPlugin,
  defineChannelPluginEntry,
  defineSetupPluginEntry: (plugin: unknown) => ({ plugin }),
  buildChannelOutboundSessionRoute: (p: Rec) => {
    const route = resolveAgentRoute({ cfg: p.cfg, channel: p.channel, accountId: p.accountId, peer: p.peer });
    return { sessionKey: route.sessionKey, baseSessionKey: route.sessionKey, peer: p.peer, chatType: p.chatType, from: p.from, to: p.to };
  },
  tryReadSecretFileSync: (path: string | undefined) => (path ? sdk.secretFiles.get(path) : undefined),
};
export const statusHelpers: Rec = {
  createComputedAccountStatusAdapter: (options: Rec) => {
    const { resolveAccountSnapshot, ...rest } = options as { resolveAccountSnapshot(p: Rec): Rec };
    return {
      ...rest,
      buildAccountSnapshot: (p: Rec) => {
        const { extra, ...snapshot } = resolveAccountSnapshot(p) as { extra?: Rec };
        const runtime = (p.runtime ?? {}) as Rec;
        return { running: runtime.running ?? false, connected: runtime.connected, lastError: runtime.lastError ?? null, probe: p.probe, ...snapshot, ...extra };
      },
    };
  },
};
export const secretInput: Rec = {
  buildOptionalSecretInputSchema: () => z.union([z.string(), secretRef]).optional(),
  hasConfiguredSecretInput: (v: unknown) => (typeof v === 'string' ? v.trim().length > 0 : secretRef.safeParse(v).success),
  normalizeSecretInputString: (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined),
};
export const channelConfigSchema: Rec = {
  buildChannelConfigSchema: (schema: { toJSONSchema?: (o: Rec) => Rec }, options?: { uiHints?: Rec }) => ({
    schema: typeof schema.toJSONSchema === 'function'
      ? schema.toJSONSchema({ target: 'draft-07', unrepresentable: 'any' })
      : { type: 'object', additionalProperties: true },
    ...(options?.uiHints ? { uiHints: options.uiHints } : {}),
  }),
};

type KernelHistoryEntry = { sender: string; body: string; timestamp?: number; messageId?: string };
type KernelInput = { id: string; timestamp?: number; rawText: string; textForAgent?: string };
type KernelAdmission = { kind: 'dispatch' | 'observeOnly' | 'handled' | 'drop'; reason?: string; recordHistory?: boolean };
type KernelPreflight = {
  admission?: KernelAdmission;
  message?: { senderLabel?: string; envelopeFrom?: string; bodyForAgent?: string; body?: string; rawBody?: string };
  history?: { key: string; limit: number; historyMap: Map<string, KernelHistoryEntry[]>; recordOnDrop?: boolean };
};
type KernelParams = {
  channel: string;
  accountId?: string;
  raw: unknown;
  adapter: {
    ingest: (raw: unknown) => unknown;
    preflight?: (input: unknown, eventClass: unknown) => unknown;
    resolveTurn: (input: unknown, eventClass: unknown, preflight: unknown) => unknown;
  };
};

export type InboundKernelCall = {
  channel: string;
  accountId?: string;
  messageId?: string;
  admission: string;
  reason?: string;
  recordHistory: boolean;
  historyKey?: string;
  historyLimit?: number;
};

// What core does with a preflight drop (dist/kernel-BMsNZe7F.js:588-611 at openclaw 2026.7.1-2).
function recordDroppedHistory(input: KernelInput, preflight: KernelPreflight): void {
  const admission = preflight.admission;
  const history = preflight.history;
  if (!admission || admission.kind !== 'drop' || !history || history.limit <= 0) return;
  if (admission.recordHistory !== true && history.recordOnDrop !== true) return;
  const message = preflight.message ?? {};
  const body = message.bodyForAgent ?? message.body ?? message.rawBody ?? input.textForAgent ?? input.rawText;
  if (body.trim().length === 0) return;
  const entries = history.historyMap.get(history.key) ?? [];
  entries.push({
    sender: message.senderLabel ?? message.envelopeFrom ?? 'unknown',
    body,
    timestamp: input.timestamp,
    messageId: input.id,
  });
  if (entries.length > history.limit) entries.splice(0, entries.length - history.limit);
  history.historyMap.set(history.key, entries);
}

export function createInboundKernel() {
  const calls: InboundKernelCall[] = [];
  const dispatched: unknown[] = [];

  async function run(params: unknown): Promise<unknown> {
    const p = params as KernelParams;
    const input = (await p.adapter.ingest(p.raw)) as KernelInput | null;
    if (!input) {
      calls.push({ channel: p.channel, accountId: p.accountId, admission: 'drop', reason: 'ingest-null', recordHistory: false });
      return { admission: { kind: 'drop', reason: 'ingest-null' }, dispatched: false };
    }
    const eventClass = { kind: 'message', canStartAgentTurn: true };
    const preflight = ((await p.adapter.preflight?.(input, eventClass)) ?? {}) as KernelPreflight;
    const admission = preflight.admission;
    if (admission && admission.kind !== 'dispatch' && admission.kind !== 'observeOnly') {
      recordDroppedHistory(input, preflight);
      calls.push({
        channel: p.channel,
        accountId: p.accountId,
        messageId: input.id,
        admission: admission.kind,
        reason: admission.reason,
        recordHistory: admission.recordHistory === true,
        historyKey: preflight.history?.key,
        historyLimit: preflight.history?.limit,
      });
      return { admission, dispatched: false };
    }
    const resolved = await p.adapter.resolveTurn(input, eventClass, preflight);
    dispatched.push(resolved);
    calls.push({
      channel: p.channel,
      accountId: p.accountId,
      messageId: input.id,
      admission: admission?.kind ?? 'dispatch',
      recordHistory: false,
    });
    return { admission: admission ?? { kind: 'dispatch' }, dispatched: true };
  }

  return { run, calls, dispatched };
}

type HookHandler = (event: unknown, ctx: unknown) => unknown;
type EventSubscription = { id: string; streams?: string[]; handle: (event: never, ctx: never) => void | Promise<void> };
type ToolFactory = (ctx: OpenClawPluginToolContext) => AnyAgentTool | AnyAgentTool[] | null | undefined;
type LlmParams = { messages: { role: string; content: string }[]; systemPrompt?: string; maxTokens?: number; purpose?: string; signal?: AbortSignal };

export type FakeToolCall = {
  toolName: string; params: Record<string, unknown>;
  runId: string; sessionKey: string; toolCallId?: string;
};

export function createFakeAgentApi(opts: {
  registrationMode?: string;
  complete?: (params: LlmParams) => Promise<string>;
  config?: () => unknown;
} = {}) {
  const hooks = new Map<string, HookHandler[]>();
  const subscriptions: EventSubscription[] = [];
  const tools: { tool: AnyAgentTool | ToolFactory; names: string[] }[] = [];
  const llmCalls: LlmParams[] = [];
  const seqByRun = new Map<string, number>();
  let callSeq = 0;

  const api = {
    id: 'openclaw-oscar',
    name: 'openclaw-oscar',
    registrationMode: opts.registrationMode ?? 'full',
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    on(name: string, handler: HookHandler) {
      hooks.set(name, [...(hooks.get(name) ?? []), handler]);
    },
    agent: {
      events: {
        registerAgentEventSubscription(subscription: EventSubscription) {
          subscriptions.push(subscription);
        },
      },
    },
    registerTool(tool: AnyAgentTool | ToolFactory, options?: { name?: string; names?: string[] }) {
      tools.push({ tool, names: options?.names ?? (options?.name ? [options.name] : []) });
    },
    runtime: {
      config: { current: () => opts.config?.() ?? {} },
      llm: {
        async complete(params: LlmParams) {
          llmCalls.push(params);
          const text = opts.complete ? await opts.complete(params) : '';
          return { text, provider: 'fake', model: 'fake', agentId: 'main', usage: {}, audit: { caller: { kind: 'plugin' } } };
        },
      },
    },
  };

  async function fireHook(name: string, event: unknown, ctx: unknown): Promise<void> {
    for (const handler of hooks.get(name) ?? []) await handler(event, ctx);
  }

  async function emitAgentEvent(stream: string, runId: string, data: Record<string, unknown>, sessionKey?: string): Promise<void> {
    const seq = (seqByRun.get(runId) ?? 0) + 1;
    seqByRun.set(runId, seq);
    const event = { runId, seq, stream, ts: Date.now(), data, ...(sessionKey ? { sessionKey } : {}) };
    for (const subscription of subscriptions) {
      const streams = subscription.streams;
      if (streams && streams.length > 0 && !streams.includes(stream)) continue;
      await subscription.handle(structuredClone(event) as never, {} as never);
    }
  }

  function resolveTool(name: string, ctx: OpenClawPluginToolContext): AnyAgentTool {
    for (const entry of tools) {
      const made = typeof entry.tool === 'function' ? entry.tool(ctx) : entry.tool;
      for (const tool of Array.isArray(made) ? made : made ? [made] : []) if (tool.name === name) return tool;
    }
    throw new Error(`no tool named ${name}`);
  }

  function startTool(call: FakeToolCall): Promise<string> {
    const toolCallId = call.toolCallId ?? `call-${(callSeq += 1)}`;
    return fireHook(
      'before_tool_call',
      { toolName: call.toolName, params: call.params, runId: call.runId, toolCallId },
      { toolName: call.toolName, runId: call.runId, sessionKey: call.sessionKey, toolCallId },
    ).then(() => toolCallId);
  }

  function finishTool(call: FakeToolCall & { toolCallId: string }): Promise<void> {
    return fireHook(
      'after_tool_call',
      { toolName: call.toolName, params: call.params, runId: call.runId, toolCallId: call.toolCallId },
      { toolName: call.toolName, runId: call.runId, sessionKey: call.sessionKey, toolCallId: call.toolCallId },
    );
  }

  return {
    api: api as unknown as OpenClawPluginApi,
    llmCalls,
    hookNames: () => [...hooks.keys()].sort(),
    subscriptionIds: () => subscriptions.map((s) => s.id),
    fireHook,
    emitLifecycle: (runId: string, phase: string, sessionKey?: string) => emitAgentEvent('lifecycle', runId, { phase }, sessionKey),
    emitAgentEvent,
    promptBuild: (runId: string, sessionKey: string, trigger?: string) =>
      fireHook('before_prompt_build', { prompt: '', messages: [] }, { runId, sessionKey, ...(trigger ? { trigger } : {}) }),
    modelCall: (runId: string, sessionKey: string, trigger?: string) =>
      fireHook(
        'model_call_started',
        { runId, callId: `c${(callSeq += 1)}`, sessionKey, provider: 'fake', model: 'fake' },
        { runId, sessionKey, ...(trigger ? { trigger } : {}) },
      ),
    startTool,
    finishTool,
    async callTool(call: FakeToolCall, toolCtx: OpenClawPluginToolContext): Promise<AgentToolResult<unknown>> {
      const tool = resolveTool(call.toolName, toolCtx);
      const toolCallId = await startTool(call);
      try {
        return await tool.execute(toolCallId, call.params as never);
      } finally {
        await finishTool({ ...call, toolCallId });
      }
    },
    subagentSpawned: (childSessionKey: string, requesterSessionKey: string, runId = 'child-run') =>
      fireHook(
        'subagent_spawned',
        { runId, childSessionKey, agentId: 'main', mode: 'run', threadRequested: false, requester: { channel: 'oscar' } },
        { runId, childSessionKey, requesterSessionKey },
      ),
    subagentEnded: (childSessionKey: string) =>
      fireHook(
        'subagent_ended',
        { targetSessionKey: childSessionKey, targetKind: 'subagent', reason: 'complete', outcome: 'ok' },
        { childSessionKey },
      ),
  };
}

export type FakeAgentApi = ReturnType<typeof createFakeAgentApi>;

export function channelLifecycleMock() {
  return {
    createAccountStatusSink:
      (params: { accountId: string; setStatus: (next: Record<string, unknown>) => void }) =>
      (patch: Record<string, unknown>) =>
        params.setStatus({ accountId: params.accountId, ...patch }),
    createRunStateMachine(params: { setStatus?: (patch: { busy: boolean; activeRuns: number; lastRunActivityAt?: number }) => void }) {
      let activeRuns = 0;
      let active = true;
      const publish = () => {
        if (active) params.setStatus?.({ activeRuns, busy: activeRuns > 0, lastRunActivityAt: Date.now() });
      };
      params.setStatus?.({ activeRuns: 0, busy: false });
      return {
        isActive: () => active,
        onRunStart() {
          activeRuns += 1;
          publish();
        },
        onRunEnd() {
          activeRuns = Math.max(0, activeRuns - 1);
          publish();
        },
        deactivate() {
          active = false;
        },
      };
    },
  };
}
