import { vi } from 'vitest';

type Rec = Record<string, unknown>;

export type GatewayTurn = {
  accountId: string; sessionKey: string; runId: string;
  from: string; body: string;
  commandAuthorized: boolean; systemPrompt: string; context: string; toolDeny: string[];
  startedAt: number; endedAt: number | null;
};
export type AgentHandle = {
  reply(text: string): void;
  tool(name: string, params: Rec): Promise<{ ok: boolean; text: string }>;
  sleep(ms: number): Promise<void>;
};
export type AgentScript = (turn: GatewayTurn, agent: AgentHandle) => Promise<void>;
export type GatewayOptions = { cfg: Rec; noticeWindowMs?: number; imDebounceMs?: number };
export interface LiveGateway {
  start(): Promise<void>;
  stop(): Promise<void>;
  setAgent(script: AgentScript): void;
  runs(accountId?: string): GatewayTurn[];
  issues(accountId: string): Promise<string[]>;
  toolNames(): string[];
  agentSend(accountId: string, to: string, text: string): Promise<{ ok: boolean; error: string }>;
}

// SDK subpath, the export of test/fake/openclaw.ts that stands in for it, and whether that export is a
// function to call. It must name every SDK subpath that src/ imports at run time.
const MOCKS: [string, string, boolean][] = [
  ['openclaw/plugin-sdk/channel-inbound', 'channelInbound', false],
  ['openclaw/plugin-sdk/routing', 'routing', false],
  ['openclaw/plugin-sdk/session-store-runtime', 'sessionStoreRuntime', false],
  ['openclaw/plugin-sdk/conversation-runtime', 'conversationRuntime', false],
  ['openclaw/plugin-sdk/reply-dispatch-runtime', 'replyDispatchRuntime', false],
  ['openclaw/plugin-sdk/channel-ingress-runtime', 'channelIngressRuntime', false],
  ['openclaw/plugin-sdk/channel-outbound', 'channelOutbound', false],
  ['openclaw/plugin-sdk/channel-reply-pipeline', 'channelReplyPipeline', false],
  ['openclaw/plugin-sdk/reply-chunking', 'replyChunking', false],
  ['openclaw/plugin-sdk/channel-core', 'channelCore', false],
  ['openclaw/plugin-sdk/status-helpers', 'statusHelpers', false],
  ['openclaw/plugin-sdk/channel-lifecycle', 'channelLifecycleMock', true],
];

type FakeModule = {
  sdk: {
    inbound: { ctx: Rec; runId: string }[];
    agent: (ctx: Rec) => Promise<{ text: string }[]> | { text: string }[];
    usePlugin(plugin: unknown): void;
    messageTool(p: { cfg: unknown; accountId: string; to: string; text: string }): Promise<void>;
  };
  createFakeAgentApi(opts?: { config?: () => unknown }): {
    api: Rec;
    emitLifecycle(runId: string, phase: string, sessionKey?: string): Promise<void>;
    callTool(call: { toolName: string; params: Rec; runId: string; sessionKey: string }, toolCtx: Rec): Promise<unknown>;
  };
};

type PluginShape = {
  config: { listAccountIds(cfg: unknown): string[]; resolveAccount(cfg: unknown, accountId?: string | null): unknown };
  gateway: { startAccount(ctx: Rec): Promise<unknown>; stopAccount?(ctx: Rec): Promise<void> };
  groups?: { resolveToolPolicy?(p: Rec): { deny?: string[] } | undefined };
  status?: {
    buildAccountSnapshot?(p: { account: unknown; cfg: unknown; runtime?: Rec }): Rec | Promise<Rec>;
    collectStatusIssues?(accounts: Rec[]): { accountId?: string; message: string }[];
  };
};

const normalize = (name: unknown): string => String(name ?? '').replace(/ /g, '').toLowerCase();
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function resultText(result: unknown): string {
  const content = (result as { content?: { text?: string }[] } | undefined)?.content;
  return content?.map((c) => c.text ?? '').join('\n') ?? JSON.stringify(result ?? null);
}

