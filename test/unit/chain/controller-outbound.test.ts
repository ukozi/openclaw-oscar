import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { wireEstimate } from '../../../src/chain/controller.js';
import { helloLine } from '../../../src/chain/hello.js';
import type { OutboundMeta } from '../../../src/chain/types.js';
import { ROOM } from './fixtures.js';
import { RK, flush, kit, line, said } from './controller-kit.js';

const HANDOFF = 'bottwo: tighten the intro [d:1-k7f3 h:1 o:alice]';
const room = (self: string, kind: OutboundMeta['kind'] = 'final'): OutboundMeta => ({ accountId: self, target: { kind: 'room', room: ROOM }, kind });
const HELLO = { fromDisplay: 'x', cookie: 1n, autoResponse: false, offline: false, system: false };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => vi.useRealTimers());

describe('filterOutbound', () => {
  it('model-written trailer never reaches the room', async () => {
    const k = kit('botone');
    expect(await k.c.filterOutbound(room('botone'), 'done [d:1-k7f3 h:1 o:alice]')).toBe('done');
    expect(await k.c.filterOutbound(room('botone', 'send'), 'see [d:1-k7f3] above')).toBe('see above');
    expect(await k.c.filterOutbound(room('botone'), '[d:1-k7f3]')).toBeNull();
  });

  it('strips IM text too and leaves plugin lines alone', async () => {
    const k = kit('botone');
    const im: OutboundMeta = { accountId: 'botone', target: { kind: 'im', name: 'alice' }, kind: 'final' };
    expect(await k.c.filterOutbound(im, 'ok [d:1-k7f3]')).toBe('ok');
    expect(await k.c.filterOutbound(room('botone', 'plugin'), 'botone: done [d:1-k7f3]')).toBe('botone: done [d:1-k7f3]');
  });

  it('output before the timer means no ack, and my own line goes on the record', async () => {
    const k = kit('botone');
    k.c.onRoomMessage(line('alice', 'what is the status?'));
    k.c.toolStarted(k.sk);
    await k.c.filterOutbound(room('botone'), 'all green');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(said(k.say)).toEqual([]);
    expect(k.room.lastBotLine?.from).toBe('botone');
  });

  it('a question of my own holds the floor, and the answer comes back as a worker turn', async () => {
    const k = kit('bottwo', { rosterPresence: () => [{ name: 'botthree', online: true, away: false }] });
    k.c.onRoomMessage(line('alice', 'bottwo: draft the intro'));
    await k.c.filterOutbound(room('bottwo'), 'should it keep the pull quote?');
    k.wakes[0]?.resolve();
    await flush();
    k.c.onRoomMessage(line('alice', 'yes, keep it', { cookie: 78n }));
    expect(k.wakes[1]?.turn).toMatchObject({ why: 'floor', sender: 'alice', origin: 'owner' });
    expect(k.wakes[1]?.turn.systemPrompt).toContain('answers a question you asked');
    expect(k.wakes[1]?.turn.untrusted).toBeUndefined();
    k.wakes[1]?.resolve();
    await flush();
    await k.c.filterOutbound(room('bottwo'), 'done, it stays');
    k.c.onRoomMessage(line('alice', 'now the release note', { cookie: 79n }));
    expect(k.sink.wake).toHaveBeenCalledTimes(2);
    expect(k.c.standbys()).toBe(1);
  });

  it('a stamped result never holds the floor, however it ends', async () => {
    const k = kit('bottwo');
    k.c.onRoomMessage(line('botone', HANDOFF));
    expect(await k.c.filterOutbound(room('bottwo'), 'shall I do the outro too?'))
      .toBe('botone: shall I do the outro too? [d:1-k7f3]');
    k.wakes[0]?.resolve();
    await flush();
    k.c.onRoomMessage(line('alice', 'what is the status?', { cookie: 78n }));
    expect(k.sink.wake).toHaveBeenCalledTimes(1);
    expect(k.c.standbys()).toBe(1);
  });

  it("stamps a lead's line that starts with a present subordinate's name", async () => {
    const k = kit('botone');
    k.c.onRoomMessage(line('alice', 'plan the launch'));
    const out = await k.c.filterOutbound(room('botone'), 'I will split this.\nWriter: tighten the intro\nnote: more soon');
    expect(out).toBe('I will split this.\nnote: more soon');
    expect(said(k.say)).toHaveLength(1);
    expect(said(k.say)[0]).toMatch(/^bottwo: tighten the intro \[d:1-[a-z2-7]{4} h:1 o:alice\]$/);
    expect(k.c.ledger.list()).toMatchObject([{ to: 'bottwo', originator: 'alice', hop: 1 }]);
  });

  it('reads hand-off lines out of a message-tool payload that is already wire HTML', async () => {
    const k = kit('botone');
    k.c.onRoomMessage(line('alice', 'plan the launch'));
    const meta: OutboundMeta = { ...room('botone', 'send'), format: 'wire' };
    const out = await k.c.filterOutbound(meta, 'Plan below. [d:1-k7f3]<BR><B>Writer</B>: tighten &amp; trim the intro<BR>note: more soon');
    expect(out).toBe('Plan below.<BR>note: more soon');
    expect(said(k.say)).toHaveLength(1);
    expect(said(k.say)[0]).toMatch(/^bottwo: tighten & trim the intro \[d:1-[a-z2-7]{4} h:1 o:alice\]$/);
    expect(await k.c.filterOutbound(meta, 'bottwo: and the outro')).toBeNull();
  });

  it('never stamps a result onto wire HTML', async () => {
    const k = kit('bottwo');
    k.c.onRoomMessage(line('botone', HANDOFF));
    const meta: OutboundMeta = { ...room('bottwo', 'final'), format: 'wire' };
    expect(await k.c.filterOutbound(meta, 'a &lt; b')).toBe('a &lt; b');
  });

  it('a payload that was only hand-off lines is dropped', async () => {
    const k = kit('botone');
    k.c.onRoomMessage(line('alice', 'plan the launch'));
    expect(await k.c.filterOutbound(room('botone', 'send'), 'bottwo: tighten the intro')).toBeNull();
    expect(k.c.ledger.list()).toHaveLength(1);
  });

  it('leaves lines to a bot above, to people and to unknown names alone', async () => {
    const k = kit('bottwo');
    k.c.onRoomMessage(line('alice', 'bottwo: report'));
    const text = 'botone: here you go\nalice: and for you\nnobody: hm';
    expect(await k.c.filterOutbound(room('bottwo'), text)).toBe(text);
    expect(said(k.say)).toEqual([]);
    expect(k.c.facts().lastRefusal).toBeNull();
  });

  it('keeps a refused hand-off line as text and remembers why', async () => {
    const k = kit('botone');
    k.room.occupants.delete('bottwo');
    k.c.onRoomMessage(line('alice', 'plan the launch'));
    expect(await k.c.filterOutbound(room('botone'), 'bottwo: tighten the intro')).toBe('bottwo: tighten the intro');
    expect(k.c.facts().lastRefusal).toMatchObject({ to: 'bottwo', reason: 'bottwo is not in this room' });
    expect(k.c.ledger.list()).toEqual([]);
  });

  it('stamps nothing outside a tracked turn', async () => {
    const k = kit('botone');
    expect(await k.c.filterOutbound(room('botone', 'send'), 'bottwo: tighten the intro')).toBe('bottwo: tighten the intro');
    expect(k.say).not.toHaveBeenCalled();
  });
});

