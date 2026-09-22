import { afterEach, describe, expect, it } from 'vitest';
import { ROOM } from '../unit/chain/fixtures.js';
import { ACK_MS, RK, TAKEOVER_MS, Team, gate } from './chain-harness.js';
import type { Agent } from './chain-harness.js';

let team: Team | undefined;
afterEach(async () => {
  await team?.stop();
  team = undefined;
});

const HANDOFF_LINE = /^bottwo: tighten the intro \[d:1-[a-z2-7]{4} h:1 o:alice\]$/;
const RESULT_LINE = /^botone: Here is the intro\. \[d:1-[a-z2-7]{4}\]$/;
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const writer: Agent = async (api) => { await api.reply('Here is the intro.'); };

async function expectOneHandoff(t: Team): Promise<void> {
  await t.until(() => t.bot('bottwo').runs.length === 1, 'the hand-off run');
  await t.until(() => t.bot('botone').controller.ledger.list().length === 0 && t.bot('botone').said.length === 1, 'the result to close the ledger');
  await t.until(() => t.bots().every((bot) => bot.idle()), 'every run to finish');
  await t.everyoneHeard('the intro is too long');
  await t.standDown();
  t.clock.advance(10 * TAKEOVER_MS);
  expect(t.bot('bottwo').runs).toHaveLength(1);
  expect(t.bot('bottwo').runs[0]?.turn).toMatchObject({ why: 'handoff', sender: 'botone', originator: 'alice', origin: 'bot' });
  expect(t.bot('botthree').wakes).toHaveLength(0);
  expect(t.bot('botone').said.filter((l) => HANDOFF_LINE.test(l))).toHaveLength(1);
  expect(t.bot('bottwo').sent.filter((l) => RESULT_LINE.test(l))).toHaveLength(1);
  expect(t.bot('bottwo').said).toEqual([]);
  await t.until(() => t.seenByAlice().some((l) => RESULT_LINE.test(l)), 'alice to see the result');
  expect(t.seenByAlice().filter((l) => HANDOFF_LINE.test(l))).toHaveLength(1);
}

