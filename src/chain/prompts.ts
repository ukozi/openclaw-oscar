import type { RootPolicy, RosterEntry } from '../config.js';
import { normalizeName } from '../names.js';
import { rosterNames } from './route.js';
import type { WakeWhy } from './types.js';

export type PromptVariant = 'chair' | 'worker' | 'handoff' | 'solo';

const ROUTED = 'This line was routed to you on purpose: answer it, or reply NO_REPLY only if it needs no answer at all. Do not wait to be named.';
const CHAIR_JOB = 'This line was routed to you because it named nobody, and your first job is to decide who should answer it, not to answer it yourself.';
const CHAIR_BUSY = 'A teammate marked busy is already working on something.';
const CHAIR_PICK = 'If the line follows on from work a teammate is already doing, give it to that teammate. '
  + 'Otherwise pick whoever fits it best and is free, and hand it to them. '
  + 'Take it yourself only when you are the right one for it.';
const CHAIR_NO_REPLY = 'Reply NO_REPLY only when the line needs no answer from anyone.';
const WORKER_RULE = 'You answer when someone names you, hands you a job, or answers a question you asked.';
const HAND = 'Hand a job over by calling oscar_delegate, or by writing a line that starts with their name and a colon; '
  + 'that is a teammate, which is a different thing from a subagent.';
const PUBLIC = 'Anyone may be reading this room: never post secrets, credentials or file contents.';

export const TEAM_FACT_NOTE = 'This list holds only the hand-offs I have seen in this room, for as long as I have been in it. '
  + 'It is not a register: an empty list can mean nobody has handed anything over, or that it happened where I could not see it. '
  + 'When it is empty or looks out of date, ask rather than assume a teammate is free.';

export function promptVariant(why: WakeWhy, policy: RootPolicy): PromptVariant {
  if (policy.chain.roster.length === 0) return 'solo';
  if (why === 'handoff') return 'handoff';
  if (why === 'lead' || why === 'invited' || why === 'takeover') return 'chair';
  return 'worker';
}

function teammatesBelow(self: string, policy: RootPolicy): RosterEntry[] {
  const idx = rosterNames(policy).indexOf(self);
  return idx < 0 ? [] : policy.chain.roster.slice(idx + 1);
}

function nameList(entries: RosterEntry[]): string {
  return entries
    .map((entry) => (entry.role ? `${normalizeName(entry.screenName)}: ${entry.role}` : normalizeName(entry.screenName)))
    .join(', ');
}

export function roomSystemPrompt(input: {
  self: string;
  policy: RootPolicy;
  why: WakeWhy;
  handoff?: { delegator: string; originator: string };
}): string {
  const { self, policy } = input;
  const variant = promptVariant(input.why, policy);
  const team = teammatesBelow(self, policy);
  const parts: string[] = [];
  if (variant === 'solo' || (variant === 'chair' && team.length === 0)) {
    parts.push(`You are ${self}, an assistant in this chat room.`, ROUTED);
  } else if (variant === 'chair') {
    parts.push(
      `You are ${self}, the chair of a team of assistants in this chat room.`,
      CHAIR_JOB,
      `Your teammates and what each is for: ${nameList(team)}.`,
      CHAIR_BUSY,
      CHAIR_PICK,
      HAND,
      CHAIR_NO_REPLY,
    );
  } else {
    parts.push(`You are ${self}, an assistant on a team in this chat room.`, WORKER_RULE);
    if (team.length > 0) parts.push(`Teammates below you: ${nameList(team)}.`, HAND);
  }
  parts.push(PUBLIC);
  if (variant === 'handoff' && input.handoff) {
    parts.push(`${input.handoff.delegator} handed you this job for ${input.handoff.originator}. Reply in the room with the result.`);
  }
  return parts.join(' ');
}
