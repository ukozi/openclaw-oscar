import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('openclaw/plugin-sdk/status-helpers', async () => (await import('../fake/openclaw.js')).statusHelpers);

import { resolveAccount } from '../../src/config.js';
import { resetRuntimeForTests, setRuntime } from '../../src/runtime.js';
import { TOOLS_ALSO_ALLOW_LINE, boundAgentId, collectOscarIssues, hiddenTools, hostOwnerListHasStar, isPrivateHost, oscarStatus, ownerIssues } from '../../src/status.js';
import type { IssueInput } from '../../src/status.js';
import { FakeSession } from '../fake/session.js';

type Obj = Record<string, unknown>;
const sec = (patch: Obj = {}): Obj => ({
  host: 'oscar.example.net', tls: true, screenName: 'botone', password: 'hunter22', owners: ['alice'], allowFrom: ['bob'], room: { name: 'testroom' }, ...patch,
});
const host = (patch: Obj = {}, secPatch: Obj = {}): Obj => ({
  tools: { profile: 'full' }, bindings: [{ agentId: 'helper', match: { channel: 'oscar', accountId: 'default' } }], channels: { oscar: sec(secPatch) }, ...patch,
});
const input = (cfg: Obj, patch: Partial<IssueInput> = {}): IssueInput => ({ cfg, account: resolveAccount(cfg), state: { phase: 'online', since: 0, attempts: 0 }, ...patch });
const messages = (i: IssueInput) => collectOscarIssues(i).map((x) => x.message);

beforeEach(() => resetRuntimeForTests());

