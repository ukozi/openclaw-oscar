import { describe, expect, it } from 'vitest';
import { FILES_LIMITS, Slots, senderGate } from '../../../src/inbound/media-gate.js';
import { policyFixture } from '../rooms-fixtures.js';

const yes = async (): Promise<boolean> => true;
const no = async (): Promise<boolean> => false;

describe('senderGate', () => {
  it('allows an owner and an approved person', async () => {
    const policy = policyFixture();
    expect(await senderGate({ from: 'Alice', self: 'BotOne', policy, admit: yes })).toBe('allow');
    expect(await senderGate({ from: 'bob', self: 'BotOne', policy, admit: yes })).toBe('allow');
  });

  it('calls an unlisted sender a stranger, also under dmPolicy open', async () => {
    expect(await senderGate({ from: 'mallory', self: 'BotOne', policy: policyFixture(), admit: yes })).toBe('stranger');
    expect(await senderGate({ from: 'mallory', self: 'BotOne', policy: policyFixture({ dmPolicy: 'open' }), admit: yes })).toBe('stranger');
  });

  it("is silent for a teammate bot and for the bot's own name", async () => {
    const policy = policyFixture({ teammates: ['bottwo'] });
    expect(await senderGate({ from: 'Bot Two', self: 'BotOne', policy, admit: yes })).toBe('silent');
    expect(await senderGate({ from: 'bot one', self: 'BotOne', policy, admit: yes })).toBe('silent');
    expect(await senderGate({ from: '', self: 'BotOne', policy, admit: yes })).toBe('silent');
  });

  it('is silent for an approved person the host does not admit', async () => {
    const asked: string[] = [];
    const admit = async (from: string): Promise<boolean> => {
      asked.push(from);
      return false;
    };
    expect(await senderGate({ from: 'Bob', self: 'BotOne', policy: policyFixture(), admit })).toBe('silent');
    expect(asked).toEqual(['bob']);
    expect(await senderGate({ from: 'alice', self: 'BotOne', policy: policyFixture(), admit: no })).toBe('silent');
  });

  it('does not ask the host about a stranger', async () => {
    let asked = 0;
    const admit = async (): Promise<boolean> => {
      asked += 1;
      return true;
    };
    await senderGate({ from: 'mallory', self: 'BotOne', policy: policyFixture(), admit });
    expect(asked).toBe(0);
  });
});

describe('Slots', () => {
  it('gives one transfer per person and four in total', () => {
    const slots = new Slots();
    expect(slots.take('alice', 'send-file')).toBe('ok');
    expect(slots.take('Alice', 'send-file')).toBe('busy');
    expect(slots.take('bob', 'send-file')).toBe('ok');
    expect(slots.take('carol', 'send-file')).toBe('ok');
    expect(slots.take('dave', 'send-file')).toBe('ok');
    expect(slots.active()).toBe(FILES_LIMITS.active);
    expect(slots.take('erin', 'send-file')).toBe('busy-others');
    expect(slots.take('alice', 'send-file')).toBe('busy');
    slots.release('ALICE', 'send-file');
    expect(slots.active()).toBe(3);
    expect(slots.take('erin', 'send-file')).toBe('ok');
  });

  it('counts a Direct IM session and a transfer of one person apart', () => {
    const slots = new Slots();
    expect(slots.take('alice', 'direct-im')).toBe('ok');
    expect(slots.take('alice', 'send-file')).toBe('ok');
    expect(slots.take('alice', 'direct-im')).toBe('busy');
    expect(slots.active()).toBe(2);
    slots.release('alice', 'direct-im');
    slots.release('alice', 'direct-im');
    expect(slots.active()).toBe(1);
  });
});
