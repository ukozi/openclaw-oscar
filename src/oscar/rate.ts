import { ByteReader } from './bytes.js';
import type { RoomPacer } from './chatroom.js';
import {
  CHAT_MSG_TO_HOST,
  CHAT_SEND_RATE_CLASS,
  FAMILY_CHAT,
  RATE_CLASS_RECORD_LENGTH_V2,
  RATE_CODE_ALERT,
  RATE_CODE_CLEAR,
  RATE_CODE_LIMITED,
} from './constants.js';

export type RateClassParams = {
  id: number;
  windowSize: number;
  clearLevel: number;
  alertLevel: number;
  limitLevel: number;
  disconnectLevel: number;
  currentLevel: number;
  maxLevel: number;
};
export type RateStatus = 'clear' | 'alert' | 'limited';
export type RateCheck = { status: RateStatus | 'disconnect'; level: number };

// Same arithmetic as the server's CheckRateLimit, integer division included.
export function checkRate(p: RateClassParams, level: number, elapsedMs: number, limitedNow: boolean): RateCheck {
  const next = Math.min(p.maxLevel, Math.trunc((level * (p.windowSize - 1) + elapsedMs) / p.windowSize));
  if (next < p.disconnectLevel) return { status: 'disconnect', level: next };
  if (limitedNow) return { status: next >= p.clearLevel ? 'clear' : 'limited', level: next };
  if (next < p.limitLevel) return { status: 'limited', level: next };
  if (next < p.alertLevel) return { status: 'alert', level: next };
  return { status: 'clear', level: next };
}

function readRateClass(r: ByteReader, v2: boolean): RateClassParams {
  const p: RateClassParams = {
    id: r.u16(),
    windowSize: r.u32(),
    clearLevel: r.u32(),
    alertLevel: r.u32(),
    limitLevel: r.u32(),
    disconnectLevel: r.u32(),
    currentLevel: r.u32(),
    maxLevel: r.u32(),
  };
  if (v2) r.bytes(5);
  return p;
}

export type RateParamsReply = { classes: RateClassParams[]; classOf(family: number, subtype: number): number | undefined };

// Records are 30 bytes when ClientVersions announced OService 1, which this client always does.
export function decodeRateParamsReply(body: Uint8Array): RateParamsReply {
  const r = new ByteReader(body);
  const count = r.u16();
  const classes: RateClassParams[] = [];
  for (let i = 0; i < count; i++) classes.push(readRateClass(r, false));
  const groups = new Map<number, number>();
  while (r.remaining > 0) {
    const classId = r.u16();
    const pairs = r.u16();
    for (let i = 0; i < pairs; i++) groups.set(r.u16() * 0x10000 + r.u16(), classId);
  }
  return { classes, classOf: (family, subtype) => groups.get(family * 0x10000 + subtype) };
}

export function decodeRateParamChange(body: Uint8Array): { code: number; params: RateClassParams } {
  const r = new ByteReader(body);
  const code = r.u16();
  return { code, params: readRateClass(r, r.remaining >= RATE_CLASS_RECORD_LENGTH_V2) };
}

// One rate class on one connection. It runs the server's own moving average, so it knows how
// long to wait before another SNAC in the class keeps the level at or above the alert line.
export class RateGovernor {
  private readonly now: () => number;
  private params: RateClassParams | null = null;
  private level = 0;
  private lastAt = 0;
  private limited = false;
  private troubleAt = Number.NEGATIVE_INFINITY;

  constructor(opts: { now: () => number }) {
    this.now = opts.now;
  }

  seed(params: RateClassParams): void {
    this.params = params;
    this.level = params.currentLevel;
    this.lastAt = this.now();
    this.limited = params.currentLevel < params.limitLevel;
  }

  status(): RateStatus {
    if (!this.params) return 'clear';
    if (this.limited) return 'limited';
    return this.level < this.params.alertLevel ? 'alert' : 'clear';
  }

  waitMs(): number {
    const p = this.params;
    if (!p) return 0;
    const target = this.limited ? p.clearLevel : p.alertLevel;
    const needed = target * p.windowSize - this.level * (p.windowSize - 1);
    return Math.max(0, needed - (this.now() - this.lastAt));
  }

  sent(): RateStatus {
    const p = this.params;
    if (!p) return 'clear';
    const now = this.now();
    const check = checkRate(p, this.level, now - this.lastAt, this.limited);
    this.level = check.level;
    this.lastAt = now;
    this.limited = check.status === 'limited' || check.status === 'disconnect';
    if (check.status !== 'clear') this.troubleAt = now;
    return this.status();
  }

  // A send with no receipt on a live socket was dropped by the server's limiter,
  // so the server's level is under the limit whatever this model believed.
  dropped(): void {
    const p = this.params;
    if (!p) return;
    this.limited = true;
    this.level = Math.min(this.level, p.limitLevel - 1);
    this.troubleAt = this.now();
  }

  notice(code: number, params: RateClassParams): RateStatus {
    if (!this.params) this.lastAt = this.now();
    this.params = params;
    this.level = params.currentLevel;
    if (code === RATE_CODE_LIMITED) this.limited = true;
    if (code === RATE_CODE_CLEAR) this.limited = false;
    if (code === RATE_CODE_LIMITED || code === RATE_CODE_ALERT) this.troubleAt = this.now();
    return this.status();
  }

  troubledWithin(ms: number): boolean {
    return this.troubleAt >= this.now() - ms;
  }
}

export function createRoomPacer(now: () => number): RoomPacer {
  // room sessions never carry the bot flag, so a room is governed even when BOS is exempt
  const governor = new RateGovernor({ now });
  let classId = CHAT_SEND_RATE_CLASS;
  return {
    seed(rateParamsReply) {
      const reply = decodeRateParamsReply(rateParamsReply);
      classId = reply.classOf(FAMILY_CHAT, CHAT_MSG_TO_HOST) ?? CHAT_SEND_RATE_CLASS;
      const params = reply.classes.find((c) => c.id === classId);
      if (params) governor.seed(params);
    },
    notice(rateParamChange) {
      const change = decodeRateParamChange(rateParamChange);
      if (change.params.id !== classId) return null;
      return governor.notice(change.code, change.params);
    },
    waitMs: () => governor.waitMs(),
    sent: () => governor.sent(),
    dropped: () => governor.dropped(),
  };
}
