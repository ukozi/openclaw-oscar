import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { FileTransferOptions } from 'open-oscar-client-kit/client';
import type { Logger } from './types.js';

export type HostLookup = (host: string) => Promise<string[]>;
export type DialRule = NonNullable<FileTransferOptions['allowDial']>;

export const systemLookup: HostLookup = async (host) => {
  if (isIP(host) !== 0) return [host];
  return (await lookup(host, { all: true })).map((a) => a.address);
};

const MAPPED = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/;

function canonical(ip: string): string | undefined {
  const family = isIP(ip);
  if (family === 4) return ip;
  if (family !== 6) return undefined;
  let host: string;
  try {
    host = new URL(`http://[${ip}]`).hostname.slice(1, -1);
  } catch {
    return ip.toLowerCase();
  }
  const mapped = MAPPED.exec(host);
  if (!mapped) return host;
  const word = (hex: string | undefined): number => Number.parseInt(hex ?? '0', 16);
  const hi = word(mapped[1]);
  const lo = word(mapped[2]);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

export function makeDialRule(p: { host: string; relayHost?: string; lookup?: HostLookup; log: Logger }): DialRule {
  const find = p.lookup ?? systemLookup;
  const addressesOf = async (host: string): Promise<string[]> => {
    if (isIP(host) !== 0) return [host];
    try {
      return await find(host);
    } catch (err) {
      p.log.warn('dial check could not look up a host', { host, error: err instanceof Error ? err.message : String(err) });
      return [];
    }
  };
  return async (address, context) => {
    const ip = canonical(address.ip);
    if (ip !== undefined) {
      const hosts = new Set([p.host, context.server.host, context.bos.host, ...(p.relayHost === undefined ? [] : [p.relayHost])]);
      const found = await Promise.all([...hosts].map(addressesOf));
      if (found.flat().some((a) => canonical(a) === ip)) return true;
    }
    p.log.warn("refused to dial an address that is not the server's; files need the server's rendezvous relay", {
      ip: address.ip,
      port: address.port,
    });
    return false;
  };
}