export async function bootGateway(opts: GatewayOptions): Promise<LiveGateway> {
  // A fresh module graph per gateway: each one is its own plugin instance with its own fake host,
  // the way two gateway processes would be. Only the globalThis runtime holder is shared, by design.
  vi.resetModules();
  for (const [subpath, name, isCall] of MOCKS) {
    vi.doMock(subpath, async () => {
      const mod = (await import('../../fake/openclaw.js')) as unknown as Rec;
      const value = mod[name];
      return (isCall ? (value as () => unknown)() : value) as Rec;
    });
  }
  const fake = (await import('../../fake/openclaw.js')) as unknown as FakeModule;
  const entry = ((await import('../../../src/index.js')) as unknown as { default: { register(api: Rec): void } }).default;
  if (opts.noticeWindowMs !== undefined) {
    const notice = (await import('../../../src/notice.js')) as unknown as { NOTICE_TIMING: { windowMs: number } };
    notice.NOTICE_TIMING.windowMs = opts.noticeWindowMs;
  }
  if (opts.imDebounceMs !== undefined) {
    const im = (await import('../../../src/inbound/im.js')) as unknown as { IM_TIMING: { debounceMs: number } };
    im.IM_TIMING.debounceMs = opts.imDebounceMs;
  }

  // The login budget hangs off the shared globalThis holder, so a fourth gateway in one file would
  // sit out the server's per-minute login allowance. A real process starts with a fresh one.
  const holder = (globalThis as unknown as Record<symbol, { budget?: unknown } | undefined>)[Symbol.for('openclaw-oscar.runtime')];
  if (holder) delete holder.budget;

  const cfg = opts.cfg;
  const owners = new Set((((cfg.commands as Rec | undefined)?.ownerAllowFrom as string[] | undefined) ?? []).map((o) => normalize(o.replace(/^oscar:/, ''))));

  const agentApi = fake.createFakeAgentApi({ config: () => cfg });
  const tools = new Set<string>();
  let plugin: PluginShape | undefined;
  const api: Rec = {
    ...agentApi.api,
    registerChannel: (reg: { plugin: unknown }) => {
      plugin = reg.plugin as PluginShape;
      fake.sdk.usePlugin(reg.plugin);
    },
    registerTool: (tool: unknown, toolOpts?: { names?: string[] }) => {
      for (const n of toolOpts?.names ?? []) tools.add(n);
      (agentApi.api.registerTool as (t: unknown, o?: unknown) => void)(tool, toolOpts);
    },
  };
  entry.register(api);
  if (!plugin) throw new Error('the plugin entry did not register a channel');
  const loaded: PluginShape = plugin;

  const turns: GatewayTurn[] = [];
  let script: AgentScript = async () => {};
  let extraRuns = 0;
  fake.sdk.agent = async (ctx) => {
    const sessionKey = String(ctx.SessionKey ?? '');
    const accountId = String(ctx.AccountId ?? '');
    const from = normalize(ctx.SenderId);
    const runId = fake.sdk.inbound.find((r) => r.ctx === ctx)?.runId ?? `run-extra-${++extraRuns}`;
    const groupId = sessionKey.includes(':group:') ? sessionKey.slice(sessionKey.indexOf(':group:') + 7) : undefined;
    const policy = loaded.groups?.resolveToolPolicy?.({ cfg, groupId, accountId, senderId: ctx.SenderId });
    const turn: GatewayTurn = {
      accountId, sessionKey, runId, from,
      body: String(ctx.Body ?? ''),
      commandAuthorized: ctx.CommandAuthorized === true,
      systemPrompt: String(ctx.GroupSystemPrompt ?? ''),
      context: JSON.stringify(ctx.UntrustedStructuredContext ?? []),
      toolDeny: [...(policy?.deny ?? [])],
      startedAt: Date.now(), endedAt: null,
    };
    turns.push(turn);
    const replies: { text: string }[] = [];
    const handle: AgentHandle = {
      reply: (text) => { replies.push({ text }); },
      sleep,
      tool: async (toolName, params) => {
        try {
          const result = await agentApi.callTool(
            { toolName, params, runId, sessionKey },
            { sessionKey, agentAccountId: accountId, requesterSenderId: ctx.SenderId, senderIsOwner: owners.has(from) },
          );
          return { ok: true, text: resultText(result) };
        } catch (err) {
          return { ok: false, text: err instanceof Error ? err.message : String(err) };
        }
      },
    };
    await agentApi.emitLifecycle(runId, 'start', sessionKey);
    let phase = 'end';
    try {
      await script(turn, handle);
    } catch {
      phase = 'error';
    }
    turn.endedAt = Date.now();
    await agentApi.emitLifecycle(runId, phase, sessionKey);
    return replies;
  };

  const running = new Map<string, { ctx: Rec; abort: AbortController; readonly snapshot: Rec }>();
  return {
    async start() {
      for (const accountId of loaded.config.listAccountIds(cfg)) {
        const abort = new AbortController();
        const entryState = { snapshot: { accountId } as Rec };
        const ctx: Rec = {
          cfg, accountId,
          account: loaded.config.resolveAccount(cfg, accountId),
          runtime: (api.runtime ?? {}) as Rec,
          abortSignal: abort.signal,
          log: { debug() {}, info() {}, warn() {}, error() {} },
          getStatus: () => entryState.snapshot,
          setStatus: (next: Rec) => { entryState.snapshot = { ...entryState.snapshot, ...next }; },
        };
        running.set(accountId, { ctx, abort, get snapshot() { return entryState.snapshot; } });
        void Promise.resolve(loaded.gateway.startAccount(ctx)).catch((err: unknown) => {
          entryState.snapshot = { ...entryState.snapshot, lastError: err instanceof Error ? err.message : String(err) };
        });
      }
      // startAccount resolves only when the account has stopped, so wait on the status the plugin
      // publishes: an IM sent to a bot that has not signed on yet is dropped by the server.
      const deadline = Date.now() + 30_000;
      for (const [accountId, state] of running) {
        while (state.snapshot.connected !== true) {
          if (Date.now() >= deadline) {
            throw new Error(`${accountId} did not sign on: ${String(state.snapshot.lastError ?? 'no error reported')}`);
          }
          await sleep(50);
        }
      }
    },
    async stop() {
      for (const { ctx, abort } of running.values()) {
        abort.abort();
        await loaded.gateway.stopAccount?.(ctx);
      }
      running.clear();
    },
    setAgent(next) {
      script = next;
    },
    runs(accountId) {
      return turns.filter((t) => !accountId || t.accountId === accountId);
    },
    async issues(accountId) {
      const runtime = running.get(accountId)?.snapshot ?? { accountId };
      const account = loaded.config.resolveAccount(cfg, accountId);
      const built = (await loaded.status?.buildAccountSnapshot?.({ account, cfg, runtime })) ?? runtime;
      const collected = loaded.status?.collectStatusIssues?.([built]) ?? [];
      const messages = collected.filter((i) => !i.accountId || i.accountId === accountId).map((i) => i.message);
      return typeof runtime.lastError === 'string' ? [...messages, runtime.lastError] : messages;
    },
    toolNames() {
      return [...tools].sort();
    },
    async agentSend(accountId, to, text) {
      try {
        await fake.sdk.messageTool({ cfg, accountId, to, text });
        return { ok: true, error: '' };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
