export type AwayFamily = 'shell' | 'files' | 'web' | 'handoff' | 'memory';
export type Outcome = 'done' | 'none' | 'failed';

const AWAY_DEFAULT = 'Working on something. Back in a bit.';

const AWAY_PHRASES: Record<AwayFamily, string> = {
  shell: 'Running some commands',
  files: 'Working in some files',
  web: 'Looking something up',
  handoff: 'Handing work to a teammate',
  memory: 'Checking my notes',
};

const OUTCOMES: Record<Outcome, string> = {
  done: 'done',
  none: 'nothing to report',
  failed: 'that failed on my side',
};

function orDefault(text: string, fallback: string): string {
  return text.trim().length > 0 ? text : fallback;
}

export const copy = {
  noticeIm: (name: string): string => `${name} tried to message me. I did not reply.`,
  noticeInvite: (name: string): string => `${name} invited me to a chat. I did not join.`,
  noticeApprove: (name: string, viaChat: boolean): string =>
    viaChat
      ? `To let them in, reply: /allowlist add dm ${name}`
      : `To let them in, add ${name} to channels.oscar.allowFrom.`,
  noticeOddName: (): string => 'That name contains unusual letters.',
  noticeRollup: (n: number): string =>
    n === 1
      ? '1 more person tried to reach me this hour. I did not reply to them.'
      : `${n} more people tried to reach me this hour. I did not reply to any of them.`,
  unlistedJoin: (name: string, room: string): string => `${name} joined ${room}. They are not on my lists.`,
  inviteFull: (): string => "I can't join right now, I'm in too many rooms.",
  ack: (text: string): string => orDefault(text, 'on it'),
  busy: (text: string): string => orDefault(text, 'busy, will pick this up next'),
  closing: (): string => 'nothing to add',
  takeover: (lead: string): string => `${lead} is quiet, I'll take this.`,
  mismatch: (a: string, b: string): string =>
    `${a} and ${b} disagree about the chain of command. Using name order until their configs match.`,
  outcome: (delegator: string, id: string, kind: Outcome): string => `${delegator}: ${OUTCOMES[kind]} [d:${id}]`,
  awayDefault: (): string => AWAY_DEFAULT,
  awayPhrase: (family: AwayFamily): string => AWAY_PHRASES[family],
  awayAutoReply: (line: string): string => orDefault(line.trim(), AWAY_DEFAULT),
};
