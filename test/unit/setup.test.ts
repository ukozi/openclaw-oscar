import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('openclaw/plugin-sdk/status-helpers', async () => (await import('../fake/openclaw.js')).statusHelpers);

import { configProblems } from '../../src/config.js';
import { envVarFor, oscarSetupAdapter, oscarSetupWizard, parseOscarUrl, proposeRoomName, runFinalizeChecks, setupDeps, withOwnerAllowFrom } from '../../src/setup.js';
import { TOOLS_ALSO_ALLOW_LINE } from '../../src/status.js';

type Obj = Record<string, unknown>;
const sectionOf = (cfg: unknown) => ((cfg as { channels: { oscar: Obj } }).channels.oscar);

function prompter(answers: { text: string[]; confirm: boolean[] }) {
  const notes: string[] = [];
  const asked: string[] = [];
  return {
    notes, asked,
    api: {
      intro: async () => undefined, outro: async () => undefined,
      note: async (message: string) => { notes.push(message); },
      text: async (p: { message: string; initialValue?: string; validate?: (v: string) => string | undefined }) => {
        asked.push(p.message);
        const next = answers.text.shift();
        const value = next === undefined || next === '=' ? p.initialValue ?? '' : next;
        const problem = p.validate?.(value);
        if (problem) throw new Error(`invalid answer for "${p.message}": ${problem}`);
        return value;
      },
      confirm: async (p: { message: string }) => { asked.push(p.message); return answers.confirm.shift() ?? false; },
      select: async () => { throw new Error('select is not used'); },
      multiselect: async () => { throw new Error('multiselect is not used'); },
      progress: () => ({ update: () => undefined, stop: () => undefined }),
    },
  };
}

beforeEach(() => {
  setupDeps.checkLogin = async () => ({ ok: true, bosHost: 'oscar.example.net', bosPort: 5190, redirectProblem: null });
  setupDeps.checkPasswordEnforced = async () => 'checks';
});

describe('url form', () => {
  it.each([
    ['oscar://botone@oscar.example.net', { screenName: 'botone', host: 'oscar.example.net', port: 5190, tls: false }],
    ['oscar://botone@oscar.example.net:5191', { screenName: 'botone', host: 'oscar.example.net', port: 5191, tls: false }],
    ['oscars://Bot%20One@oscar.example.net:443', { screenName: 'Bot One', host: 'oscar.example.net', port: 443, tls: true }],
    ['  oscar://botone@Oscar.Example.NET  ', { screenName: 'botone', host: 'oscar.example.net', port: 5190, tls: false }],
  ])('parses %j', (raw, want) => {
    expect(parseOscarUrl(raw)).toEqual(want);
  });

  it.each(['', 'botone@oscar.example.net', 'https://botone@oscar.example.net', 'oscar://oscar.example.net', 'oscar://botone:pw@oscar.example.net', 'oscar://botone@', 'oscar://botone@host/path', 'oscar://b%ZZ@host'])('rejects %j', (raw) => {
    expect(parseOscarUrl(raw)).toBeNull();
  });
});

