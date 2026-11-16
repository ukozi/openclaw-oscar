import { describe, expect, it, vi } from 'vitest';
import { makeDialRule, systemLookup } from '../../../src/oscar/dial.js';
import type { HostLookup } from '../../../src/oscar/dial.js';
import type { Logger } from '../../../src/oscar/types.js';

const hosts: Record<string, string[]> = {
  'oscar.example.test': ['192.0.2.10', '2001:db8::10'],
  'bos.example.test': ['192.0.2.20'],
  'relay.example.test': ['198.51.100.5'],
};
const lookup: HostLookup = async (host) => {
  const found = hosts[host];
  if (found === undefined) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
  return found;
};
const quietLog = () => ({ debug() {}, info() {}, warn: vi.fn<Logger['warn']>(), error() {} });
const context = (over: { server?: string; bos?: string } = {}) => ({
  server: { host: over.server ?? 'oscar.example.test', port: 5190 },
  bos: { host: over.bos ?? 'bos.example.test', port: 5191 },
});
const at = (ip: string, port = 4443) => ({ ip, port });

describe('makeDialRule', () => {
  it('allows the address the configured host resolves to', async () => {
    const rule = makeDialRule({ host: 'oscar.example.test', lookup, log: quietLog() });
    const ctx = context({ server: '203.0.113.1', bos: '203.0.113.2' });
    expect(await rule(at('192.0.2.10'), ctx)).toBe(true);
    expect(await rule(at('2001:db8::10'), ctx)).toBe(true);
  });

  it('allows the address the server and BOS hosts of the session resolve to', async () => {
    const rule = makeDialRule({ host: '203.0.113.1', lookup, log: quietLog() });
    expect(await rule(at('192.0.2.10'), context())).toBe(true);
  });

  it('allows the address of the BOS host', async () => {
    const rule = makeDialRule({ host: 'oscar.example.test', lookup, log: quietLog() });
    expect(await rule(at('192.0.2.20'), context())).toBe(true);
    expect(await rule(at('203.0.113.7'), context({ bos: '203.0.113.7' }))).toBe(true);
  });

  it('allows the address of the relay setting', async () => {
    const byName = makeDialRule({ host: 'oscar.example.test', relayHost: 'relay.example.test', lookup, log: quietLog() });
    expect(await byName(at('198.51.100.5'), context())).toBe(true);
    const byAddress = makeDialRule({ host: 'oscar.example.test', relayHost: '198.51.100.9', lookup, log: quietLog() });
    expect(await byAddress(at('198.51.100.9'), context())).toBe(true);
  });

  it('refuses every other address', async () => {
    const rule = makeDialRule({ host: 'oscar.example.test', relayHost: 'relay.example.test', lookup, log: quietLog() });
    for (const ip of ['192.0.2.11', '127.0.0.1', '10.0.0.1', '::1', '2001:db8::11', '0.0.0.0', 'oscar.example.test', '']) {
      expect(await rule(at(ip), context()), ip).toBe(false);
    }
  });

  it('refuses the address of the relay host when no relay is set', async () => {
    const rule = makeDialRule({ host: 'oscar.example.test', lookup, log: quietLog() });
    expect(await rule(at('198.51.100.5'), context())).toBe(false);
  });

  it('refuses when a lookup fails', async () => {
    const failing: HostLookup = async () => {
      throw new Error('getaddrinfo EAI_AGAIN');
    };
    const rule = makeDialRule({ host: 'oscar.example.test', relayHost: 'relay.example.test', lookup: failing, log: quietLog() });
    expect(await rule(at('192.0.2.10'), context())).toBe(false);
    expect(await rule(at('192.0.2.20'), context())).toBe(false);
  });

  it('still allows the other hosts when one lookup fails', async () => {
    const rule = makeDialRule({ host: 'gone.example.test', lookup, log: quietLog() });
    expect(await rule(at('192.0.2.20'), context())).toBe(true);
    expect(await rule(at('203.0.113.1'), context())).toBe(false);
  });

  it('refuses when a lookup throws before it returns a promise', async () => {
    const throwing = ((host: string) => {
      throw new Error(`no ${host}`);
    }) as HostLookup;
    const rule = makeDialRule({ host: 'oscar.example.test', lookup: throwing, log: quietLog() });
    expect(await rule(at('192.0.2.10'), context())).toBe(false);
  });

  it('treats an IPv4-mapped address as its IPv4 form', async () => {
    const rule = makeDialRule({ host: 'oscar.example.test', lookup, log: quietLog() });
    expect(await rule(at('::ffff:192.0.2.10'), context())).toBe(true);
    expect(await rule(at('::FFFF:c000:20a'), context())).toBe(true);
    expect(await rule(at('0:0:0:0:0:ffff:192.0.2.20'), context())).toBe(true);
    expect(await rule(at('::ffff:192.0.2.11'), context())).toBe(false);
    const mappedHost: HostLookup = async () => ['::ffff:192.0.2.30'];
    const fromMapped = makeDialRule({ host: 'mapped.example.test', lookup: mappedHost, log: quietLog() });
    expect(await fromMapped(at('192.0.2.30'), context())).toBe(true);
  });

  it('compares IPv6 addresses in any spelling', async () => {
    const rule = makeDialRule({ host: 'oscar.example.test', lookup, log: quietLog() });
    expect(await rule(at('2001:DB8:0:0:0:0:0:10'), context())).toBe(true);
  });

  it('allows any port on an allowed address', async () => {
    const rule = makeDialRule({ host: 'oscar.example.test', lookup, log: quietLog() });
    for (const port of [1, 5190, 65535]) expect(await rule(at('192.0.2.10', port), context())).toBe(true);
  });

  it('looks the hosts up again at each dial', async () => {
    const seen: string[] = [];
    const counting: HostLookup = async (host) => {
      seen.push(host);
      return lookup(host);
    };
    const rule = makeDialRule({ host: 'oscar.example.test', relayHost: 'relay.example.test', lookup: counting, log: quietLog() });
    await rule(at('192.0.2.10'), context());
    await rule(at('192.0.2.10'), context());
    expect(seen.filter((h) => h === 'oscar.example.test')).toHaveLength(2);
    expect(seen.filter((h) => h === 'relay.example.test')).toHaveLength(2);
  });

  it('logs the refused address', async () => {
    const log = quietLog();
    const rule = makeDialRule({ host: 'oscar.example.test', lookup, log });
    await rule(at('203.0.113.66', 4443), context());
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/relay/), expect.objectContaining({ ip: '203.0.113.66', port: 4443 }));
  });

  it('logs nothing when it allows an address', async () => {
    const log = quietLog();
    const rule = makeDialRule({ host: 'oscar.example.test', lookup, log });
    await rule(at('192.0.2.10'), context());
    expect(log.warn).not.toHaveBeenCalled();
  });
});

describe('systemLookup', () => {
  it('gives an IP literal as itself', async () => {
    expect(await systemLookup('192.0.2.10')).toEqual(['192.0.2.10']);
    expect(await systemLookup('2001:db8::10')).toEqual(['2001:db8::10']);
  });
});
