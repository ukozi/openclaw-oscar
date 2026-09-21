import { describe, expect, it } from 'vitest';
import { TEAM_FACT_NOTE, promptVariant, roomSystemPrompt } from '../../../src/chain/prompts.js';
import { chainConfig, policyFixture } from './fixtures.js';

const policy = policyFixture();
const PUBLIC = 'Anyone may be reading this room: never post secrets, credentials or file contents.';

const ROUTED = 'This line was routed to you on purpose: answer it, or reply NO_REPLY only if it needs no answer at all. Do not wait to be named.';
const HAND = 'Hand a job over by calling oscar_delegate, or by writing a line that starts with their name and a colon; '
  + 'that is a teammate, which is a different thing from a subagent.';

describe('roomSystemPrompt', () => {
  it('chair, word for word', () => {
    expect(roomSystemPrompt({ self: 'botone', policy, why: 'lead' })).toBe(
      'You are botone, the chair of a team of assistants in this chat room. '
      + 'This line was routed to you because it named nobody, and your first job is to decide who should answer it, '
      + 'not to answer it yourself. '
      + 'Your teammates and what each is for: bottwo: writing and editing, botthree: code and shell work. '
      + 'A teammate marked busy is already working on something. '
      + 'If the line follows on from work a teammate is already doing, give it to that teammate. '
      + 'Otherwise pick whoever fits it best and is free, and hand it to them. '
      + 'Take it yourself only when you are the right one for it. '
      + HAND + ' '
      + 'Reply NO_REPLY only when the line needs no answer from anyone. '
      + PUBLIC,
    );
  });

  it('worker: no routing sentences, the worker rule instead', () => {
    expect(roomSystemPrompt({ self: 'bottwo', policy, why: 'named' })).toBe(
      'You are bottwo, an assistant on a team in this chat room. '
      + 'You answer when someone names you, hands you a job, or answers a question you asked. '
      + 'Teammates below you: botthree: code and shell work. '
      + HAND + ' '
      + PUBLIC,
    );
  });

  it('a bot reading the answer to its own question gets the worker text, chair or not', () => {
    for (const self of ['botone', 'bottwo'] as const) {
      const text = roomSystemPrompt({ self, policy, why: 'floor' });
      expect(text).toContain('You answer when someone names you, hands you a job, or answers a question you asked.');
      expect(text).not.toContain('decide who should answer');
    }
  });

  it('the last rank has no team sentences', () => {
    const text = roomSystemPrompt({ self: 'botthree', policy, why: 'named' });
    expect(text).toBe(
      'You are botthree, an assistant on a team in this chat room. '
      + 'You answer when someone names you, hands you a job, or answers a question you asked. ' + PUBLIC,
    );
  });

  it('handed-off turn', () => {
    const text = roomSystemPrompt({
      self: 'bottwo', policy, why: 'handoff', handoff: { delegator: 'botone', originator: 'alice' },
    });
    expect(text.endsWith(`${PUBLIC} botone handed you this job for alice. Reply in the room with the result.`)).toBe(true);
    expect(text).not.toContain('decide who should answer');
  });

  it('solo: the routed text without the team sentences', () => {
    const solo = policyFixture({ chain: chainConfig({ roster: [] }) });
    expect(roomSystemPrompt({ self: 'botone', policy: solo, why: 'named' })).toBe(
      'You are botone, an assistant in this chat room. ' + ROUTED + ' ' + PUBLIC,
    );
  });

  it('a chair with nobody below it is told to answer, not to route', () => {
    const alone = policyFixture({ chain: chainConfig({ roster: [{ screenName: 'botone', role: 'everything', aliases: [] }] }) });
    expect(roomSystemPrompt({ self: 'botone', policy: alone, why: 'lead' })).toBe(
      'You are botone, an assistant in this chat room. ' + ROUTED + ' ' + PUBLIC,
    );
  });

  it('a worker that took a routed line gets the chair text', () => {
    for (const why of ['takeover', 'invited'] as const) {
      expect(roomSystemPrompt({ self: 'bottwo', policy, why })).toContain('decide who should answer');
    }
  });

  it('never carries room text or the operator prompt, which the room sink appends', () => {
    const withRoom = policyFixture({ rooms: { testroom: { systemPrompt: 'Keep answers short.' } } });
    expect(roomSystemPrompt({ self: 'botone', policy: withRoom, why: 'lead' })).toBe(roomSystemPrompt({ self: 'botone', policy, why: 'lead' }));
  });

  it('a teammate with no role is listed by name', () => {
    const bare = policyFixture({ chain: chainConfig({ roster: [
      { screenName: 'botone', role: '', aliases: [] }, { screenName: 'Bot Two', role: '', aliases: [] },
      { screenName: 'botthree', role: '', aliases: [] },
    ] }) });
    expect(roomSystemPrompt({ self: 'botone', policy: bare, why: 'lead' })).toContain('Your teammates and what each is for: bottwo, botthree. ');
  });
});

describe('the team fact note', () => {
  it('says what the team fact is worth', () => {
    expect(TEAM_FACT_NOTE).toContain('only the hand-offs I have seen');
    expect(TEAM_FACT_NOTE).toContain('ask rather than assume');
  });

  it('is not part of any prompt', () => {
    for (const why of ['lead', 'named', 'floor', 'handoff'] as const) {
      expect(roomSystemPrompt({ self: 'botone', policy, why })).not.toContain(TEAM_FACT_NOTE);
    }
  });
});

describe('promptVariant', () => {
  it.each([
    ['lead', 'chair'], ['invited', 'chair'], ['takeover', 'chair'],
    ['floor', 'worker'], ['named', 'worker'], ['review', 'worker'], ['handoff', 'handoff'],
  ] as const)('%s is %s', (why, variant) => {
    expect(promptVariant(why, policy)).toBe(variant);
  });
});