describe('setup adapter', () => {
  it('writes the default account at the root', () => {
    const cfg = oscarSetupAdapter.applyAccountConfig({ cfg: {} as never, accountId: 'default', input: { url: 'oscars://Bot%20One@oscar.example.net:443', password: 'hunter22' } });
    expect(sectionOf(cfg)).toEqual({ enabled: true, host: 'oscar.example.net', port: 443, tls: true, screenName: 'Bot One', password: 'hunter22' });
  });

  it('writes a named account under accounts and leaves root policy alone', () => {
    const start = { channels: { oscar: { host: 'oscar.example.net', owners: ['alice'] } } };
    const cfg = oscarSetupAdapter.applyAccountConfig({ cfg: start as never, accountId: 'bottwo', input: { url: 'oscar://bottwo@oscar.example.net', useEnv: true } });
    expect(sectionOf(cfg)).toMatchObject({ owners: ['alice'], accounts: { bottwo: { enabled: true, screenName: 'bottwo', host: 'oscar.example.net', port: 5190, tls: false, password: { source: 'env', provider: 'default', id: 'OSCAR_PASSWORD_BOTTWO' } } } });
    expect(start.channels.oscar).toEqual({ host: 'oscar.example.net', owners: ['alice'] });
  });

  it('names the env var per account', () => {
    expect(envVarFor('default')).toBe('OSCAR_PASSWORD');
    expect(envVarFor('bot-two.x')).toBe('OSCAR_PASSWORD_BOT_TWO_X');
  });

  it.each([
    [{}, 'oscar://'],
    [{ url: 'nope', password: 'x' }, 'oscar://'],
    [{ url: 'oscar://botone@h' }, '--password'],
    [{ url: 'oscar://böt@h', password: 'hunter22' }, 'ASCII'],
  ])('rejects input %j', (input, text) => {
    expect(oscarSetupAdapter.validateInput?.({ cfg: {} as never, accountId: 'default', input })).toContain(text);
  });

  it('accepts a password-only update of a configured account', () => {
    const cfg = { channels: { oscar: { host: 'h', screenName: 'botone', password: 'old12345' } } };
    expect(oscarSetupAdapter.validateInput?.({ cfg: cfg as never, accountId: 'default', input: { password: 'new12345' } })).toBeNull();
    expect(sectionOf(oscarSetupAdapter.applyAccountConfig({ cfg: cfg as never, accountId: 'default', input: { password: 'new12345' } }))).toMatchObject({ host: 'h', screenName: 'botone', password: 'new12345' });
  });

  it('produces config the schema accepts, which still wants an owner before it runs', () => {
    const cfg = oscarSetupAdapter.applyAccountConfig({ cfg: {} as never, accountId: 'default', input: { url: 'oscar://botone@oscar.example.net', useEnv: true } });
    expect(configProblems(cfg)).toEqual(['channels.oscar.owners: list at least one owner; with none, OpenClaw treats every approved person as an owner']);
    const owned = { channels: { oscar: { ...sectionOf(cfg), owners: ['alice'] } } };
    expect(configProblems(owned)).toEqual([]);
  });

  it('puts root-only keys back after the host moved them under an account', () => {
    const moved = { channels: { oscar: {
      host: 'oscar.example.net', screenName: 'botone', owners: ['alice'],
      accounts: { default: { password: 'hunter22', allowFrom: ['bob'], dmPolicy: 'allowlist', rooms: { testroom: {} } } },
    } } };
    const cfg = oscarSetupAdapter.applyAccountConfig({ cfg: moved as never, accountId: 'bottwo', input: { url: 'oscar://bottwo@oscar.example.net', password: 'hunter23' } });
    expect(sectionOf(cfg)).toMatchObject({ owners: ['alice'], allowFrom: ['bob'], dmPolicy: 'allowlist', rooms: { testroom: {} } });
    expect((sectionOf(cfg).accounts as Obj).default).toEqual({ password: 'hunter22' });
    expect((sectionOf(cfg).accounts as Obj).bottwo).toMatchObject({ screenName: 'bottwo', password: 'hunter23' });
    expect(configProblems(cfg)).toEqual([]);
    expect(moved.channels.oscar.accounts.default.allowFrom).toEqual(['bob']);
  });
});

describe('owner list and room proposal', () => {
  it('adds prefixed owners once and keeps other entries', () => {
    const cfg = withOwnerAllowFrom({ commands: { ownerAllowFrom: ['slack:U1', 'oscar:alice'] } }, ['Alice', 'Alice B']);
    expect(cfg.commands.ownerAllowFrom).toEqual(['slack:U1', 'oscar:alice', 'oscar:aliceb']);
    expect(withOwnerAllowFrom({}, ['alice'])).toEqual({ commands: { ownerAllowFrom: ['oscar:alice'] } });
  });

  it('proposes a name without a dash that the room rule accepts', () => {
    expect(proposeRoomName('Alice B', new Uint8Array([0, 31, 32, 255]))).toBe('aliceba7a7');
    expect(proposeRoomName('x'.repeat(60))).toHaveLength(50);
    expect(proposeRoomName('alice')).toMatch(/^alice[a-z2-7]{4}$/);
  });
});

describe('finalize checks', () => {
  const cfg = (patch: Obj = {}, host: Obj = {}) => ({ tools: { profile: 'full' }, ...host, channels: { oscar: { host: 'oscar.example.net', screenName: 'botone', password: 'hunter22', owners: ['alice'], ...patch } } });

  it('passes on a good login', async () => {
    expect(await runFinalizeChecks({ cfg: withOwnerAllowFrom(cfg(), ['alice']), accountId: 'default', password: 'hunter22' })).toEqual([
      'Login: ok.', 'Password check: the server verifies passwords.', 'Owners: OpenClaw agrees on who the owners are.', 'Tools: visible to the agent.',
    ]);
  });

  it.each([
    [async () => ({ ok: false as const, reason: 'bad-password' as const }), 'Login failed: bad-password.'],
    [async () => ({ ok: false as const, reason: 'login-rate-limited' as const, detail: 'try later' }), 'Login failed: login-rate-limited (try later).'],
    [async () => ({ ok: true as const, bosHost: '127.0.0.1', bosPort: 5190, redirectProblem: 'the server redirects to a loopback address' }), 'Redirect: the server redirects to a loopback address. Set channels.oscar.redirect to "pin".'],
  ])('reports a login outcome', async (impl, line) => {
    setupDeps.checkLogin = impl as typeof setupDeps.checkLogin;
    expect(await runFinalizeChecks({ cfg: cfg(), accountId: 'default', password: 'hunter22' })).toContain(line);
  });

  it('does not probe after a failed login', async () => {
    let probed = false;
    setupDeps.checkLogin = async () => ({ ok: false, reason: 'bad-password' });
    setupDeps.checkPasswordEnforced = async () => { probed = true; return 'checks'; };
    await runFinalizeChecks({ cfg: cfg(), accountId: 'default', password: 'x' });
    expect(probed).toBe(false);
  });

  it('says so when the server does not check passwords', async () => {
    setupDeps.checkPasswordEnforced = async () => 'does-not-check';
    const lines = await runFinalizeChecks({ cfg: cfg(), accountId: 'default', password: 'hunter22' });
    expect(lines.some((l) => l.includes('does not check passwords') && l.includes('dangerouslyAllowUnauthenticatedServer'))).toBe(true);
  });

  it('says that an account with no owner does not start', async () => {
    const lines = await runFinalizeChecks({ cfg: cfg({ owners: [] }), accountId: 'default', password: 'hunter22' });
    expect(lines).toContain('Owners: none listed. The account does not start until channels.oscar.owners names at least one screen name.');
    expect(lines.some((l) => l.includes('agrees on who the owners are'))).toBe(false);
  });

  it('skips the login when the password is a secret reference, and still checks owners and tools', async () => {
    const lines = await runFinalizeChecks({ cfg: cfg({}, { tools: { profile: 'coding' }, commands: { ownerAllowFrom: ['*'] } }), accountId: 'default' });
    expect(lines[0]).toContain('Login check skipped');
    expect(lines.some((l) => l.startsWith('Owners: ') && l.includes('"*"'))).toBe(true);
    expect(lines.some((l) => l.startsWith('Tools: ') && l.includes(TOOLS_ALSO_ALLOW_LINE))).toBe(true);
  });
});