describe('chain hand-off flows', () => {
  it('by tool: exactly one run on the target, and the result closes the ledger', async () => {
    const t = await Team.start({ instances: [['botone'], ['bottwo', 'botthree']] });
    team = t;
    let toolReply = '';
    t.bot('botone').agent = async (api) => {
      api.tool();
      toolReply = await api.delegate('bottwo', 'tighten the intro');
    };
    t.bot('bottwo').agent = writer;
    t.alice.say(ROOM, 'the intro is too long', { cookie: 2001n });
    await expectOneHandoff(t);
    expect(toolReply).toMatch(/^handed to bottwo as 1-[a-z2-7]{4}$/);
  }, 30_000);

  it('by text: a reply line that starts with the subordinate name does the same', async () => {
    const t = await Team.start({ instances: [['botone'], ['bottwo', 'botthree']] });
    team = t;
    t.bot('botone').agent = async (api) => { await api.reply('Splitting this up.\nbottwo: tighten the intro'); };
    t.bot('bottwo').agent = writer;
    t.alice.say(ROOM, 'the intro is too long', { cookie: 2002n });
    await expectOneHandoff(t);
    expect(t.bot('botone').sent).toEqual(['Splitting this up.']);
  }, 30_000);

  it('a third hop is refused', async () => {
    const t = await Team.start({ instances: [['botone', 'bottwo'], ['botthree', 'botfour']] });
    team = t;
    const errors: string[] = [];
    t.bot('botone').agent = async (api) => { await api.delegate('bottwo', 'first hop'); };
    t.bot('bottwo').agent = async (api) => { await api.delegate('botthree', 'second hop'); };
    t.bot('botthree').agent = async (api) => {
      await api.delegate('botfour', 'third hop').catch((err: Error) => errors.push(err.message));
      await api.reply('stopped here');
    };
    t.alice.say(ROOM, 'pass it down', { cookie: 2003n });
    await t.until(() => errors.length === 1, 'the refusal');
    expect(errors).toEqual(['too many hops']);
    await t.everyoneHeard('botone: second hop', ['botone', 'bottwo', 'botthree', 'botfour']);
    await t.until(() => t.bots().every((bot) => bot.idle()), 'every run to finish');
    expect(t.bot('botthree').runs[0]?.turn).toMatchObject({ why: 'handoff', originator: 'alice' });
    expect(t.bot('bottwo').said.some((l) => / h:2 o:alice\]$/.test(l))).toBe(true);
    expect(t.bot('botthree').said.some((l) => / h:3 /.test(l))).toBe(false);
    expect(t.bot('botfour').wakes).toHaveLength(0);
  }, 30_000);

  it("an approved person's hand-off runs without shell on the worker; an owner's keeps it", async () => {
    const t = await Team.start({ instances: [['botone'], ['bottwo']] });
    team = t;
    t.bot('botone').agent = async (api) => { await api.delegate('bottwo', 'summarise the log'); };
    t.bot('bottwo').agent = writer;
    t.bob.say(ROOM, 'botone: summarise the log', { cookie: 2004n });
    await t.until(() => t.bot('bottwo').runs.length === 1, "bob's hand-off");
    await t.until(() => t.bot('botone').controller.ledger.list().length === 0 && t.bots().every((bot) => bot.idle()), 'the first hand-off to close');
    t.alice.say(ROOM, 'botone: summarise the log', { cookie: 2005n });
    await t.until(() => t.bot('bottwo').runs.length === 2, "alice's hand-off");
    const [forBob, forAlice] = t.bot('bottwo').runs;
    expect(forBob?.turn.originator).toBe('bob');
    expect(forBob?.toolPolicy?.deny).toEqual(expect.arrayContaining(['group:runtime', 'group:fs']));
    expect(forAlice?.turn.originator).toBe('alice');
    expect(forAlice?.toolPolicy).toBeUndefined();
  }, 30_000);

  it('an echo bot above the worker cannot start more wakes than the guard budget', async () => {
    const t = await Team.start({ instances: [['bottwo']], ghosts: ['botone'] });
    team = t;
    const echo = t.server.peer('botone');
    echo.joinRoom(ROOM);
    await t.until(() => t.bot('bottwo').rooms.get('room:4:testroom')?.occupants.has('botone'), 'the echo bot to join');
    t.settle();
    const hold = gate();
    t.bot('bottwo').agent = async () => { await hold.wait; };
    for (let i = 0; i < 40; i++) {
      const id = `1-${BASE32[i % 32]}${BASE32[i >> 5]}aa`;
      echo.say(ROOM, `bottwo: echo ${i} [d:${id} h:1 o:alice]`, { cookie: BigInt(3000 + i) });
    }
    await t.until(() => t.bot('bottwo').heard.length === 40, 'all forty lines');
    expect(t.bot('bottwo').wakes).toHaveLength(20);
    expect(t.bot('bottwo').runs).toHaveLength(1);
    hold.open();
  }, 30_000);

  it('an ack appears only for a run that is still working at ackAfterMs', async () => {
    const t = await Team.start({ instances: [['botone', 'bottwo']] });
    team = t;
    const working = gate();
    t.bot('botone').agent = async (api) => {
      api.tool();
      await working.wait;
      await api.reply('done at last');
    };
    t.alice.say(ROOM, 'rebuild everything', { cookie: 2006n });
    await t.until(() => t.bot('botone').runs.length === 1, 'the slow run');
    await t.standDown();
    t.clock.advance(ACK_MS - 1);
    expect(t.bot('botone').said).toEqual([]);
    t.clock.advance(1);
    expect(t.bot('botone').said).toEqual(['on it']);
    working.open();
    await t.until(() => t.seenByAlice().length === 2, 'the answer');
    expect(t.seenByAlice()).toEqual(['on it', 'done at last']);
    await t.until(() => t.bot('botone').idle(), 'the slow run to finish');

    t.bot('botone').agent = async (api) => { await api.reply('quick answer'); };
    t.alice.say(ROOM, 'what time is it?', { cookie: 2007n });
    await t.until(() => t.bot('botone').sent.includes('quick answer') && t.bot('botone').idle(), 'the quick run');
    await t.standDown();
    t.clock.advance(10 * ACK_MS);
    expect(t.bot('botone').said).toEqual(['on it']);
  }, 30_000);

  it('a silent run that was acked is closed with the closing line', async () => {
    const t = await Team.start({ instances: [['botone']] });
    team = t;
    const thinking = gate();
    t.bot('botone').agent = async (api) => {
      api.tool();
      await thinking.wait;
    };
    t.alice.say(ROOM, 'think about it', { cookie: 2008n });
    await t.until(() => t.bot('botone').runs.length === 1, 'the run');
    t.clock.advance(ACK_MS);
    thinking.open();
    await t.until(() => t.bot('botone').said.length === 2, 'the closing line');
    expect(t.bot('botone').said).toEqual(['on it', 'nothing to add']);
    await t.until(() => t.seenByAlice().length === 2, 'alice to see both');
    expect(t.seenByAlice()).toEqual(['on it', 'nothing to add']);
  }, 30_000);

  it('a busy lead keeps the second unnamed command and says so', async () => {
    const t = await Team.start({ instances: [['botone'], ['bottwo']] });
    team = t;
    const working = gate();
    t.bot('botone').agent = async (api) => {
      api.tool();
      await working.wait;
      await api.reply('finished');
    };
    t.alice.say(ROOM, 'rebuild everything', { cookie: 2009n });
    await t.until(() => t.bot('botone').runs.length === 1, 'the long run');
    await t.everyoneHeard('rebuild everything');
    await t.standDown();
    t.clock.advance(ACK_MS);
    expect(t.bot('botone').said).toEqual(['on it']);
    t.alice.say(ROOM, 'also check the logs', { cookie: 2010n });
    await t.until(() => t.bot('botone').steered.length === 1, 'the second line to reach the busy lead');
    await t.everyoneHeard('also check the logs');
    await t.standDown();
    t.clock.advance(ACK_MS);
    expect(t.bot('botone').said).toEqual(['on it', 'busy, will pick this up next']);
    working.open();
    await t.until(() => t.seenByAlice().length === 3, 'the answer');
    expect(t.seenByAlice()).toEqual(['on it', 'busy, will pick this up next', 'finished']);
    expect(t.bot('botone').runs).toHaveLength(1);
    expect(t.bot('bottwo').wakes).toHaveLength(0);
  }, 30_000);

  it('a rate-limited room drops the hand-off and the tool reports it', async () => {
    const t = await Team.start({ instances: [['botone'], ['bottwo']] });
    team = t;
    const errors: string[] = [];
    t.bot('botone').agent = async (api) => {
      await api.delegate('bottwo', 'tighten the intro').catch((err: Error) => errors.push(err.message));
    };
    t.server.setRate('botone', ROOM, 'limited');
    await t.until(() => t.bot('botone').controller.roomLimited(RK), 'the limited notice');
    t.alice.say(ROOM, 'botone: the intro is too long', { cookie: 2011n });
    await t.until(() => errors.length === 1, 'the tool error');
    expect(errors[0]).toBe('the room is rate limited and the hand-off has not gone out; tell the owner');
    expect(t.bot('botone').controller.ledger.list()).toEqual([]);
    expect(t.bot('botone').said).toEqual([]);
    expect(t.bot('bottwo').wakes).toHaveLength(0);
  }, 30_000);
});
