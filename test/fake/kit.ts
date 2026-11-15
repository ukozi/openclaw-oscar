import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeOscarServer, TEST_TLS_CERT } from 'open-oscar-client-kit/testing';
import type { FakePeer, StartOptions } from 'open-oscar-client-kit/testing';
import {
  FAMILY_ICBM,
  FAMILY_OSERVICE,
  ICBM_CHANNEL_IM,
  ICBM_HOST_ACK,
  ICBM_TLV_IM_DATA,
  ICBM_TLV_STORE,
  OSERVICE_RATE_PARAM_CHANGE,
  RATE_CLASS_IM,
  RATE_CODE_LIMITED,
  decodeImFragments,
  findTlv,
  fromWireText,
  hasTlv,
  htmlToText,
} from 'open-oscar-client-kit/wire';

export type ServerOptions = Omit<StartOptions, 'tls' | 'checkPasswords'> & { disableAuth?: boolean; tls?: boolean };
export type PeerIm = { from: string; text: string; storeTlv: boolean };

const secure = new WeakSet<FakeOscarServer>();
let caPath: string | undefined;

export async function startServer(opts: ServerOptions = {}): Promise<FakeOscarServer> {
  const { disableAuth, tls, ...rest } = opts;
  const server = await FakeOscarServer.start({ ...rest, ...(tls ? { tls: true as const } : {}), checkPasswords: disableAuth !== true });
  if (tls) secure.add(server);
  return server;
}

export function caFile(): string {
  if (caPath === undefined) {
    const dir = mkdtempSync(join(tmpdir(), 'fake-oscar-'));
    process.once('exit', () => rmSync(dir, { recursive: true, force: true }));
    caPath = join(dir, 'ca.pem');
    writeFileSync(caPath, TEST_TLS_CERT);
  }
  return caPath;
}

export function caFileOf(server: FakeOscarServer): string | undefined {
  return secure.has(server) ? caFile() : undefined;
}

export async function restart(server: FakeOscarServer): Promise<void> {
  await server.shutdown();
  await server.resume();
}

export function holdAcks(server: FakeOscarServer): () => void {
  return server.withhold(FAMILY_ICBM, ICBM_HOST_ACK);
}

// A silent limit keeps every rate notice back for the rest of the test.
export function limitBos(server: FakeOscarServer, name: string, opts: { silent?: boolean } = {}): void {
  if (opts.silent) muteRateNotices(server);
  for (let i = 0; i < 40 && server.rateNotices(name).at(-1)?.code !== RATE_CODE_LIMITED; i++) server.spend(name, RATE_CLASS_IM, 1);
  if (server.rateNotices(name).at(-1)?.code !== RATE_CODE_LIMITED) throw new Error(`"${name}" did not reach the limit`);
}

export function clearBos(server: FakeOscarServer, name: string): void {
  server.setRateParams(name, RATE_CLASS_IM, { currentLevel: 6000 });
  server.rateTick(name);
}

// The server's own rate notices stay back, so a test reads only what the session's model reports.
export function muteRateNotices(server: FakeOscarServer): void {
  server.withhold(FAMILY_OSERVICE, OSERVICE_RATE_PARAM_CHANGE);
}

// The fake counts a bot account's sends; the real server does not.
export function liftImLimit(server: FakeOscarServer, name: string): void {
  server.setRateParams(name, RATE_CLASS_IM, { clearLevel: 0, alertLevel: 0, limitLevel: 0, disconnectLevel: 0 });
}

const escapeText = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<BR>');

// Live deliveries first, then what the server holds for the name when a server is given.
export function imTexts(peer: FakePeer, server?: FakeOscarServer): PeerIm[] {
  const live = peer.ims().map((m) => ({ from: m.from, text: htmlToText(m.html), storeTlv: hasTlv(m.tlvs, ICBM_TLV_STORE) }));
  const stored = (server?.storedFor(peer.name) ?? [])
    .filter((m) => m.channel === ICBM_CHANNEL_IM)
    .map((m) => ({
      from: m.sender,
      text: decodeImFragments(findTlv(m.tlvs, ICBM_TLV_IM_DATA) ?? new Uint8Array(0)).map((f) => fromWireText(f.text, f.charset)).join(''),
      storeTlv: hasTlv(m.tlvs, ICBM_TLV_STORE),
    }));
  return [...live, ...stored];
}

export function storeOfflineIm(server: FakeOscarServer, to: string, from: string, text: string, ageSeconds: number): void {
  server.storeOffline(to, from, escapeText(text), Math.floor(Date.now() / 1000) - ageSeconds);
}