describe('wizard', () => {
  it('asks in the spec order and writes everything', async () => {
    const p = prompter({ text: ['oscar.example.net', '=', 'Bot One', 'Alice B, alice', '=', '=', 'Bot One, bottwo', 'helper'], confirm: [false] });
    const wiz = oscarSetupWizard;
    const prepared = await wiz.prepare?.({ cfg: {} as never, accountId: 'default', credentialValues: {}, runtime: {} as never, prompter: p.api as never });
    const cred = wiz.credentials[0];
    const withPw = await cred?.applySet?.({ cfg: (prepared as { cfg: never }).cfg, accountId: 'default', credentialValues: {}, value: 'hunter22', resolvedValue: 'hunter22' });
    const done = await wiz.finalize?.({ cfg: withPw as never, accountId: 'default', credentialValues: { password: 'hunter22' }, runtime: {} as never, prompter: p.api as never, forceAllowFrom: false });
    const cfg = (done as { cfg: Obj }).cfg;
    expect(p.asked.map((m) => m.split(':')[0])).toEqual(['Server host', 'Server port', 'Use TLS', 'Screen name', 'Owners', 'Approved people', 'Home room name (blank for none)', 'Chain of command', 'Agent id to bind this account to (blank keeps the default agent)']);
    expect(sectionOf(cfg)).toMatchObject({
      enabled: true, host: 'oscar.example.net', port: 5190, tls: false, screenName: 'Bot One', password: 'hunter22',
      owners: ['aliceb', 'alice'], allowFrom: ['aliceb', 'alice'],
      chain: { roster: [{ screenName: 'botone', role: '', aliases: [] }, { screenName: 'bottwo', role: '', aliases: [] }] },
    });
    expect((sectionOf(cfg).room as { name: string }).name).toMatch(/^aliceb[a-z2-7]{4}$/);
    expect(cfg.commands).toEqual({ ownerAllowFrom: ['oscar:aliceb', 'oscar:alice'] });
    expect(cfg.bindings).toEqual([{ agentId: 'helper', match: { channel: 'oscar', accountId: 'default' } }]);
    expect(p.notes.join('\n')).toContain('Login: ok.');
    expect(configProblems(cfg)).toEqual([]);
  });

  it('needs at least one owner and a roster that contains this bot', async () => {
    const base = { channels: { oscar: { host: 'h', screenName: 'botone', password: 'hunter22' } } };
    const noOwner = prompter({ text: ['', '', '', '', ''], confirm: [] });
    await expect(oscarSetupWizard.finalize?.({ cfg: base as never, accountId: 'default', credentialValues: {}, runtime: {} as never, prompter: noOwner.api as never, forceAllowFrom: false })).rejects.toThrow('at least one');
    const badRoster = prompter({ text: ['alice', '=', '', 'bottwo, botthree', ''], confirm: [] });
    await expect(oscarSetupWizard.finalize?.({ cfg: base as never, accountId: 'default', credentialValues: {}, runtime: {} as never, prompter: badRoster.api as never, forceAllowFrom: false })).rejects.toThrow('botone');
  });

  it('reports configured state and the current password', () => {
    const cfg = { channels: { oscar: { host: 'h', screenName: 'botone', password: 'hunter22' } } };
    expect(oscarSetupWizard.status.resolveConfigured({ cfg: cfg as never, accountId: 'default' })).toBe(true);
    expect(oscarSetupWizard.status.resolveConfigured({ cfg: {} as never })).toBe(false);
    expect(oscarSetupWizard.credentials[0]?.inspect({ cfg: cfg as never, accountId: 'default' })).toEqual({ accountConfigured: true, hasConfiguredValue: true, resolvedValue: 'hunter22' });
    expect(oscarSetupWizard.credentials[0]?.allowEnv?.({ cfg: cfg as never, accountId: 'default' })).toBe(false);
  });
});
