import { afterEach, describe, expect, it } from 'vitest';
import type { RootPolicy } from '../../src/config.js';
import type { RoomRef } from '../../src/names.js';
import { applyRoomClosed, applyRoomReady, clearRuntime, roomsExt, setRuntime } from '../../src/runtime.js';
import { createRoomTool, registerOscarTools } from '../../src/tools.js';
import type { RoomToolContext } from '../../src/tools.js';
import { ROOM, fakeSession, makeRt, policyFixture } from './rooms-fixtures.js';

const DEN: RoomRef = { exchange: 4, name: 'bobsden' };
const DEN_KEY = 'room:4:bobsden';

function env(over: Partial<RootPolicy> = {}) {
  return { policy: () => policyFixture(over), accountIds: () => ['botone'], now: () => 1000 };
}

function ctx(over: Partial<RoomToolContext> = {}): RoomToolContext {
  return { messageChannel: 'oscar', agentAccountId: 'botone', requesterSenderId: 'Alice', senderIsOwner: true, ...over };
}

function running() {
  const fake = fakeSession();
  const rt = makeRt(fake.session);
  applyRoomReady(rt, ROOM, ['botone', 'alice', 'mallory', 'alicе'], 'botone', 1);
  setRuntime(rt);
  return { fake, rt };
}

afterEach(() => {
  clearRuntime('botone');
});

describe('factory', () => {
  it('returns null only from keyed context and config', () => {
    expect(createRoomTool(ctx({ messageChannel: 'discord' }), env())).toBeNull();
    expect(createRoomTool(ctx({ agentAccountId: undefined }), env())).toBeNull();
    expect(createRoomTool(ctx({ agentAccountId: 'other' }), env())).toBeNull();
    expect(createRoomTool(ctx({ messageChannel: undefined }), env())?.name).toBe('oscar_room');
    expect(createRoomTool(ctx({ senderIsOwner: false }), env())?.name).toBe('oscar_room');
  });

  it('returns a fresh object with fresh parameters every call', () => {
    const a = createRoomTool(ctx(), env());
    const b = createRoomTool(ctx(), env());
    expect(a).not.toBe(b);
    expect(a?.parameters).not.toBe(b?.parameters);
    expect(a?.parameters).toEqual(b?.parameters);
    expect(a?.parameters).toMatchObject({ type: 'object', required: ['action'] });
  });

  it('does not look at the connection when deciding, only when running', async () => {
    const tool = createRoomTool(ctx(), env());
    expect(tool).not.toBeNull();
    await expect(tool?.execute('t1', { action: 'list' })).rejects.toThrow('not signed on');
  });
});

describe('registration', () => {
  it('is installed under its name when the module loads', () => {
    type Factory = (ctx: Record<string, unknown>) => unknown;
    const registered: { factory: Factory; names?: string[] }[] = [];
    const api = { registerTool: (factory: unknown, opts?: { names?: string[] }) => registered.push({ factory: factory as Factory, names: opts?.names }) };
    registerOscarTools(api as never);
    const room = registered.find((r) => r.names?.[0] === 'oscar_room');
    const config = { channels: { oscar: { host: 'h', screenName: 'botone', password: 'hunter22', owners: ['alice'] } } };
    expect(room?.factory({ messageChannel: 'oscar', agentAccountId: 'default', config })).toMatchObject({ name: 'oscar_room' });
    expect(room?.factory({ messageChannel: 'oscar', agentAccountId: 'nobody', config })).toBeNull();
    expect(room?.factory({ messageChannel: 'slack', agentAccountId: 'default', config })).toBeNull();
  });
});

describe('list', () => {
  it('is open to anyone and shows roles with escaped names', async () => {
    const { rt } = running();
    roomsExt(rt).invitedBy.set(DEN_KEY, 'bob');
    applyRoomReady(rt, DEN, ['botone', 'bob'], 'botone', 1);
    const tool = createRoomTool(ctx({ senderIsOwner: false, requesterSenderId: 'bob' }), env());
    const result = await tool?.execute('t1', { action: 'list' });
    expect(result?.details).toEqual({
      rooms: [
        {
          target: 'room:4:testroom',
          home: true,
          invitedBy: null,
          occupants: [
            { name: 'alic\\u{435}', role: 'unlisted' },
            { name: 'alice', role: 'owner' },
            { name: 'mallory', role: 'unlisted' },
          ],
        },
        { target: DEN_KEY, home: false, invitedBy: 'bob', occupants: [{ name: 'bob', role: 'approved' }] },
      ],
    });
    expect(result?.content[0]?.text).toBe(JSON.stringify(result?.details));
  });

  it('leaves out a room that is waiting to be rejoined', async () => {
    const { rt } = running();
    applyRoomReady(rt, DEN, ['botone', 'bob'], 'botone', 1);
    applyRoomClosed(rt, DEN, true);
    const result = await createRoomTool(ctx(), env())?.execute('t1', { action: 'list' });
    expect(result?.details).toMatchObject({ rooms: [{ target: 'room:4:testroom', home: true }] });
  });
});