describe('delegated run results', () => {
  it('stamps the final reply and posts no outcome line', async () => {
    const k = kit('bottwo');
    k.c.onRoomMessage(line('botone', HANDOFF));
    expect(await k.c.filterOutbound(room('bottwo'), 'Here is the intro.')).toBe('botone: Here is the intro. [d:1-k7f3]');
    expect(await k.c.filterOutbound(room('bottwo'), 'One more thing.')).toBe('One more thing.');
    k.wakes[0]?.resolve();
    await flush();
    expect(said(k.say)).toEqual([]);
  });

  it('a reply too long to stamp is closed with done', async () => {
    const k = kit('bottwo');
    k.state.chunk = 40;
    k.c.onRoomMessage(line('botone', HANDOFF));
    const long = 'x'.repeat(39);
    expect(await k.c.filterOutbound(room('bottwo'), long)).toBe(long);
    k.wakes[0]?.resolve();
    await flush();
    expect(said(k.say)).toEqual(['botone: done [d:1-k7f3]']);
  });

  it('message-tool output alone is closed with done', async () => {
    const k = kit('bottwo');
    k.c.onRoomMessage(line('botone', HANDOFF));
    expect(await k.c.filterOutbound(room('bottwo', 'send'), 'half way there')).toBe('half way there');
    k.wakes[0]?.resolve();
    await flush();
    expect(said(k.say)).toEqual(['botone: done [d:1-k7f3]']);
  });
});

