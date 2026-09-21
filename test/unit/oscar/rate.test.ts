import { describe, expect, it } from 'vitest';
import { RateGovernor, checkRate } from '../../../src/oscar/rate.js';
import type { RateClassParams } from '../../../src/oscar/rate.js';

const CLASS3: RateClassParams = {
  id: 3,
  windowSize: 20,
  clearLevel: 5100,
  alertLevel: 5000,
  limitLevel: 4000,
  disconnectLevel: 3000,
  currentLevel: 6000,
  maxLevel: 6000,
};

function governor() {
  let t = 1_000_000;
  const g = new RateGovernor({ now: () => t });
  g.seed({ ...CLASS3 });
  return { g, advance: (ms: number) => (t += ms) };
}

function small(over: Partial<RateClassParams>): RateClassParams {
  return { id: 1, windowSize: 4, maxLevel: 1000, clearLevel: 100, disconnectLevel: 5, limitLevel: 20, alertLevel: 40, currentLevel: 0, ...over };
}

describe('checkRate, rows from the server test table', () => {
  const rows: [string, RateClassParams, number, number, boolean, string, number][] = [
    ['limited and back over clear', small({ clearLevel: 10, disconnectLevel: 2, limitLevel: 5, alertLevel: 8 }), 9, 50, true, 'clear', 19],
    ['limited and still under clear', small({ clearLevel: 50, disconnectLevel: 10, limitLevel: 20, alertLevel: 30 }), 10, 30, true, 'limited', 15],
    ['under disconnect', small({}), 1, 10, false, 'disconnect', 3],
    ['under disconnect while limited', small({}), 1, 10, true, 'disconnect', 3],
    ['under limit', small({ limitLevel: 40, alertLevel: 60 }), 10, 20, false, 'limited', 12],
    ['under alert', small({}), 20, 30, false, 'alert', 22],
    ['at or over alert', small({}), 39, 50, false, 'clear', 41],
    ['clamped to max', small({ maxLevel: 100, clearLevel: 80, disconnectLevel: 20, limitLevel: 40, alertLevel: 60 }), 95, 9999, false, 'clear', 100],
  ];
  it.each(rows)('%s', (_name, params, level, elapsed, limited, status, next) => {
    expect(checkRate(params, level, elapsed, limited)).toEqual({ status, level: next });
  });
});

describe('RateGovernor against class 3', () => {
  it('never holds anything before it is seeded', () => {
    const g = new RateGovernor({ now: () => 0 });
    expect([g.waitMs(), g.sent(), g.status(), g.troubledWithin(1000)]).toEqual([0, 'clear', 'clear', false]);
    g.dropped();
    expect(g.waitMs()).toBe(0);
  });

  it('lets three sends through back to back, then asks for a wait that keeps the level at the alert line', () => {
    const { g, advance } = governor();
    for (let i = 0; i < 3; i++) {
      expect(g.waitMs()).toBe(0);
      expect(g.sent()).toBe('clear');
    }
    // level is 5144 after three sends; 20 * 5000 - 19 * 5144 = 2264 ms
    expect(g.waitMs()).toBe(2264);
    advance(2264);
    expect(g.waitMs()).toBe(0);
    expect(g.sent()).toBe('clear');
  });

  it('settles at one send every five seconds and never raises an alert', () => {
    const { g, advance } = governor();
    const waits: number[] = [];
    for (let i = 0; i < 40; i++) {
      const wait = g.waitMs();
      waits.push(wait);
      advance(wait);
      expect(g.sent()).toBe('clear');
    }
    for (const wait of waits.slice(10)) {
      expect(wait).toBeGreaterThanOrEqual(4900);
      expect(wait).toBeLessThanOrEqual(5100);
    }
  });

  it('models what the server does to a client that ignores it: seven accepted, the eighth dropped, about 26 s to recover', () => {
    const { g, advance } = governor();
    const statuses: string[] = [];
    for (let i = 0; i < 8; i++) statuses.push(g.sent());
    expect(statuses).toEqual(['clear', 'clear', 'clear', 'alert', 'alert', 'alert', 'alert', 'limited']);
    // level is 3977; 20 * 5100 - 19 * 3977 = 26437 ms
    expect(g.waitMs()).toBe(26_437);
    advance(26_437);
    expect(g.waitMs()).toBe(0);
    expect(g.sent()).toBe('clear');
  });

  it('dropped() holds sends until the clear level is reachable', () => {
    const { g, advance } = governor();
    g.sent();
    g.dropped();
    expect(g.status()).toBe('limited');
    // 20 * 5100 - 19 * 3999 = 26019 ms
    expect(g.waitMs()).toBe(26_019);
    advance(10_000);
    expect(g.waitMs()).toBe(16_019);
    expect(g.troubledWithin(30_000)).toBe(true);
    advance(21_000);
    expect(g.troubledWithin(30_000)).toBe(false);
  });

  it('follows server notices', () => {
    const { g } = governor();
    expect(g.notice(3, { ...CLASS3, currentLevel: 3900 })).toBe('limited');
    expect(g.waitMs()).toBe(20 * 5100 - 19 * 3900);
    expect(g.notice(4, { ...CLASS3, currentLevel: 5100 })).toBe('clear');
    expect(g.notice(2, { ...CLASS3, currentLevel: 4500 })).toBe('alert');
    expect(g.troubledWithin(1)).toBe(true);
    expect(g.notice(1, { ...CLASS3, limitLevel: 5000, alertLevel: 5500, clearLevel: 5600, currentLevel: 6000 })).toBe('clear');
  });

  it('can be seeded by a notice alone', () => {
    const g = new RateGovernor({ now: () => 50 });
    expect(g.notice(3, { ...CLASS3, currentLevel: 3900 })).toBe('limited');
    expect(g.waitMs()).toBeGreaterThan(20_000);
  });
});