describe('join and leave', () => {
  it('refuses both for anyone but an owner', async () => {
    const { fake } = running();
    const tool = createRoomTool(ctx({ senderIsOwner: false, requesterSenderId: 'bob' }), env());
    await expect(tool?.execute('t1', { action: 'join', room: 'bobsden' })).rejects.toThrow('only an owner');
    await expect(tool?.execute('t2', { action: 'leave', room: 'testroom' })).rejects.toThrow('only an owner');
    const unknown = createRoomTool(ctx({ senderIsOwner: undefined }), env());
    await expect(unknown?.execute('t3', { action: 'join', room: 'bobsden' })).rejects.toThrow('only an owner');
    expect(fake.calls.joinRoom).toEqual([]);
    expect(fake.calls.leaveRoom).toEqual([]);
  });

  it('joins a session room for an owner and records who asked', async () => {
    const { fake, rt } = running();
    const result = await createRoomTool(ctx(), env())?.execute('t1', { action: 'join', room: 'BobsDen' });
    expect(fake.calls.joinRoom).toEqual([{ room: DEN, persistent: false }]);
    expect(roomsExt(rt).invitedBy.get(DEN_KEY)).toBe('alice');
    expect(result?.content[0]?.text).toBe(`joined ${DEN_KEY}`);
  });

  it('accepts the room: forms', async () => {
    const { fake } = running();
    await createRoomTool(ctx(), env())?.execute('t1', { action: 'join', room: 'room:4:bobsden' });
    expect(fake.calls.joinRoom).toEqual([{ room: DEN, persistent: false }]);
  });

  it('says already for a room it is in, the home room included', async () => {
    const { fake } = running();
    const result = await createRoomTool(ctx(), env())?.execute('t1', { action: 'join', room: 'testroom' });
    expect(result?.content[0]?.text).toBe('already in room:4:testroom');
    expect(fake.calls.joinRoom).toEqual([]);
  });

  it('rejects a bad name, a missing name and an unknown action', async () => {
    running();
    const tool = createRoomTool(ctx(), env());
    await expect(tool?.execute('t1', { action: 'join', room: 'bad-name' })).rejects.toThrow();
    await expect(tool?.execute('t2', { action: 'join' })).rejects.toThrow('room is required');
    await expect(tool?.execute('t3', { action: 'dance' })).rejects.toThrow('action must be');
    await expect(tool?.execute('t4', undefined)).rejects.toThrow('action must be');
  });

  it('refuses a join at the cap', async () => {
    const { fake, rt } = running();
    applyRoomReady(rt, { exchange: 4, name: 'first' }, ['botone'], 'botone', 1);
    const tool = createRoomTool(ctx(), env({ invites: { accept: 'approved', maxRooms: 1, leaveWhenAloneMinutes: 10 } }));
    await expect(tool?.execute('t1', { action: 'join', room: 'bobsden' })).rejects.toThrow('leave one first');
    expect(fake.calls.joinRoom).toEqual([]);
  });

  it('reports a failed join as a tool error', async () => {
    const { fake } = running();
    fake.fail.joinRoom = new Error('chatnav dropped');
    await expect(createRoomTool(ctx(), env())?.execute('t1', { action: 'join', room: 'bobsden' })).rejects.toThrow(`could not join ${DEN_KEY}`);
  });

  it('leaves a joined room, never the home room, never a room it is not in', async () => {
    const { fake, rt } = running();
    applyRoomReady(rt, DEN, ['botone', 'bob'], 'botone', 1);
    const tool = createRoomTool(ctx(), env());
    expect((await tool?.execute('t1', { action: 'leave', room: 'bobsden' }))?.content[0]?.text).toBe(`left ${DEN_KEY}`);
    expect(fake.calls.leaveRoom).toEqual([DEN]);
    await expect(tool?.execute('t2', { action: 'leave', room: 'testroom' })).rejects.toThrow('home room');
    await expect(tool?.execute('t3', { action: 'leave', room: 'nowhere' })).rejects.toThrow('not in room:4:nowhere');
  });

  it('leaves a room that is waiting to be rejoined and frees its seat under the cap', async () => {
    const { fake, rt } = running();
    roomsExt(rt).invitedBy.set(DEN_KEY, 'bob');
    applyRoomReady(rt, DEN, ['botone', 'bob'], 'botone', 1);
    applyRoomClosed(rt, DEN, true);
    await createRoomTool(ctx(), env())?.execute('t1', { action: 'leave', room: 'bobsden' });
    expect(fake.calls.leaveRoom).toEqual([DEN]);
    expect(rt.rooms.has(DEN_KEY)).toBe(false);
    expect(roomsExt(rt).invitedBy.has(DEN_KEY)).toBe(false);
  });
});
