import { resolveStableChannelMessageIngress } from 'openclaw/plugin-sdk/channel-ingress-runtime';
import { describe, expect, it } from 'vitest';
import { readPolicy } from '../../src/config.js';
import { ingressParams } from '../../src/inbound/im.js';

const policy = (sec: Record<string, unknown>) => readPolicy({ channels: { oscar: sec } });

describe('real ingress resolver', () => {
  it('blocks a stranger without asking for pairing', async () => {
    const res = await resolveStableChannelMessageIngress(ingressParams('botone', 'mallory', policy({ owners: ['Alice B'], allowFrom: ['bob'] })));
    expect(res.senderAccess.decision).toBe('block');
    expect(res.ingress.admission).toBe('drop');
    expect(res.ingress.reasonCode).toBe('dm_policy_not_allowlisted');
  });

  it('admits an owner whose config entry has spaces and capitals', async () => {
    const res = await resolveStableChannelMessageIngress(ingressParams('botone', 'aliceb', policy({ owners: ['Alice B'] })));
    expect(res.senderAccess.decision).toBe('allow');
    expect(res.ingress.admission).toBe('dispatch');
  });

  it('admits nobody when disabled and anybody when open', async () => {
    expect((await resolveStableChannelMessageIngress(ingressParams('botone', 'alice', policy({ owners: ['alice'], dmPolicy: 'disabled' })))).senderAccess.decision).toBe('block');
    expect((await resolveStableChannelMessageIngress(ingressParams('botone', 'mallory', policy({ owners: ['alice'], dmPolicy: 'open', dangerouslyAllowOpenDm: true })))).senderAccess.decision).toBe('allow');
  });

  it('agrees with the fake about open without a star', async () => {
    const params = { ...ingressParams('botone', 'mallory', policy({ owners: ['alice'], dmPolicy: 'open', dangerouslyAllowOpenDm: true })), allowFrom: ['alice'] };
    expect((await resolveStableChannelMessageIngress(params)).senderAccess.decision).toBe('block');
  });
});
