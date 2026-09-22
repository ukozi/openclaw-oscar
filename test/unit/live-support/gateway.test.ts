import { afterEach, describe, expect, it } from 'vitest';
import { copy } from '../../../src/copy.js';
import { FakeOscarServer } from '../../fake/oscar-server.js';
import { gatewayConfig } from '../../live/support/config.js';
import { bootGateway, type LiveGateway } from '../../live/support/gateway.js';
import { until } from '../../live/support/wait.js';

const PEOPLE = ['alice', 'bob', 'mallory'];
const known = new Set<string>();
let server: FakeOscarServer | undefined;
const gateways: LiveGateway[] = [];

afterEach(async () => {
  while (gateways.length > 0) await gateways.pop()?.stop();
  await server?.stop();
  server = undefined;
  known.clear();
});

async function boot(s: FakeOscarServer, accounts: Record<string, string>): Promise<LiveGateway> {
  for (const [name, password] of [...Object.entries(accounts), ...PEOPLE.map((n) => [n, `pw-${n}`] as const)]) {
    if (known.has(name)) continue;
    known.add(name);
    s.addUser(name, password);
  }
  const gateway = await bootGateway({
    cfg: gatewayConfig({
      target: { host: '127.0.0.1', port: s.port, tls: false }, redirect: 'pin',
      accounts, owners: ['alice'], allowFrom: ['alice', 'bob'],
    }),
    imDebounceMs: 30,
  });
  gateways.push(gateway);
  await gateway.start();
  return gateway;
}

describe('gateway driver', () => {
  it('runs the whole plugin: an owner IM becomes one scripted run and one reply', async () => {
    server = await FakeOscarServer.start();
    const gateway = await boot(server, { botone: 'botonepass' });
    gateway.setAgent(async (turn, agent) => agent.reply(`you said: ${turn.body}`));
    const alice = server.peer('alice');
    alice.sendIm('botone', 'hello there');
    await until(() => alice.ims().some((m) => m.text.includes('you said: hello there')), { timeoutMs: 15_000, what: 'the scripted reply' });

    const [run] = gateway.runs('botone');
    expect(gateway.runs()).toHaveLength(1);
    expect(run?.from).toBe('alice');
    expect(run?.commandAuthorized).toBe(true);
    expect(run?.toolDeny).toEqual([]);
    expect(run?.sessionKey).toContain('oscar:group:botone/alice');
    expect(run?.endedAt).not.toBeNull();
  }, 30_000);

  it('gives an approved person the non-owner tool ceiling', async () => {
    server = await FakeOscarServer.start();
    const gateway = await boot(server, { botone: 'botonepass' });
    const bob = server.peer('bob');
    bob.sendIm('botone', 'hi');
    await until(() => gateway.runs('botone').length === 1, { timeoutMs: 15_000, what: "bob's run" });
    expect(gateway.runs('botone')[0]?.commandAuthorized).toBe(false);
    expect(gateway.runs('botone')[0]?.toolDeny).toContain('group:runtime');
  }, 30_000);

  it('starts no run for a stranger', async () => {
    server = await FakeOscarServer.start();
    const gateway = await boot(server, { botone: 'botonepass' });
    const alice = server.peer('alice');
    const mallory = server.peer('mallory');
    mallory.sendIm('botone', 'psst');
    // the owner notice is the last thing the stranger path does, so once it is there the path has run
    await until(() => alice.ims().some((m) => m.text.includes(copy.noticeIm('mallory'))), { timeoutMs: 15_000, what: 'the owner notice' });
    expect(gateway.runs()).toEqual([]);
    expect(mallory.ims()).toEqual([]);
  }, 30_000);

  it('reads status issues through the snapshot the plugin builds', async () => {
    server = await FakeOscarServer.start();
    const gateway = await boot(server, { botone: 'botonepass' });
    expect((await gateway.issues('botone')).some((i) => i.includes('home room unset'))).toBe(true);
  }, 30_000);

  it('registers the three tools and lets a run call one', async () => {
    server = await FakeOscarServer.start();
    const gateway = await boot(server, { botone: 'botonepass' });
    expect(gateway.toolNames()).toEqual(['oscar_delegate', 'oscar_room', 'oscar_status']);
    let outcome = { ok: false, text: '' };
    gateway.setAgent(async (_turn, agent) => {
      outcome = await agent.tool('oscar_delegate', { to: 'bottwo', task: 'anything' });
    });
    server.peer('alice').sendIm('botone', 'hand this over');
    await until(() => gateway.runs().length === 1 && gateway.runs()[0]?.endedAt !== null, { timeoutMs: 15_000, what: 'the run to end' });
    expect(outcome.ok).toBe(false);
    expect(outcome.text).toContain('only work in a room');
  }, 30_000);

  it('refuses an agent send to an unlisted name', async () => {
    server = await FakeOscarServer.start();
    const gateway = await boot(server, { botone: 'botonepass' });
    await until(() => server?.snacsFrom('botone').some((s) => s.conn === 'bos' && s.family === 0x01 && s.subtype === 0x02), { timeoutMs: 15_000, what: 'the bot online' });
    expect((await gateway.agentSend('botone', 'mallory', 'hello')).ok).toBe(false);
    expect((await gateway.agentSend('botone', 'alice', 'hello')).ok).toBe(true);
  }, 30_000);

  it('keeps two gateways apart', async () => {
    server = await FakeOscarServer.start();
    const first = await boot(server, { botone: 'botonepass' });
    const second = await boot(server, { bottwo: 'bottwopass' });
    first.setAgent(async (_turn, agent) => agent.reply('from the first'));
    second.setAgent(async (_turn, agent) => agent.reply('from the second'));
    const alice = server.peer('alice');
    alice.sendIm('bottwo', 'which one are you?');
    await until(() => alice.ims().some((m) => m.text.includes('from the second')), { timeoutMs: 15_000, what: 'the reply from the second gateway' });
    expect(first.runs()).toEqual([]);
    expect(second.runs().map((r) => r.accountId)).toEqual(['bottwo']);
  }, 30_000);
});
