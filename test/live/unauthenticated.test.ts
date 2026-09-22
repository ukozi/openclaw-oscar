import { afterEach, describe, expect, it } from 'vitest';
import { gatewayConfig } from './support/config.js';
import { liveEnv } from './support/env.js';
import { bootGateway, type LiveGateway } from './support/gateway.js';
import { startSession, type Captured } from './support/session.js';
import { startStack, type Stack } from './support/stack.js';
import { holds, until } from './support/wait.js';

const env = liveEnv();

describe.skipIf(env.mode !== 'local')('a server that does not check passwords', () => {
  let stack: Stack | null = null;
  let gateway: LiveGateway | null = null;
  let session: Captured | null = null;

  afterEach(async () => {
    await gateway?.stop();
    await session?.session.stop();
    await stack?.stop();
    gateway = null;
    session = null;
    stack = null;
  });

  it('is told apart from one that does', async () => {
    if (env.mode !== 'local') return;
    stack = await startStack(env, { disableAuth: true });
    session = await startSession(stack.target, 'botone', 'anything1');
    expect(await session.session.probePasswordCheck()).toBe('does-not-check');
    await session.session.stop();
    await stack.stop();

    stack = await startStack(env);
    await stack.oos.createUser('botone', 'botonepass');
    session = await startSession(stack.target, 'botone', 'botonepass');
    expect(await session.session.probePasswordCheck()).toBe('checks');
  }, 120_000);

  it('is refused by the plugin', async () => {
    if (env.mode !== 'local') return;
    stack = await startStack(env, { disableAuth: true });
    const oos = stack.oos;
    gateway = await bootGateway({
      cfg: gatewayConfig({ target: stack.target, accounts: { botone: 'anything1' }, owners: ['alice'], allowFrom: ['alice'] }),
    });
    await gateway.start();
    const gw = gateway;
    await until(async () => (await gw.issues('botone')).some((i) => /does not check passwords/i.test(i)), { timeoutMs: 120_000, what: 'the status issue' });
    await until(async () => (await oos.session('botone')) === null, { timeoutMs: 30_000, what: 'the account to sign off' });
    await holds(async () => (await oos.session('botone')) === null, { forMs: 15_000, what: 'the account staying off' });
  }, 240_000);

  it('runs there only when told to', async () => {
    if (env.mode !== 'local') return;
    stack = await startStack(env, { disableAuth: true });
    const oos = stack.oos;
    gateway = await bootGateway({
      cfg: gatewayConfig({
        target: stack.target, accounts: { botone: 'anything1' }, owners: ['alice'], allowFrom: ['alice'],
        channel: { dangerouslyAllowUnauthenticatedServer: true },
      }),
    });
    await gateway.start();
    await until(async () => (await oos.session('botone')) !== null, { timeoutMs: 60_000, what: 'the bot to sign on' });
    await holds(async () => (await oos.session('botone')) !== null, { forMs: 20_000, what: 'the bot staying on' });
  }, 180_000);
});