describe('collectOscarIssues', () => {
  it('is quiet for a healthy, fully configured account', () => {
    expect(collectOscarIssues(input(host()))).toEqual([]);
  });

  it.each([
    ['not configured', host({}, { password: undefined }), {}, 'config', 'not configured', 'openclaw channels add --channel oscar'],
    ['bad password', host(), { state: { phase: 'fatal', reason: 'bad-password', since: 0, attempts: 1 } }, 'auth', 'rejected the password', 'channels.oscar.password'],
    ['unknown name', host(), { state: { phase: 'fatal', reason: 'unknown-name', since: 0, attempts: 1 } }, 'auth', 'does not know the screen name', 'screenName'],
    ['suspended', host(), { state: { phase: 'fatal', reason: 'suspended', since: 0, attempts: 1 } }, 'auth', 'suspended', 'server operator'],
    ['login rate limit', host(), { state: { phase: 'backoff', reason: 'login-rate-limited', since: 0, attempts: 2 } }, 'runtime', 'rate limited at login', 'Wait'],
    ['redirect', host(), { state: { phase: 'fatal', reason: 'redirect-unroutable', detail: 'loopback', since: 0, attempts: 1 } }, 'config', 'redirected to an address this host cannot reach', 'redirect'],
    ['kicked', host(), { state: { phase: 'backoff', reason: 'disconnected-by-server', since: 0, attempts: 1 } }, 'runtime', 'disconnected by server (signed on elsewhere, rate limit or kick)', 'another client'],
    ['md5', host(), { state: { phase: 'fatal', reason: 'md5-unavailable', since: 0, attempts: 1 } }, 'runtime', 'MD5', 'Node'],
    ['tls', host(), { state: { phase: 'backoff', reason: 'tls', detail: 'self signed', since: 0, attempts: 1 } }, 'config', 'TLS failed', 'caFile'],
    ['network', host(), { state: { phase: 'backoff', reason: 'network', since: 0, attempts: 3 } }, 'runtime', 'cannot reach', 'firewall'],
    ['no password check', host(), { probe: 'does-not-check', halted: { reason: 'unauthenticated-server', detail: 'x' } }, 'auth', 'does not check passwords', 'dangerouslyAllowUnauthenticatedServer'],
    ['plaintext', host({}, { tls: false }), {}, 'config', 'plaintext', 'tls'],
    ['room unset', host({}, { room: undefined }), {}, 'config', 'home room unset', 'room.name'],
    ['no owners', host({}, { owners: [] }), {}, 'config', 'no owners', 'channels.oscar.owners'],
    ['owner not an owner to the host', host({ commands: { ownerAllowFrom: ['oscar:carol'] } }, { owners: ['alice', 'carol'] }), {}, 'permissions', 'owner alice is not an owner to OpenClaw on this host', '"oscar:alice"'],
    ['star', host({ commands: { ownerAllowFrom: ['*'] } }), {}, 'permissions', 'contains "*"', 'Remove'],
    ['unprefixed', host({ commands: { ownerAllowFrom: ['alice'] } }), {}, 'permissions', 'without a channel prefix', 'oscar:'],
    ['foreign oscar entry', host({ commands: { ownerAllowFrom: ['oscar:alice', 'oscar:Eve X'] } }), {}, 'permissions', 'names oscar:evex', 'channels.oscar.owners'],
    ['commands widened without an owner list', host({ commands: { allowFrom: { '*': ['*'] }, ownerAllowFrom: ['slack:U1'] } }), {}, 'permissions', 'approved people can run session commands', '"oscar:alice"'],
    ['refused by the session itself', host(), { state: { phase: 'fatal', reason: 'unauthenticated-server', since: 0, attempts: 1 } }, 'auth', 'does not check passwords', 'dangerouslyAllowUnauthenticatedServer'],
    ['no binding', host({ bindings: [] }), {}, 'config', 'has no agent binding', 'bindings'],
    ['hidden tools', host({ tools: { profile: 'coding' } }), {}, 'permissions', 'hidden by the tool profile: message, oscar_status, oscar_room, oscar_delegate', TOOLS_ALSO_ALLOW_LINE],
    ['dropped sends', host(), { counters: { droppedSends: 2, eventGaps: 1 } }, 'runtime', '2 sends were dropped and 1 event gaps', 'bot flag'],
    ['config problem', host({}, { dmPolicy: 'open' }), {}, 'config', 'channels.oscar.dangerouslyAllowOpenDm', 'openclaw.json'],
  ])('%s', (_label, cfg, patch, kind, text, fix) => {
    const found = collectOscarIssues(input(cfg, patch as Partial<IssueInput>)).find((x) => x.message.includes(text));
    expect(found, messages(input(cfg, patch as Partial<IssueInput>)).join(' | ')).toBeDefined();
    expect(found?.kind).toBe(kind);
    expect(found?.fix).toContain(fix);
    expect(found?.fix.length).toBeGreaterThan(10);
  });

  it('marks severities', () => {
    const bySeverity = (cfg: Obj, text: string) => collectOscarIssues(input(cfg)).find((x) => x.message.includes(text))?.severity;
    expect(bySeverity(host({}, { tls: false }), 'plaintext')).toBe('warning');
    expect(bySeverity(host({}, { room: undefined }), 'home room unset')).toBe('info');
    expect(bySeverity(host({ commands: { ownerAllowFrom: ['*'] } }), 'contains "*"')).toBe('error');
  });

  it('reports an empty owner list once, as the reason the account does not run', () => {
    for (const owners of [[], ['*'], undefined]) {
      const found = collectOscarIssues(input(host({}, { owners }))).filter((x) => x.message.startsWith('no owners') || x.message.startsWith('channels.oscar.owners:'));
      expect(found).toEqual([{
        kind: 'config', severity: 'error',
        message: 'no owners: the account does not run, because OpenClaw would treat every approved person as an owner',
        fix: 'Add at least one screen name to channels.oscar.owners, then restart the gateway.',
      }]);
    }
  });

  it('downgrades the password check to a warning when the dangerous flag is set', () => {
    const issue = collectOscarIssues(input(host({}, { dangerouslyAllowUnauthenticatedServer: true }), { probe: 'does-not-check' })).find((x) => x.message.includes('does not check'));
    expect(issue?.severity).toBe('warning');
  });

  it('flags two accounts that share an agent', () => {
    const cfg = host({ bindings: [{ agentId: 'helper', match: { channel: 'oscar', accountId: '*' } }] }, { accounts: { botone: { screenName: 'botone' }, bottwo: { screenName: 'bottwo' } } });
    const issues = collectOscarIssues({ cfg, account: resolveAccount(cfg, 'botone'), state: { phase: 'online', since: 0, attempts: 0 } });
    expect(issues.some((x) => x.message.includes('botone and bottwo both resolve to agent helper'))).toBe(true);
  });

  it('says nothing about plaintext for private hosts', () => {
    for (const h of ['localhost', 'oscar.internal', 'box.local', '10.0.0.5', '192.168.1.9', '172.20.0.2', '127.0.0.1', '::1', 'fd00::1']) {
      expect(isPrivateHost(h), h).toBe(true);
    }
    for (const h of ['oscar.example.net', '172.32.0.1', '8.8.8.8', 'localhost.example.net']) expect(isPrivateHost(h), h).toBe(false);
  });
});

