import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { helloLine } from '../../../src/chain/hello.js';
import { TEAM_FACT_NOTE } from '../../../src/chain/prompts.js';
import { chainConfig, policyFixture, ROOM } from './fixtures.js';
import { RK, flush, kit, line, said } from './controller-kit.js';

const HANDOFF = 'bottwo: tighten the intro [d:1-k7f3 h:1 o:alice]';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => vi.useRealTimers());

describe('wake and standby', () => {
  it('the chair wakes on an unnamed owner line and whispers took to the next rank', () => {
    const k = kit('botone');
    k.c.onRoomMessage(line('alice', 'what is the status?'));
    expect(k.sink.wake).toHaveBeenCalledTimes(1);
    const turn = k.wakes[0]?.turn;
    expect(turn).toMatchObject({ sender: 'alice', originator: 'alice', origin: 'owner', why: 'lead', commandAuthorized: true, body: 'what is the status?' });
    expect(turn?.systemPrompt).toContain('decide who should answer');
    expect(turn?.botLoopProtection).toBeUndefined();
    expect(k.say).toHaveBeenCalledWith(ROOM, '#oc took alice:4d', { whisperTo: 'bottwo', priority: 'control' });
  });

  it('gives the chair each teammate\'s role, who is busy and which jobs are open', () => {
    const presence = [{ name: 'bottwo', online: true, away: true }, { name: 'botthree', online: false, away: false }];
    const chair = kit('botone', { rosterPresence: () => presence });
    chair.room.selfJoinedAt = 1_000_000 - 3 * 60_000;
    chair.c.onRoomMessage(line('bottwo', 'botthree: check the build [d:2-aaaa h:2 o:alice]'));
    chair.c.onRoomMessage(line('alice', 'what is the status?', { cookie: 78n }));
    expect(chair.sink.wake).toHaveBeenCalledTimes(1);
    expect(chair.wakes[0]?.turn.untrusted).toEqual([
      {
        label: 'Team', source: 'oscar', type: 'oscar_chain_team',
        payload: {
          teammates: [
            { name: 'bottwo', role: 'writing and editing', online: true, busy: true },
            { name: 'botthree', role: 'code and shell work', online: false, busy: false },
          ],
          openJobs: [{ id: '2-aaaa', to: 'botthree', by: 'bottwo', for: 'alice', minutes: 0 }],
          watchingMinutes: 3,
          note: TEAM_FACT_NOTE,
        },
      },
    ]);
  });

  it('drops an observed job when its holder leaves the room', () => {
    const presence = [{ name: 'bottwo', online: true, away: false }];
    const chair = kit('botone', { rosterPresence: () => presence });
    chair.c.onRoomMessage(line('bottwo', 'botthree: check the build [d:2-aaaa h:2 o:alice]'));
    chair.c.onRoomLeave({ room: ROOM, name: 'botthree', display: 'botthree' });
    chair.c.onRoomMessage(line('alice', 'what is the status?', { cookie: 78n }));
    const payload = chair.wakes[0]?.turn.untrusted?.[0]?.payload as { openJobs: unknown[] };
    expect(payload.openJobs).toEqual([]);
  });

  it('closes an observed job on the holder\'s result line', () => {
    const presence = [{ name: 'bottwo', online: true, away: false }];
    const chair = kit('botone', { rosterPresence: () => presence });
    chair.c.onRoomMessage(line('bottwo', 'botthree: check the build [d:2-aaaa h:2 o:alice]'));
    chair.c.onRoomMessage(line('botthree', 'bottwo: done [d:2-aaaa]', { cookie: 78n }));
    chair.c.onRoomMessage(line('alice', 'what is the status?', { cookie: 79n }));
    const payload = chair.wakes[0]?.turn.untrusted?.[0]?.payload as { openJobs: unknown[] };
    expect(payload.openJobs).toEqual([]);
  });

  it('gives that fact to nobody but the chair, and leaves it out when there is nothing to say', () => {
    const presence = [{ name: 'botthree', online: true, away: false }];
    const worker = kit('bottwo', { rosterPresence: () => presence });
    worker.c.onRoomMessage(line('alice', 'bottwo: fix it'));
    expect(worker.wakes[0]?.turn.untrusted).toBeUndefined();
    const bare = kit('botone');
    bare.c.onRoomMessage(line('alice', 'what is the status?'));
    expect(bare.wakes[0]?.turn.untrusted).toBeUndefined();
  });

  it("the owner's answer belongs to the bot that asked, and the line after it to the chair", async () => {
    const k = kit('botone');
    k.c.onRoomMessage(line('bottwo', 'should the intro keep the quote?'));
    k.c.onRoomMessage(line('alice', 'yes, keep it', { cookie: 78n }));
    expect(k.sink.wake).not.toHaveBeenCalled();
    expect(k.c.standbys()).toBe(1);
    k.c.onRoomMessage(line('bottwo', 'done, it stays', { cookie: 79n }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(k.sink.wake).not.toHaveBeenCalled();
    k.c.onRoomMessage(line('alice', 'now write the release note', { cookie: 80n }));
    expect(k.wakes[0]?.turn).toMatchObject({ why: 'lead', sender: 'alice' });
    expect(k.wakes[0]?.turn.systemPrompt).toContain('decide who should answer');
  });

  it("the owner's answer still reaches the bot that asked a second earlier", async () => {
    const k = kit('botone');
    k.c.onRoomMessage(line('bottwo', 'should the intro keep the quote?'));
    await vi.advanceTimersByTimeAsync(1000);
    k.c.onRoomMessage(line('alice', 'yes, keep it', { cookie: 78n }));
    expect(k.sink.wake).not.toHaveBeenCalled();
    expect(k.c.standbys()).toBe(1);
  });

  it('a worker that reported done does not keep the next unnamed line', () => {
    const k = kit('botone');
    k.c.onRoomMessage(line('bottwo', 'which draft?'));
    k.c.onRoomMessage(line('bottwo', 'never mind, the intro is tighter now', { cookie: 78n }));
    k.c.onRoomMessage(line('alice', 'I need the release note done', { cookie: 79n }));
    expect(k.wakes).toHaveLength(1);
    expect(k.wakes[0]?.turn).toMatchObject({ why: 'lead', sender: 'alice' });
  });

  it('a hand-off line that ends in a question mark hands nobody the floor', () => {
    const k = kit('botone');
    k.c.onRoomMessage(line('botthree', 'bottwo: can you tighten the intro? [d:3-k7f3 h:1 o:alice]'));
    k.c.onRoomMessage(line('alice', 'and the release note', { cookie: 78n }));
    expect(k.wakes[0]?.turn).toMatchObject({ why: 'lead', sender: 'alice' });
  });

  it('a named wake sends no took', () => {
    const k = kit('bottwo');
    k.c.onRoomMessage(line('alice', 'bottwo: fix it'));
    expect(k.sink.wake).toHaveBeenCalledTimes(1);
    expect(k.say).not.toHaveBeenCalled();
  });

  it('a standby records, then takes the line after takeoverMs', async () => {
    const k = kit('bottwo');
    const ev = line('alice', 'what is the status?');
    k.c.onRoomMessage(ev);
    expect(k.sink.record).toHaveBeenCalledWith(ev);
    expect(k.sink.wake).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(k.say).toHaveBeenCalledWith(ROOM, '#oc took alice:4d', { whisperTo: 'botthree', priority: 'control' });
    expect(said(k.say)).toEqual(["botone is quiet, I'll take this."]);
    expect(k.wakes[0]?.turn).toMatchObject({ why: 'takeover', origin: 'owner', sender: 'alice' });
    expect(k.room.lastBotLine?.from).toBe('bottwo');
  });

  it('a took whisper stands the bot down, is relayed, and is never recorded', async () => {
    const k = kit('bottwo');
    k.c.onRoomMessage(line('alice', 'what is the status?'));
    k.sink.record.mockClear();
    k.c.onRoomMessage(line('botone', '#oc took alice:4d', { whisper: true }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(k.sink.wake).not.toHaveBeenCalled();
    expect(k.sink.record).not.toHaveBeenCalled();
    expect(k.say).toHaveBeenCalledWith(ROOM, '#oc took alice:4d', { whisperTo: 'botthree', priority: 'control' });
  });

  it('a took from someone outside the roster is ordinary text', async () => {
    const k = kit('bottwo');
    k.c.onRoomMessage(line('alice', 'what is the status?'));
    k.c.onRoomMessage(line('bob', '#oc took alice:4d', { whisper: true }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(k.sink.wake).toHaveBeenCalledTimes(1);
  });

  it("the chair's public line cancels the standby", async () => {
    const k = kit('bottwo');
    k.c.onRoomMessage(line('alice', 'what is the status?'));
    k.c.onRoomMessage(line('botone', 'all green'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(k.sink.wake).not.toHaveBeenCalled();
    expect(k.room.lastBotLine).toEqual({ from: 'botone', at: 1_000_000 });
  });

  it('unlisted lines are counted and chatter is recorded', () => {
    const k = kit('botone');
    k.c.onRoomMessage(line('mallory', 'botone: hi'));
    k.c.onRoomMessage(line('bob', 'nice weather'));
    expect(k.sink.count).toHaveBeenCalledTimes(1);
    expect(k.sink.record).toHaveBeenCalledTimes(1);
    expect(k.sink.wake).not.toHaveBeenCalled();
  });

  it('non-owner bodies have directives neutralised', () => {
    const k = kit('bottwo');
    k.c.onRoomMessage(line('bob', 'bottwo: /exec ls'));
    expect(k.wakes[0]?.turn.body).not.toBe('bottwo: /exec ls');
    expect(k.wakes[0]?.turn.commandAuthorized).toBe(false);
  });
});

describe('holds', () => {
  it('approved wake is held behind an owner run', async () => {
    const k = kit('botone');
    k.c.onRoomMessage(line('alice', 'botone: deploy it'));
    k.c.onRoomMessage(line('bob', 'botone: and tell me a joke', { cookie: 78n }));
    expect(k.sink.wake).toHaveBeenCalledTimes(1);
    expect(k.c.turnOrigin(RK)).toEqual({ originator: 'alice' });
    k.wakes[0]?.resolve();
    await flush();
    expect(k.sink.wake).toHaveBeenCalledTimes(2);
    expect(k.wakes[1]?.turn).toMatchObject({ sender: 'bob', origin: 'approved' });
    expect(k.c.turnOrigin(RK)).toEqual({ originator: 'bob' });
  });

  it('waits for the tracker when the wake promise settles early', async () => {
    const k = kit('botone');
    k.c.onRoomMessage(line('alice', 'botone: deploy it'));
    k.tracker.start(k.sk, 'botone', 'owner');
    k.wakes[0]?.resolve();
    await flush();
    k.c.onRoomMessage(line('bob', 'botone: joke please', { cookie: 78n }));
    expect(k.sink.wake).toHaveBeenCalledTimes(1);
    k.tracker.end(k.sk);
    await flush();
    expect(k.sink.wake).toHaveBeenCalledTimes(2);
  });

  it('a sign-on reset releases nothing while the wake promise is pending', async () => {
    const k = kit('botone');
    k.c.onRoomMessage(line('alice', 'botone: deploy it'));
    await flush();
    k.tracker.start(k.sk, 'botone', 'owner');
    k.c.onRoomMessage(line('bob', 'botone: joke please', { cookie: 78n }));
    k.tracker.reset();
    await flush();
    expect(k.sink.wake).toHaveBeenCalledTimes(1);
    k.wakes[0]?.resolve();
    await flush();
    expect(k.sink.wake).toHaveBeenCalledTimes(2);
  });

  it('a sign-on reset with no wake in flight releases the hold, and the class is checked again at dispatch', async () => {
    const k = kit('botone');
    k.c.onRoomMessage(line('alice', 'botone: deploy it'));
    k.tracker.start(k.sk, 'botone', 'owner');
    k.wakes[0]?.resolve();
    await flush();
    k.c.onRoomMessage(line('bob', 'botone: joke please', { cookie: 78n }));
    expect(k.sink.wake).toHaveBeenCalledTimes(1);
    k.tracker.reset();
    await flush();
    expect(k.sink.wake).toHaveBeenCalledTimes(2);
    expect(k.c.turnOrigin(RK)).toEqual({ originator: 'bob' });
    k.c.onRoomMessage(line('alice', 'botone: status?', { cookie: 79n }));
    expect(k.sink.wake).toHaveBeenCalledTimes(2);
  });

  it('same class goes straight to core', () => {
    const k = kit('botone');
    k.c.onRoomMessage(line('alice', 'botone: deploy it'));
    k.c.onRoomMessage(line('alice', 'botone: and the docs', { cookie: 78n }));
    expect(k.sink.wake).toHaveBeenCalledTimes(2);
    expect(k.c.turnOrigin(RK)).toEqual({ originator: 'alice' });
  });

  it('hand-offs with different originators do not steer into each other', async () => {
    const k = kit('bottwo');
    k.c.onRoomMessage(line('botone', HANDOFF));
    k.c.onRoomMessage(line('botone', 'bottwo: summarise it [d:1-aaaa h:1 o:bob]', { cookie: 78n }));
    expect(k.sink.wake).toHaveBeenCalledTimes(1);
    expect(k.c.turnOrigin(RK)).toEqual({ originator: 'alice', delegator: 'botone' });
    k.wakes[0]?.resolve();
    await flush();
    expect(k.sink.wake).toHaveBeenCalledTimes(2);
    expect(k.c.turnOrigin(RK)).toEqual({ originator: 'bob', delegator: 'botone' });
  });
});

describe('ack, busy, closing', () => {
  it('acks a working run, then closes a silent one', async () => {
    const k = kit('botone');
    k.c.onRoomMessage(line('alice', 'what is the status?'));
    k.c.toolStarted(k.sk);
    await vi.advanceTimersByTimeAsync(8000);
    expect(said(k.say)).toEqual(['on it']);
    k.wakes[0]?.resolve();
    await flush();
    expect(said(k.say)).toEqual(['on it', 'nothing to add']);
  });

  it('says nothing at the end of a run that was never acked', async () => {
    const k = kit('botone');
    k.c.onRoomMessage(line('alice', 'what is the status?'));
    k.wakes[0]?.resolve();
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(said(k.say)).toEqual([]);
  });

  it('a second unnamed owner line to a busy chair gets the busy text', async () => {
    const k = kit('botone');
    k.c.onRoomMessage(line('alice', 'rebuild everything'));
    k.c.toolStarted(k.sk);
    await vi.advanceTimersByTimeAsync(8000);
    k.c.onRoomMessage(line('alice', 'also check the logs', { cookie: 78n }));
    await vi.advanceTimersByTimeAsync(8000);
    expect(said(k.say)).toEqual(['on it', 'busy, will pick this up next']);
  });

  it('uses the configured texts', async () => {
    const k = kit('botone');
    k.state.policy = policyFixture({ chain: chainConfig({ ackText: 'one moment', ackAfterMs: 1000 }) });
    k.c.onRoomMessage(line('alice', 'what is the status?'));
    k.c.toolStarted(k.sk);
    await vi.advanceTimersByTimeAsync(1000);
    expect(said(k.say)).toEqual(['one moment']);
  });
});

describe('hand-off intake and results', () => {
  it('frames the task, carries the loop facts and starts one run for a repeated line', () => {
    const k = kit('bottwo');
    k.c.onRoomMessage(line('botone', HANDOFF));
    k.c.onRoomMessage(line('botone', HANDOFF));
    expect(k.sink.wake).toHaveBeenCalledTimes(1);
    expect(k.sink.record).toHaveBeenCalledTimes(1);
    const turn = k.wakes[0]?.turn;
    expect(turn).toMatchObject({
      why: 'handoff', origin: 'bot', sender: 'botone', originator: 'alice', commandAuthorized: false,
      body: 'botone handed you this job for alice: tighten the intro',
    });
    expect(turn?.systemPrompt).toContain('botone handed you this job for alice.');
    expect(turn?.botLoopProtection).toMatchObject({ scopeId: 'bottwo', conversationId: RK, senderId: 'botone', receiverId: 'bottwo' });
  });

  it('refuses intake when the host owner list has *', () => {
    const k = kit('bottwo');
    k.state.wildcard = true;
    k.c.onRoomMessage(line('botone', HANDOFF));
    expect(k.sink.wake).not.toHaveBeenCalled();
    expect(k.sink.record).toHaveBeenCalledTimes(1);
  });

  it('a delegated run that says nothing is closed with the outcome copy', async () => {
    const k = kit('bottwo');
    k.c.onRoomMessage(line('botone', HANDOFF));
    k.wakes[0]?.resolve();
    await flush();
    expect(said(k.say)).toEqual(['botone: nothing to report [d:1-k7f3]']);
  });

  it('a delegated run that errors is closed as failed, even when it started after the early idle answer', async () => {
    const k = kit('bottwo');
    k.c.onRoomMessage(line('botone', HANDOFF));
    await flush();
    k.tracker.start(k.sk, 'bottwo', 'bot');
    k.tracker.end(k.sk, 'error');
    k.wakes[0]?.resolve();
    await flush();
    expect(said(k.say)).toEqual(['botone: that failed on my side [d:1-k7f3]']);
  });

  it('an early idle answer that arrives after the run started is not believed', async () => {
    const k = kit('bottwo');
    k.c.onRoomMessage(line('botone', HANDOFF));
    k.tracker.start(k.sk, 'bottwo', 'bot');
    await flush();
    k.tracker.end(k.sk, 'error');
    k.wakes[0]?.resolve();
    await flush();
    expect(said(k.say)).toEqual(['botone: that failed on my side [d:1-k7f3]']);
  });

  it('a run that errors after the wake promise settled still counts', async () => {
    const k = kit('bottwo');
    k.c.onRoomMessage(line('botone', HANDOFF));
    k.tracker.start(k.sk, 'bottwo', 'bot');
    k.wakes[0]?.resolve();
    await flush();
    expect(said(k.say)).toEqual([]);
    k.tracker.end(k.sk, 'error');
    await flush();
    expect(said(k.say)).toEqual(['botone: that failed on my side [d:1-k7f3]']);
  });

  it('a failure on another session changes nothing', async () => {
    const k = kit('bottwo');
    k.c.onRoomMessage(line('botone', HANDOFF));
    k.tracker.start('sk|someone-else', 'bottwo', 'bot');
    k.tracker.end('sk|someone-else', 'error');
    k.wakes[0]?.resolve();
    await flush();
    expect(said(k.say)).toEqual(['botone: nothing to report [d:1-k7f3]']);
  });

  it('a rejected dispatch is closed as failed', async () => {
    const k = kit('bottwo');
    k.c.onRoomMessage(line('botone', HANDOFF));
    k.wakes[0]?.reject(new Error('dispatch failed'));
    await flush();
    expect(said(k.say)).toEqual(['botone: that failed on my side [d:1-k7f3]']);
  });

  it('a result from the target closes the ledger without waking', () => {
    const k = kit('botone');
    k.c.ledger.open({ id: '1-k7f3', to: 'bottwo', room: ROOM, originator: 'alice', hop: 1 });
    k.c.onRoomMessage(line('botthree', 'botone: done [d:1-k7f3]'));
    expect(k.c.ledger.list()).toHaveLength(1);
    k.c.onRoomMessage(line('bottwo', 'botone: done [d:1-k7f3]'));
    expect(k.c.ledger.list()).toHaveLength(0);
    expect(k.sink.wake).not.toHaveBeenCalled();
    expect(k.sink.record).toHaveBeenCalledTimes(2);
  });

  it('reviewResults wakes the delegator with a note and the originator limits', () => {
    const k = kit('botone');
    k.state.policy = policyFixture({ chain: chainConfig({ reviewResults: true }) });
    k.c.ledger.open({ id: '1-k7f3', to: 'bottwo', room: ROOM, originator: 'bob', hop: 1 });
    k.c.onRoomMessage(line('bottwo', 'botone: here it is [d:1-k7f3]'));
    expect(k.wakes[0]?.turn).toMatchObject({
      why: 'review', origin: 'bot', originator: 'bob',
      body: 'System note: bottwo finished hand-off 1-k7f3. Review the result below.\nbotone: here it is',
    });
    expect(k.c.turnOrigin(RK)).toEqual({ originator: 'bob' });
    expect(k.c.ledger.list()).toHaveLength(0);
  });

  it('an unknown id under reviewResults wakes with the lost-ledger note and nobody as originator', () => {
    const k = kit('botone');
    k.state.policy = policyFixture({ chain: chainConfig({ reviewResults: true }) });
    k.c.onRoomMessage(line('bottwo', 'botone: here it is [d:1-zzzz]'));
    expect(k.wakes[0]?.turn.body).toContain('which I no longer have a record of');
    expect(k.c.turnOrigin(RK)).toEqual({ originator: '' });
  });

  it('a timeout wakes the delegator with a system note', async () => {
    const k = kit('botone');
    k.c.ledger.open({ id: '1-k7f3', to: 'bottwo', room: ROOM, originator: 'alice', hop: 1 });
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(k.wakes[0]?.turn).toMatchObject({
      why: 'review', sender: 'bottwo', originator: 'alice',
      body: 'System note: bottwo has not answered hand-off 1-k7f3 after 20 minutes. Tell the person who asked.',
    });
  });

  it('a target that leaves wakes the delegator at once', () => {
    const k = kit('botone');
    k.c.ledger.open({ id: '1-k7f3', to: 'bottwo', room: ROOM, originator: 'alice', hop: 1 });
    k.c.onRoomLeave({ room: ROOM, name: 'bottwo', display: 'bottwo' });
    expect(k.wakes[0]?.turn.body).toBe('System note: bottwo left the room before answering hand-off 1-k7f3. Tell the person who asked.');
    expect(k.c.ledger.list()).toHaveLength(0);
  });

  it('the room-wide guard bounds bot-authored wakes', () => {
    const k = kit('bottwo');
    for (let i = 0; i < 30; i++) {
      const id = `1-${'abcdefghijklmnopqrstuvwxyz234567'[i] ?? 'a'}aaa`;
      k.c.onRoomMessage(line('botone', `bottwo: job ${i} [d:${id} h:1 o:alice]`, { cookie: BigInt(100 + i) }));
    }
    expect(k.sink.wake).toHaveBeenCalledTimes(20);
    expect(k.sink.record).toHaveBeenCalledTimes(10);
  });
});

describe('roster mismatch and IMs', () => {
  it('falls back to name order and tells the room once', async () => {
    const k = kit('botone');
    k.state.policy = policyFixture({ chain: chainConfig({ roster: [
      { screenName: 'bottwo', role: '', aliases: [] },
      { screenName: 'botone', role: '', aliases: [] },
      { screenName: 'botthree', role: '', aliases: [] },
    ] }) });
    expect(k.c.onIm({ from: 'bottwo', fromDisplay: 'bottwo', text: helloLine(1, 'deadbeef'), cookie: 1n, autoResponse: false, offline: false, system: false })).toBe('handled');
    k.c.onRoomMessage(line('alice', 'what is the status?'));
    k.c.onRoomMessage(line('alice', 'and the docs?', { cookie: 78n }));
    await flush();
    expect(k.sink.wake).toHaveBeenCalledTimes(2);
    expect(said(k.say)).toEqual(['botone and bottwo disagree about the chain of command. Using name order until their configs match.']);
    expect(k.c.facts().mismatches).toHaveLength(1);
  });

  it('only the acting lead announces', async () => {
    const k = kit('bottwo');
    k.c.onIm({ from: 'botone', fromDisplay: 'botone', text: helloLine(1, 'deadbeef'), cookie: 1n, autoResponse: false, offline: false, system: false });
    k.sendIm.mockClear();
    k.c.onRoomMessage(line('alice', 'what is the status?'));
    await flush();
    expect(said(k.say)).toEqual([]);
  });

  it('greets peers on presence, room join and room ready', () => {
    const k = kit('botone');
    k.c.onPresence('bottwo', true);
    k.c.onRoomReady(ROOM, ['alice', 'botone', 'bottwo', 'botthree']);
    k.c.onRoomJoin({ room: ROOM, name: 'botthree', display: 'botthree' });
    expect(k.sendIm.mock.calls.map((call) => call[0]).sort()).toEqual(['botthree', 'bottwo']);
    k.c.onPresence('bottwo', false);
    expect(k.sendIm).toHaveBeenCalledTimes(2);
  });

  it('passes people through and reports facts', () => {
    const k = kit('botnine');
    expect(k.c.onIm({ from: 'alice', fromDisplay: 'alice', text: 'hello', cookie: 1n, autoResponse: false, offline: false, system: false })).toBe('pass');
    expect(k.c.facts()).toEqual({ mismatches: [], claims: [], open: [], lastRefusal: null });
  });

  it('stop cancels every timer', async () => {
    const k = kit('bottwo');
    k.c.onRoomMessage(line('alice', 'what is the status?'));
    k.c.ledger.open({ id: '2-k7f3', to: 'botthree', room: ROOM, originator: 'alice', hop: 1 });
    k.c.stop();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(k.sink.wake).not.toHaveBeenCalled();
  });
});
