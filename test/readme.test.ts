import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { configProblems } from '../src/config.js';

const text = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8');
const lines = text.split('\n');
const prose = text.replace(/```[\s\S]*?```/g, '');
const flat = prose.replace(/\s+/g, ' ');

function jsonBlock(): Record<string, unknown> {
  const block = /```json\n([\s\S]*?)```/.exec(text)?.[1];
  if (!block) throw new Error('README has no json block');
  return JSON.parse(block) as Record<string, unknown>;
}

describe('README says what operators must know', () => {
  it.each<[string, RegExp]>([
    ['approved people start turns', /An approved person can start agent turns\./],
    ['shell and file tools are blocked for them', /blocks shell and file tools for them by default/],
    ['what an owner is', /An owner is someone you would give a shell on this host/],
    ['no owner, no start', /The bot does not start until `owners` names at least one person/],
    ['room name rule', /A room name has no `-`, `\/` or `:`/],
    ['what setup proposes', /setup proposes an owner's name followed by four random characters/],
    ['bots trust upward across hosts', /subordinate bots trust every bot above them, across hosts/],
    ['where to put senior bots', /Put the senior bots on the best-protected gateway/],
    ['plaintext lets the path become the owner', /On a plaintext server, anyone on the network path between an owner and the server can become that owner/],
    ['use TLS', /Use TLS where the server offers it/],
    ['rooms and away text are public', /Rooms, room names and away text are visible to everyone on the server/],
    ['private means unlisted', /A private room is unlisted, with no lock/],
    ['no password check voids it all', /A server that does not check passwords voids all of the above/],
    ['the plugin refuses such a server', /refuses to run there unless you set `dangerouslyAllowUnauthenticatedServer`/],
    ['the auto-created password', /An account auto-created on such a server has the password `welcome1`/],
    ['a second sign-in kicks the bot', /Never sign in to a bot's screen name from another client\. It kicks the bot/],
    ['so does a web login', /A web API login does the same/],
    ['the bot flag and the pacing without it', /set the bot flag on the account\. Without it the server paces the bot to about one IM every 4 to 5 seconds/],
    ['approval by command', /\/allowlist add dm <name>.*`commands\.config: true`/],
    ['daily reset and prune', /resets sessions daily at 04:00 by default, and the session store prunes at 500 entries/],
    ['session tools for other channels', /For awareness across channels, use OpenClaw's session tools/],
    ['memory-only state', /live in memory and are lost when the gateway restarts/],
    ['non-ASCII names', /non-ASCII letters cannot be owners, approved people or team members/],
    ['room rate limit silence', /silent in that room for up to two minutes/],
    ['what is not built', /no TOC transport, no file transfer, no buddy icons and no media/],
  ])('%s', (_name, pattern) => {
    expect(flat).toMatch(pattern);
  });

  it('gives both install lines', () => {
    expect(lines).toContain('openclaw plugins install clawhub:@ukozi/openclaw-oscar');
    expect(lines).toContain('openclaw plugins install npm:@ukozi/openclaw-oscar');
  });
});

describe('README config example', () => {
  it('is valid for the real schema', () => {
    expect(configProblems(jsonBlock())).toEqual([]);
  });

  it('carries the tool line, the agent list, the binding and the command switch', () => {
    const cfg = jsonBlock() as {
      tools: { alsoAllow: string[] }; agents: { list: { id: string }[] };
      bindings: { agentId: string; match: { channel: string; accountId: string } }[];
      commands: { config: boolean; ownerAllowFrom: string[] };
      channels: { oscar: { owners: string[]; accounts: Record<string, { password: unknown }> } };
    };
    expect(cfg.tools.alsoAllow).toEqual(['message', 'oscar_delegate', 'oscar_status', 'oscar_room']);
    expect(cfg.agents.list.map((a) => a.id)).toContain(cfg.bindings[0]?.agentId);
    expect(cfg.bindings[0]?.match).toEqual({ channel: 'oscar', accountId: 'botone' });
    expect(cfg.commands.config).toBe(true);
    expect(cfg.commands.ownerAllowFrom).toEqual(cfg.channels.oscar.owners.map((o) => `oscar:${o}`));
    expect(cfg.channels.oscar.accounts.botone?.password).toEqual({ source: 'env', provider: 'default', id: 'OSCAR_PASSWORD' });
  });

  it('uses a room name with no dash, shaped like the one setup proposes', () => {
    const cfg = jsonBlock() as { channels: { oscar: { owners: string[]; room: { name: string } } } };
    const name = cfg.channels.oscar.room.name;
    expect(name).not.toContain('-');
    expect(name).toMatch(new RegExp(`^${cfg.channels.oscar.owners[0]}[a-z2-7]{4}$`));
  });

  it('uses only neutral names and an example host', () => {
    const block = JSON.stringify(jsonBlock());
    const names = [...block.matchAll(/"(?:screenName|agentId|id)":"([^"]+)"/g)].map((m) => m[1]);
    for (const name of names) expect(['botone', 'bottwo', 'main', 'OSCAR_PASSWORD']).toContain(name);
    expect(block).toContain('"host":"oscar.example.net"');
  });

  it('shows the password only as a SecretRef or a file path', () => {
    const literal = /\bpassword\b["']?\s*[:=]\s*["'`]?[^\s"'`{][^\s"'`]{15,}/i;
    expect(lines.filter((l) => literal.test(l))).toEqual([]);
    expect(text).toContain('"passwordFile": "/run/secrets/oscar-botone"');
    expect(text).not.toMatch(/--password/);
  });
});

describe('README style', () => {
  it('stays about a screen and a half', () => {
    expect(lines.length).toBeLessThanOrEqual(110);
  });

  it('is plain ASCII with no emoji, arrows, dashes or curly quotes', () => {
    expect(lines.filter((l) => /[^\x20-\x7e]/.test(l))).toEqual([]);
    expect(prose).not.toMatch(/--|->/);
  });

  it('writes headings in sentence case', () => {
    const headings = lines.filter((l) => l.startsWith('#')).map((l) => l.replace(/^#+\s*/, ''));
    expect(headings.length).toBeGreaterThan(3);
    for (const h of headings.slice(1)) {
      const later = h.split(' ').slice(1).filter((w) => /^[A-Z]/.test(w));
      expect(later).toEqual([]);
    }
  });

  it('has no sales words, badges or bold-led bullets', () => {
    expect(prose).not.toMatch(/\b(robust|seamless|powerful|comprehensive|leverag\w+|delve|blazing|effortless\w*|cutting-edge|feature-rich)\b/i);
    // Screenshots are fine; badges are not.
    expect(text).not.toMatch(/!\[[^\]]*\]\([^)]*(?:shields\.io|badgen|badge|travis-ci|circleci|codecov|app\.veyor)[^)]*\)/i);
    expect(lines.filter((l) => /^\s*[-*]\s+\*\*/.test(l))).toEqual([]);
  });

  it('names the older messenger only in the one allowed phrase', () => {
    const allowed = 'compatible with AOL Instant Messenger';
    expect(text.split(allowed)).toHaveLength(2);
    const rest = text.replace(allowed, '');
    expect(rest).not.toMatch(/\bAIM\b|\bAOL\b|Instant Messenger/);
  });
});