describe('helpers', () => {
  it.each([
    [{}, []],
    [{ tools: { profile: 'full' } }, []],
    [{ tools: { profile: 'coding' } }, ['message', 'oscar_status', 'oscar_room', 'oscar_delegate']],
    [{ tools: { profile: 'messaging' } }, ['oscar_status', 'oscar_room', 'oscar_delegate']],
    [{ tools: { profile: 'coding', alsoAllow: ['message', 'oscar_delegate', 'oscar_status', 'oscar_room'] } }, []],
    [{ tools: { profile: 'coding', alsoAllow: ['group:messaging', 'group:plugins'] } }, []],
    [{ tools: { profile: 'coding', alsoAllow: ['message', 'oscar'] } }, []],
    [{ tools: { allow: ['read'] } }, ['message', 'oscar_status', 'oscar_room', 'oscar_delegate']],
    [{ tools: { profile: 'full' }, agents: { list: [{ id: 'helper', tools: { profile: 'minimal' } }] } }, ['message', 'oscar_status', 'oscar_room', 'oscar_delegate']],
  ])('hiddenTools %j', (cfg, want) => {
    expect(hiddenTools(cfg, 'helper')).toEqual(want);
  });

  it('resolves the bound agent like core does for account matches', () => {
    const cfg = { bindings: [{ agentId: 'a', match: { channel: 'oscar', accountId: 'botone' } }, { agentId: 'b', match: { channel: 'oscar' } }, { agentId: 'c', match: { channel: 'slack', accountId: 'botone' } }], channels: { oscar: sec() } };
    expect(boundAgentId(cfg, 'botone')).toBe('a');
    expect(boundAgentId(cfg, 'default')).toBe('b');
    expect(boundAgentId(cfg, 'bottwo')).toBeUndefined();
  });

  it('sees the star', () => {
    expect(hostOwnerListHasStar({ commands: { ownerAllowFrom: ['oscar:alice', '*'] } })).toBe(true);
    expect(hostOwnerListHasStar({})).toBe(false);
    expect(ownerIssues(host({ commands: { ownerAllowFrom: ['oscar:Alice', 'slack:U123'] } }))).toEqual([]);
    expect(ownerIssues(host({ commands: { allowFrom: { oscar: ['*'] }, ownerAllowFrom: ['oscar:alice'] } }))).toEqual([]);
    expect(ownerIssues(host({ commands: { allowFrom: { slack: ['*'] } } }))).toEqual([]);
  });
});

describe('status adapter', () => {
  it('puts issues on the snapshot and collects them with channel and account', () => {
    const cfg = host({ tools: { profile: 'coding' } });
    const adapter = oscarStatus as unknown as {
      buildAccountSnapshot(p: Obj): Obj;
      collectStatusIssues(a: Obj[]): { channel: string; accountId: string; kind: string; message: string; fix?: string }[];
    };
    const snapshot = adapter.buildAccountSnapshot({ account: resolveAccount(cfg), cfg, runtime: { accountId: 'default', running: true } });
    expect(snapshot).toMatchObject({ accountId: 'default', name: 'botone', enabled: true, configured: true, dmPolicy: 'allowlist' });
    const issues = adapter.collectStatusIssues([snapshot]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ channel: 'oscar', accountId: 'default', kind: 'permissions', fix: TOOLS_ALSO_ALLOW_LINE });
    expect(issues[0]?.message.startsWith('warning: ')).toBe(true);
  });

  it('reads live state from the runtime and probes through the running session', async () => {
    const session = new FakeSession();
    session.setState({ phase: 'fatal', reason: 'bad-password' });
    session.probeResult = 'does-not-check';
    setRuntime({ accountId: 'default', session: session.asSession(), rooms: new Map(), sessionKeys: new Map(), lastReplyAt: new Map(), counters: { droppedSends: 0, eventGaps: 0 } });
    const cfg = host();
    const adapter = oscarStatus as unknown as { buildAccountSnapshot(p: Obj): { oscarIssues: { message: string }[] }; probeAccount(p: Obj): Promise<{ passwordCheck: string }> };
    expect(adapter.buildAccountSnapshot({ account: resolveAccount(cfg), cfg }).oscarIssues.some((x) => x.message.includes('rejected the password'))).toBe(true);
    expect(await adapter.probeAccount({ account: resolveAccount(cfg), cfg, timeoutMs: 1000 })).toEqual({ passwordCheck: 'unknown' });
    session.setState({ phase: 'online' });
    const probe = await adapter.probeAccount({ account: resolveAccount(cfg), cfg, timeoutMs: 1000 });
    expect(probe).toEqual({ passwordCheck: 'does-not-check' });
    expect(adapter.buildAccountSnapshot({ account: resolveAccount(cfg), cfg, probe }).oscarIssues.some((x) => x.message.includes('does not check passwords'))).toBe(true);
  });

  it('answers unknown when the account is not running', async () => {
    const adapter = oscarStatus as unknown as { probeAccount(p: Obj): Promise<{ passwordCheck: string }> };
    expect(await adapter.probeAccount({ account: resolveAccount(host()), cfg: host(), timeoutMs: 1000 })).toEqual({ passwordCheck: 'unknown' });
  });
});
