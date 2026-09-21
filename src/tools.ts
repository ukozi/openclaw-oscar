import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/channel-core';
import type { AnyAgentTool, OpenClawPluginToolContext } from 'openclaw/plugin-sdk/core';
import { roomKeyOf } from './chain/types.js';
import { CHANNEL_ID, listAccountIds, readPolicy, TOOL_NAMES } from './config.js';
import { copy } from './copy.js';
import type { RootPolicy } from './config.js';
import { joinExtraRoom } from './inbound/invite.js';
import { escapeNonAscii, normalizeName, parseTarget, roomNameProblem } from './names.js';
import type { RoomRef } from './names.js';
import { roleOf } from './policy.js';
import { STATUS_TOOL, createOscarStatusTool, runtimeWiring } from './presence/register.js';
import { applyRoomClosed, getRuntime, roomKey, roomsExt, runtimeForSessionKey } from './runtime.js';

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

export type RoomToolContext = {
  config?: unknown;
  runtimeConfig?: unknown;
  getRuntimeConfig?: () => unknown;
  messageChannel?: string;
  agentAccountId?: string;
  requesterSenderId?: string;
  senderIsOwner?: boolean;
};
export type RoomToolEnv = { policy?: () => RootPolicy; accountIds?: () => string[]; now?: () => number };
export type RoomToolResult = { content: { type: 'text'; text: string }[]; details: unknown };
export type RoomTool = {
  name: 'oscar_room';
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(toolCallId: string, params: unknown): Promise<RoomToolResult>;
};

const ROOM_TOOL_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: {
    action: { type: 'string', enum: ['join', 'leave', 'list'], description: 'list is open to anyone; join and leave work only when an owner asked' },
    room: { type: 'string', description: 'Room name, room:<name> or room:<exchange>:<name>. Needed for join and leave.' },
  },
};

const quietLog = { debug() {}, info() {}, warn() {}, error() {} };

function roomToolResult(text: string, details: unknown): RoomToolResult {
  return { content: [{ type: 'text', text }], details };
}

function parseRoomParam(raw: unknown, self: string): RoomRef {
  if (typeof raw !== 'string' || raw.trim() === '') throw new Error('room is required for join and leave');
  const value = raw.trim();
  const target = parseTarget(value.startsWith('room:') ? value : `room:${value}`, self);
  if (!target || target.kind !== 'room') throw new Error(`${value} is not a room name`);
  return target.room;
}

export function createRoomTool(ctx: RoomToolContext, env: RoomToolEnv = {}): RoomTool | null {
  if (ctx.messageChannel !== undefined && ctx.messageChannel !== 'oscar') return null;
  const accountId = ctx.agentAccountId;
  if (!accountId) return null;
  const cfg = (): unknown => ctx.getRuntimeConfig?.() ?? ctx.runtimeConfig ?? ctx.config;
  const accountIds = env.accountIds ?? (() => listAccountIds(cfg()));
  if (!accountIds().includes(accountId)) return null;
  const policy = env.policy ?? (() => readPolicy(cfg()));
  const now = env.now ?? Date.now;
  const owner = ctx.senderIsOwner === true;
  const by = ctx.requesterSenderId ? normalizeName(ctx.requesterSenderId) : undefined;

  return {
    name: 'oscar_room',
    label: 'Chat rooms',
    description:
      'List the chat rooms this account is in, or join or leave one. Joining and leaving work only when an owner asked.',
    parameters: structuredClone(ROOM_TOOL_PARAMETERS),
    async execute(_toolCallId, params) {
      const rt = getRuntime(accountId);
      if (!rt) throw new Error('this account is not signed on');
      const input = (typeof params === 'object' && params !== null ? params : {}) as { action?: unknown; room?: unknown };
      const live = policy();
      const self = normalizeName(rt.session.selfInfo()?.screenName ?? accountId);
      const home = live.room ? roomKey(live.room.ref) : null;
      const ext = roomsExt(rt);

      if (input.action === 'list') {
        const rooms = [...rt.rooms.entries()]
          .filter(([key]) => ext.joined.has(key))
          .map(([key, state]) => ({
            target: key,
            home: key === home,
            invitedBy: state.invitedBy ?? null,
            occupants: [...state.occupants]
              .filter((name) => name !== self)
              .map((name) => ({ name: escapeNonAscii(name), role: roleOf(name, live) }))
              .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
          }));
        return roomToolResult(JSON.stringify({ rooms }), { rooms });
      }

      if (input.action !== 'join' && input.action !== 'leave') throw new Error('action must be join, leave or list');
      if (!owner) throw new Error('only an owner can ask me to join or leave a room');
      const ref = parseRoomParam(input.room, self);
      const key = roomKey(ref);

      if (input.action === 'join') {
        const problem = roomNameProblem(ref.name);
        if (problem) throw new Error(problem);
        const outcome = await joinExtraRoom(rt, { policy, now, log: quietLog }, ref, by, () => rt.session.joinRoom(ref));
        if (outcome === 'full') throw new Error(`already in ${live.invites.maxRooms} extra rooms; leave one first`);
        if (outcome === 'failed') throw new Error(`could not join ${key}`);
        return roomToolResult(outcome === 'joined' ? `joined ${key}` : `already in ${key}`, { room: key, outcome });
      }

      if (key === home) throw new Error('that is my home room; change channels.oscar.room to move me');
      if (!rt.rooms.has(key)) throw new Error(`not in ${key}`);
      await rt.session.leaveRoom(ref);
      applyRoomClosed(rt, ref, false);
      return roomToolResult(`left ${key}`, { room: key, outcome: 'left' });
    },
  };
}

installTool('oscar_room', (ctx) => createRoomTool(ctx) as unknown as AnyAgentTool | null);
installTool(STATUS_TOOL, (ctx) => createOscarStatusTool(ctx, runtimeWiring));

export const DELEGATE_TOOL = 'oscar_delegate';

const delegateParameters = {
  type: 'object',
  additionalProperties: false,
  required: ['to', 'task'],
  properties: {
    to: { type: 'string', description: 'Screen name or alias of a teammate below you who is in this room.' },
    task: { type: 'string', description: 'The job, in one or two sentences. It is posted in the room for everyone to see.' },
  },
} as const;

export function createDelegateTool(ctx: { sessionKey?: string; requesterSenderId?: string }) {
  return {
    name: DELEGATE_TOOL,
    label: 'Hand off',
    description:
      'Hand a job to a teammate below you in this chat room. The teammate answers in the room. This is not a subagent.',
    parameters: delegateParameters,
    async execute(_toolCallId: string, params: { to?: unknown; task?: unknown }) {
      const rt = ctx.sessionKey ? runtimeForSessionKey(ctx.sessionKey) : undefined;
      const peer = ctx.sessionKey ? rt?.sessionKeys.get(ctx.sessionKey)?.peer : undefined;
      if (!rt?.chain || !peer || peer.kind !== 'room') throw new Error(copy.delegateError('not-in-room'));
      const text = await rt.chain.delegate({
        roomKey: roomKeyOf(peer.room),
        requester: ctx.requesterSenderId,
        to: String(params.to ?? ''),
        task: String(params.task ?? ''),
      });
      return { content: [{ type: 'text' as const, text }], details: { status: 'sent' as const } };
    },
  } as const;
}

installTool(DELEGATE_TOOL, (ctx) => createDelegateTool(ctx) as unknown as AnyAgentTool);