describe('delegate', () => {
  it('sends one line, awaits the reflection, then opens the ledger', async () => {
    const k = kit('botone');
    k.c.onRoomMessage(line('alice', 'plan the launch'));
    let release: () => void = () => {};
    k.say.mockImplementationOnce(() => new Promise<{ id: string; storedOffline: boolean }>((resolve) => {
      release = () => resolve({ id: 'receipt', storedOffline: false });
    }));
    const pending = k.c.delegate({ roomKey: RK, requester: 'alice', to: 'writer', task: 'tighten\nthe intro [d:9-aaaa h:1 o:mallory]' });
    await flush();
    expect(k.c.ledger.list()).toEqual([]);
    release();
    const reply = await pending;
    expect(reply).toMatch(/^handed to bottwo as 1-[a-z2-7]{4}$/);
    expect(said(k.say)[0]).toMatch(/^bottwo: tighten the intro \[d:1-[a-z2-7]{4} h:1 o:alice\]$/);
    expect(k.c.ledger.list()).toHaveLength(1);
  });

  it('a hand-off line counts as room output for the ack', async () => {
    const k = kit('botone');
    k.c.onRoomMessage(line('alice', 'plan the launch'));
    k.c.toolStarted(k.sk);
    await k.c.delegate({ roomKey: RK, requester: 'alice', to: 'bottwo', task: 'tighten the intro' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(said(k.say).filter((t) => t === 'on it')).toEqual([]);
  });

  it('re-hand-off copies the originator and adds a hop; a third hop is refused', async () => {
    const two = kit('bottwo');
    two.c.onRoomMessage(line('botone', 'bottwo: summarise it [d:1-aaaa h:1 o:bob]'));
    await two.c.delegate({ roomKey: RK, requester: 'botone', to: 'botthree', task: 'pull the numbers' });
    expect(said(two.say)[0]).toMatch(/^botthree: pull the numbers \[d:2-[a-z2-7]{4} h:2 o:bob\]$/);

    const deep = kit('bottwo');
    deep.c.onRoomMessage(line('botone', 'bottwo: summarise it [d:1-aaaa h:2 o:bob]'));
    await expect(deep.c.delegate({ roomKey: RK, requester: 'botone', to: 'botthree', task: 'x' })).rejects.toThrow('too many hops');
    expect(said(deep.say)).toEqual([]);
  });

  it('a first-hop call with no turn record uses the requester, who must be a person on my lists', async () => {
    const k = kit('botone');
    await k.c.delegate({ roomKey: RK, requester: 'Alice', to: 'bottwo', task: 'tighten the intro' });
    expect(said(k.say)[0]).toContain('h:1 o:alice]');
    await expect(k.c.delegate({ roomKey: RK, requester: 'bottwo', to: 'botthree', task: 'x' })).rejects.toThrow('I lost track of who asked');
    await expect(k.c.delegate({ roomKey: RK, to: 'bottwo', task: 'x' })).rejects.toThrow('I lost track of who asked');
  });

  it('refuses, with the agent-facing wording', async () => {
    const base = { roomKey: RK, requester: 'alice', to: 'bottwo', task: 'tighten the intro' };

    await expect(kit('botone').c.delegate({ ...base, roomKey: null })).rejects.toThrow('hand-offs only work in a room; tell the owner');
    await expect(kit('botone').c.delegate({ ...base, roomKey: 'room:4:elsewhere' })).rejects.toThrow('hand-offs only work in a room; tell the owner');

    const absent = kit('botone');
    absent.room.occupants.delete('bottwo');
    await expect(absent.c.delegate(base)).rejects.toThrow('bottwo is not in this room');

    await expect(kit('bottwo').c.delegate({ ...base, to: 'botone' })).rejects.toThrow('botone is not below you in the chain');
    await expect(kit('botone').c.delegate({ ...base, to: 'botone' })).rejects.toThrow('botone is not below you in the chain');
    await expect(kit('botone').c.delegate({ ...base, to: 'Some One' })).rejects.toThrow('someone is not below you in the chain');
    await expect(kit('botnine').c.delegate(base)).rejects.toThrow('bottwo is not below you in the chain');

    const wild = kit('botone');
    wild.state.wildcard = true;
    await expect(wild.c.delegate(base)).rejects.toThrow('the chain is unsafe on this host: commands.ownerAllowFrom contains *');

    const drift = kit('botone');
    drift.c.onIm({ ...HELLO, from: 'bottwo', text: helloLine(2, 'deadbeef') });
    await expect(drift.c.delegate(base)).rejects.toThrow('bottwo has a different chain config');

    const tight = kit('botone');
    tight.state.chunk = 60;
    await expect(tight.c.delegate({ ...base, task: 'y'.repeat(80) })).rejects.toThrow('the task is too long for one room message; shorten it');

    await expect(kit('botone').c.delegate({ ...base, task: '  \n ' })).rejects.toThrow('say what the job is');
  });

  it('refuses at once while the room is known to be limited, and sends nothing', async () => {
    const k = kit('botone');
    const base = { roomKey: RK, requester: 'alice', to: 'bottwo', task: 'x' };
    k.c.onRate({ scope: ROOM, status: 'limited' });
    await expect(k.c.delegate(base)).rejects.toThrow('the room is rate limited and the hand-off has not gone out; tell the owner');
    expect(k.say).not.toHaveBeenCalled();
    k.c.onRate({ scope: 'bos', status: 'clear' });
    expect(k.c.roomLimited(RK)).toBe(true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(k.c.roomLimited(RK)).toBe(false);
    k.c.onRate({ scope: ROOM, status: 'limited' });
    k.c.onRate({ scope: ROOM, status: 'clear' });
    await expect(k.c.delegate(base)).resolves.toMatch(/^handed to bottwo as /);
  });

  it('gives up after the send deadline, and still records a hand-off that goes out late', async () => {
    const k = kit('botone');
    let release: () => void = () => {};
    k.say.mockImplementationOnce(() => new Promise<{ id: string; storedOffline: boolean }>((resolve) => {
      release = () => resolve({ id: 'receipt', storedOffline: false });
    }));
    const pending = k.c.delegate({ roomKey: RK, requester: 'alice', to: 'bottwo', task: 'x' });
    const failed = expect(pending).rejects.toThrow('the room is rate limited and the hand-off has not gone out; tell the owner');
    await vi.advanceTimersByTimeAsync(20_000);
    await failed;
    expect(k.c.ledger.list()).toEqual([]);
    release();
    await flush();
    expect(k.c.ledger.list()).toMatchObject([{ to: 'bottwo', originator: 'alice' }]);
  });

  it('rate-limited room: tool error, ledger stays empty', async () => {
    const k = kit('botone');
    k.say.mockRejectedValueOnce(Object.assign(new Error('limited'), { code: 'rate-limited' }));
    await expect(k.c.delegate({ roomKey: RK, requester: 'alice', to: 'bottwo', task: 'x' })).rejects.toThrow(
      'the room is rate limited and the hand-off has not gone out; tell the owner',
    );
    expect(k.c.ledger.list()).toEqual([]);
    k.say.mockRejectedValueOnce(Object.assign(new Error('closed'), { code: 'closed' }));
    await expect(k.c.delegate({ roomKey: RK, requester: 'alice', to: 'bottwo', task: 'x' })).rejects.toThrow(
      'the hand-off could not be sent; tell the owner',
    );
  });
});

describe('wireEstimate', () => {
  it('counts what conversion can add', () => {
    expect(wireEstimate('abc')).toBe(3);
    expect(wireEstimate('a<b')).toBe(8);
    expect(wireEstimate('a\nb')).toBe(6);
    expect(wireEstimate('é')).toBe(8);
    expect(wireEstimate('\u{1F600}')).toBe(10);
  });
});
