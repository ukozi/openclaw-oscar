import { describe, expect, it } from 'vitest';
import { copy } from '../../../src/copy.js';

describe('chain copy', () => {
  it('passes configured ack and busy text through, with defaults', () => {
    expect(copy.ack('')).toBe('on it');
    expect(copy.ack('working')).toBe('working');
    expect(copy.busy('')).toBe('busy, will pick this up next');
    expect(copy.busy('one moment')).toBe('one moment');
  });

  it('has the fixed chain lines', () => {
    expect(copy.closing()).toBe('nothing to add');
    expect(copy.takeover('botone')).toBe("botone is quiet, I'll take this.");
    expect(copy.mismatch('botone', 'bottwo')).toBe(
      'botone and bottwo disagree about the chain of command. Using name order until their configs match.',
    );
  });

  it('words the three outcomes', () => {
    expect(copy.outcome('botone', '1-k7f3', 'done')).toBe('botone: done [d:1-k7f3]');
    expect(copy.outcome('botone', '1-k7f3', 'none')).toBe('botone: nothing to report [d:1-k7f3]');
    expect(copy.outcome('botone', '1-k7f3', 'failed')).toBe('botone: that failed on my side [d:1-k7f3]');
  });

  it('words the delegate errors', () => {
    expect(copy.delegateError('not-in-room')).toBe('hand-offs only work in a room; tell the owner');
    expect(copy.delegateError('absent', 'bottwo')).toBe('bottwo is not in this room');
    expect(copy.delegateError('not-below', 'botone')).toBe('botone is not below you in the chain');
    expect(copy.delegateError('hops')).toBe('too many hops');
    expect(copy.delegateError('wildcard')).toBe(
      'the chain is unsafe on this host: commands.ownerAllowFrom contains *',
    );
    expect(copy.delegateError('mismatch', 'bottwo')).toBe(
      'bottwo has a different chain config; hand-offs to it are off until the configs match',
    );
    expect(copy.delegateError('rate')).toBe('the room is rate limited and the hand-off has not gone out; tell the owner');
    expect(copy.delegateError('lost-turn')).toBe('I lost track of who asked for this; ask them to repeat it');
    expect(copy.delegateError('too-long')).toBe('the task is too long for one room message; shorten it');
    expect(copy.delegateError('send-failed')).toBe('the hand-off could not be sent; tell the owner');
    expect(copy.delegateError('empty')).toBe('say what the job is');
    expect(copy.delegateSent('bottwo', '1-k7f3')).toBe('handed to bottwo as 1-k7f3');
  });

  it('words the agent notes', () => {
    expect(copy.noteTimeout('bottwo', '1-k7f3', 20)).toBe(
      'System note: bottwo has not answered hand-off 1-k7f3 after 20 minutes. Tell the person who asked.',
    );
    expect(copy.noteLeft('bottwo', '1-k7f3')).toBe(
      'System note: bottwo left the room before answering hand-off 1-k7f3. Tell the person who asked.',
    );
    expect(copy.noteLostLedger('1-k7f3')).toBe(
      'System note: this is a result for hand-off 1-k7f3, which I no longer have a record of.',
    );
    expect(copy.noteResult('bottwo', '1-k7f3')).toBe('System note: bottwo finished hand-off 1-k7f3. Review the result below.');
  });
});
