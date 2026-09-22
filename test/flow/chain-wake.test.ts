import { afterEach, describe, expect, it } from 'vitest';
import { chainConfig, ROOM } from '../unit/chain/fixtures.js';
import { RK, TAKEOVER_MS, Team } from './chain-harness.js';

let team: Team | undefined;
afterEach(async () => {
  await team?.stop();
  team = undefined;
});

const MISMATCH = 'botone and bottwo disagree about the chain of command. Using name order until their configs match.';

describe('chain wake flows', () => {
  it('seven bots in two instances: one unnamed owner line starts one run, on the lead', async () => {
    const t = await Team.start({ instances: [['botone', 'bottwo', 'botthree', 'botfour'], ['botfive', 'botsix', 'botseven']] });
    team = t;
    t.alice.say(ROOM, 'what is the status?', { cookie: 1001n });
    await t.everyoneHeard('what is the status?');
    await t.everyoneHeard('ok', ['botone']);
    await t.standDown();
    t.clock.advance(10 * TAKEOVER_MS);
    expect(t.totalRuns()).toBe(1);
    expect(t.bot('botone').runs[0]?.turn).toMatchObject({ why: 'lead', sender: 'alice', origin: 'owner' });
    expect(t.bots().flatMap((bot) => bot.said)).toEqual([]);
    await t.until(() => t.seenByAlice().length === 1, 'alice to see the answer');
    expect(t.seenByAlice()).toEqual(['ok']);
  }, 30_000);

  it('lead suspended: rank 2 takes the line at takeoverMs, rank 3 stays quiet', async () => {
    const t = await Team.start({ instances: [['botone'], ['bottwo', 'botthree']] });
    team = t;
    const [leadInstance] = t.instances;
    if (leadInstance) leadInstance.suspended = true;
    t.alice.say(ROOM, 'what is the status?', { cookie: 1002n });
    await t.until(() => t.bot('bottwo').controller.standbys() === 1 && t.bot('botthree').controller.standbys() === 1, 'both standbys');
    t.clock.advance(TAKEOVER_MS - 1);
    expect(t.totalRuns()).toBe(0);
    t.clock.advance(1);
    expect(t.bot('bottwo').runs).toHaveLength(1);
    expect(t.bot('bottwo').runs[0]?.turn.why).toBe('takeover');
    await t.standDown();
    t.clock.advance(10 * TAKEOVER_MS);
    expect(t.bot('botthree').runs).toHaveLength(0);
    expect(t.bot('botone').runs).toHaveLength(0);
    await t.until(() => t.seenByAlice().length === 2, 'alice to see both lines');
    expect(t.seenByAlice()).toEqual(["botone is quiet, I'll take this.", 'ok']);
  }, 30_000);

  it("a worker's question holds the floor for the owner's answer", async () => {
    const t = await Team.start({ instances: [['botone', 'bottwo'], ['botthree']] });
    team = t;
    t.bot('bottwo').agent = async (api) => { await api.reply('should the intro keep the pull quote?'); };
    t.alice.say(ROOM, 'bottwo: draft the intro', { cookie: 1003n });
    await t.everyoneHeard('should the intro keep the pull quote?', ['bottwo']);
    await t.until(() => t.bot('bottwo').idle(), 'the first run to finish');
    t.bot('bottwo').agent = async (api) => { await api.reply('ok'); };
    t.alice.say(ROOM, 'yes, keep it', { cookie: 1004n });
    await t.until(() => t.bot('bottwo').runs.length === 2, 'the answer to reach the worker that asked');
    expect(t.bot('bottwo').runs[1]?.turn.why).toBe('floor');
    expect(t.bot('bottwo').runs[1]?.turn.systemPrompt).toContain('answers a question you asked');
    await t.everyoneHeard('yes, keep it');
    await t.standDown();
    t.clock.advance(10 * TAKEOVER_MS);
    expect(t.bot('botone').runs).toHaveLength(0);
    expect(t.bot('botthree').runs).toHaveLength(0);
  }, 30_000);

  it('a worker that reported done does not keep the next line: the chair takes it', async () => {
    const t = await Team.start({ instances: [['botone', 'bottwo'], ['botthree']] });
    team = t;
    t.alice.say(ROOM, 'bottwo: draft the intro', { cookie: 1013n });
    await t.everyoneHeard('ok', ['bottwo']);
    await t.until(() => t.bot('bottwo').idle(), 'the first run to finish');
    t.alice.say(ROOM, 'I need the release note done', { cookie: 1014n });
    await t.until(() => t.bot('botone').runs.length === 1, 'the chair to take the fresh request');
    const turn = t.bot('botone').runs[0]?.turn;
    expect(turn?.why).toBe('lead');
    expect(turn?.systemPrompt).toContain('decide who should answer');
    expect(turn?.systemPrompt).toContain('Your teammates and what each is for: bottwo:');
    await t.everyoneHeard('I need the release note done');
    await t.standDown();
    t.clock.advance(10 * TAKEOVER_MS);
    expect(t.bot('bottwo').runs).toHaveLength(1);
    expect(t.bot('botthree').runs).toHaveLength(0);
  }, 30_000);

  it('roster mismatch: both sides fall back to name order and the room is told once', async () => {
    const reversed = ['bottwo', 'botone'].map((screenName) => ({ screenName, role: '', aliases: [] }));
    const t = await Team.start({
      instances: [['botone'], ['bottwo']],
      policyFor: (name, base) => (name === 'bottwo' ? { ...base, chain: chainConfig({ ...base.chain, roster: reversed }) } : base),
    });
    team = t;
    await t.until(() => t.bots().every((bot) => bot.controller.facts().mismatches.length === 1), 'both bots to see the mismatch');
    t.alice.say(ROOM, 'what is the status?', { cookie: 1005n });
    await t.until(() => t.bot('botone').runs.length === 1, 'the first run');
    await t.until(() => t.bot('botone').idle(), 'the first run to finish');
    t.alice.say(ROOM, 'and the docs?', { cookie: 1006n });
    await t.until(() => t.bot('botone').runs.length === 2, 'the second run');
    await t.everyoneHeard('and the docs?');
    await t.standDown();
    t.clock.advance(10 * TAKEOVER_MS);
    expect(t.bot('bottwo').runs).toHaveLength(0);
    expect(t.bot('botone').said).toEqual([MISMATCH]);
    expect(t.bot('bottwo').said).toEqual([]);
    await t.until(() => t.seenByAlice().includes(MISMATCH), 'alice to see the notice');
  }, 30_000);

  it('the owner never sees a control whisper', async () => {
    const t = await Team.start({ instances: [['botone', 'bottwo', 'botthree']] });
    team = t;
    t.alice.say(ROOM, 'what is the status?', { cookie: 1007n });
    await t.until(() => t.bot('botthree').heard.some((text) => text.startsWith('#oc took ')), 'the took relay to reach the last rank');
    expect(t.bot('bottwo').heard.some((text) => text.startsWith('#oc took '))).toBe(true);
    expect(t.alice.roomLines(ROOM).some((l) => l.text.includes('#oc'))).toBe(false);
    expect(t.bob.roomLines(ROOM).some((l) => l.text.includes('#oc'))).toBe(false);
    expect(t.bot('botone').rooms.get(RK)?.lastBotLine?.from).toBe('botone');
  }, 30_000);
});
