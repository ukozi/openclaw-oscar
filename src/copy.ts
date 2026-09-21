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

export type DelegateErrorKind =
  | 'not-in-room'
  | 'absent'
  | 'not-below'
  | 'hops'
  | 'wildcard'
  | 'mismatch'
  | 'rate'
  | 'send-failed'
  | 'lost-turn'
  | 'too-long'
  | 'empty';

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
  delegateError: (kind: DelegateErrorKind, to = ''): string => {
    switch (kind) {
      case 'not-in-room':
        return 'hand-offs only work in a room; tell the owner';
      case 'absent':
        return `${to} is not in this room`;
      case 'not-below':
        return `${to} is not below you in the chain`;
      case 'hops':
        return 'too many hops';
      case 'wildcard':
        return 'the chain is unsafe on this host: commands.ownerAllowFrom contains *';
      case 'mismatch':
        return `${to} has a different chain config; hand-offs to it are off until the configs match`;
      case 'rate':
        return 'the room is rate limited and the hand-off has not gone out; tell the owner';
      case 'lost-turn':
        return 'I lost track of who asked for this; ask them to repeat it';
      case 'too-long':
        return 'the task is too long for one room message; shorten it';
      case 'send-failed':
        return 'the hand-off could not be sent; tell the owner';
      case 'empty':
        return 'say what the job is';
    }
  },
  delegateSent: (to: string, id: string): string => `handed to ${to} as ${id}`,
  noteTimeout: (to: string, id: string, minutes: number): string =>
    `System note: ${to} has not answered hand-off ${id} after ${minutes} minutes. Tell the person who asked.`,
  noteLeft: (to: string, id: string): string =>
    `System note: ${to} left the room before answering hand-off ${id}. Tell the person who asked.`,
  noteLostLedger: (id: string): string =>
    `System note: this is a result for hand-off ${id}, which I no longer have a record of.`,
  noteResult: (to: string, id: string): string => `System note: ${to} finished hand-off ${id}. Review the result below.`,
  awayDefault: (): string => AWAY_DEFAULT,
  awayPhrase: (family: AwayFamily): string => AWAY_PHRASES[family],
  awayAutoReply: (line: string): string => orDefault(line.trim(), AWAY_DEFAULT),
};
