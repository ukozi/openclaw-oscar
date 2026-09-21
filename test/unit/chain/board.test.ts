import { describe, expect, it } from 'vitest';
import { JobBoard } from '../../../src/chain/handoff.js';
import type { RoomRef } from '../../../src/names.js';
import { ROOM, chainConfig } from './fixtures.js';

const NOW = 1_000_000;
const TIMEOUT = 20 * 60_000;
const SIDE: RoomRef = { exchange: 4, name: 'side' };
const HANDOFF = 'bottwo: tighten the intro [d:1-k7f3 h:1 o:alice]';

function resolve(raw: string): string | null {
  const wanted = raw.replace(/\s+/g, '').toLowerCase();
  for (const entry of chainConfig().roster) {
    if (entry.screenName === wanted) return entry.screenName;
    if (entry.aliases.includes(wanted)) return entry.screenName;
  }
  return null;
}

function make(): JobBoard {
  return new JobBoard({ maxAgeMs: () => TIMEOUT, resolve, now: () => NOW });
}

type Row = {
  name: string;
  lines: { from: string; text: string }[];
  left?: string;
  open: { id: string; to: string; by: string; originator: string }[];
};

const rows: Row[] = [
  {
    name: 'a job this bot handed out',
    lines: [{ from: 'botone', text: HANDOFF }],
    open: [{ id: '1-k7f3', to: 'bottwo', by: 'botone', originator: 'alice' }],
  },
  {
    name: 'a job between two other bots',
    lines: [{ from: 'bottwo', text: 'botthree: check the build [d:2-aaaa h:2 o:alice]' }],
    open: [{ id: '2-aaaa', to: 'botthree', by: 'bottwo', originator: 'alice' }],
  },
  {
    name: 'a job that was closed',
    lines: [{ from: 'botone', text: HANDOFF }, { from: 'bottwo', text: 'botone: done [d:1-k7f3]' }],
    open: [],
  },
  {
    name: 'a result from the wrong mouth leaves the job open',
    lines: [{ from: 'botone', text: HANDOFF }, { from: 'botthree', text: 'botone: done [d:1-k7f3]' }],
    open: [{ id: '1-k7f3', to: 'bottwo', by: 'botone', originator: 'alice' }],
  },
  {
    name: 'a job whose holder left',
    lines: [{ from: 'botone', text: HANDOFF }, { from: 'bottwo', text: 'botthree: and the numbers [d:2-bbbb h:2 o:alice]' }],
    left: 'bottwo',
    open: [{ id: '2-bbbb', to: 'botthree', by: 'bottwo', originator: 'alice' }],
  },
  {
    name: 'a job from before this bot joined the room',
    lines: [{ from: 'bottwo', text: 'botone: done [d:1-zzzz]' }],
    open: [],
  },
  {
    name: 'two jobs held by the same bot',
    lines: [
      { from: 'botone', text: HANDOFF },
      { from: 'botone', text: 'writer: and the release note [d:1-m4x2 h:1 o:bob]' },
    ],
    open: [
      { id: '1-k7f3', to: 'bottwo', by: 'botone', originator: 'alice' },
      { id: '1-m4x2', to: 'bottwo', by: 'botone', originator: 'bob' },
    ],
  },
  {
    name: 'a hand-off an approved person pasted',
    lines: [{ from: 'bob', text: HANDOFF }],
    open: [],
  },
  {
    name: 'a bot addressing itself',
    lines: [{ from: 'bottwo', text: 'writer: tighten the intro [d:2-cccc h:1 o:alice]' }],
    open: [],
  },
];

describe('JobBoard', () => {
  for (const row of rows) {
    it(row.name, () => {
      const board = make();
      for (const l of row.lines) board.note(ROOM, { from: l.from, text: l.text, at: NOW });
      if (row.left) board.holderLeft(ROOM, row.left);
      const open = board.openIn(ROOM, NOW).map((job) => ({ id: job.id, to: job.to, by: job.by, originator: job.originator }));
      expect(open).toEqual(row.open);
    });
  }

  it('keeps rooms apart', () => {
    const board = make();
    board.note(SIDE, { from: 'botone', text: HANDOFF, at: NOW });
    expect(board.openIn(ROOM, NOW)).toEqual([]);
    expect(board.openIn(SIDE, NOW).map((job) => job.id)).toEqual(['1-k7f3']);
    board.holderLeft(ROOM, 'bottwo');
    expect(board.openIn(SIDE, NOW)).toHaveLength(1);
  });

  it('drops a job nobody closed once it is older than the window', () => {
    const board = make();
    board.note(ROOM, { from: 'botone', text: HANDOFF, at: NOW });
    expect(board.openIn(ROOM, NOW + TIMEOUT - 1)).toHaveLength(1);
    expect(board.openIn(ROOM, NOW + TIMEOUT)).toHaveLength(0);
  });

  it('keeps the first sighting when the same line arrives twice', () => {
    const board = make();
    board.note(ROOM, { from: 'botone', text: HANDOFF, at: NOW });
    board.note(ROOM, { from: 'botone', text: HANDOFF, at: NOW + 60_000 });
    expect(board.openIn(ROOM, NOW + 60_000).map((job) => job.since)).toEqual([NOW]);
  });

  it('clears', () => {
    const board = make();
    board.note(ROOM, { from: 'botone', text: HANDOFF, at: NOW });
    board.clear();
    expect(board.openIn(ROOM, NOW)).toEqual([]);
  });
});
