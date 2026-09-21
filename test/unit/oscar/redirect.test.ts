import { describe, expect, it } from 'vitest';
import { decideRedirect, isLoopbackHost, isUnroutableHost, parseHostPort, resolveRedirect } from '../../../src/oscar/connection.js';

describe('parseHostPort', () => {
  const rows: [string, string, number][] = [
    ['oscar.example.net:5190', 'oscar.example.net', 5190],
    ['127.0.0.1:5191', '127.0.0.1', 5191],
    ['oscar.example.net', 'oscar.example.net', 5190],
    ['[::1]:5193', '::1', 5193],
    ['[2001:db8::1]', '2001:db8::1', 5190],
    ['2001:db8::1', '2001:db8::1', 5190],
    ['host:notaport', 'host', 5190],
    ['host:0', 'host', 5190],
    [' host:7 ', 'host', 7],
    [':0', '', 5190],
  ];
  it.each(rows)('%s', (raw, host, port) => {
    expect(parseHostPort(raw, 5190)).toEqual({ host, port });
  });
});

describe('isUnroutableHost', () => {
  const rows: [string, boolean][] = [
    ['127.0.0.1', true],
    ['127.8.9.10', true],
    ['0.0.0.0', true],
    ['169.254.10.1', true],
    ['localhost', true],
    ['LOCALHOST', true],
    ['box.localhost', true],
    ['::1', true],
    ['[::1]', true],
    ['::', true],
    ['fe80::1', true],
    ['', true],
    ['oscar.example.net', false],
    ['10.0.0.5', false],
    ['192.168.1.20', false],
    ['203.0.113.9', false],
    ['2001:db8::1', false],
  ];
  it.each(rows)('%s -> %s', (host, want) => {
    expect(isUnroutableHost(host)).toBe(want);
  });
});

describe('isLoopbackHost', () => {
  const rows: [string, boolean][] = [
    ['127.0.0.1', true],
    ['127.8.9.10', true],
    ['localhost', true],
    ['LOCALHOST', true],
    ['dev.localhost', true],
    ['::1', true],
    ['[::1]', true],
    ['0.0.0.0', false],
    ['169.254.10.1', false],
    ['::', false],
    ['', false],
    ['oscar.example.net', false],
    ['10.1.2.3', false],
  ];
  it.each(rows)('%s -> %s', (host, want) => {
    expect(isLoopbackHost(host)).toBe(want);
  });
});

describe('decideRedirect', () => {
  const plain = { host: 'oscar.example.net', port: 5190, tls: false };
  const secure = { host: 'oscar.example.net', port: 5193, tls: true };
  const rows: [string, 'auto' | 'follow' | 'pin', typeof plain, { host: string; port: number; ssl: boolean }, string, boolean][] = [
    ['auto follows a routable address', 'auto', plain, { host: 'bos.example.net', port: 5191, ssl: false }, 'bos.example.net:5191', false],
    ['auto pins the default loopback advertisement', 'auto', plain, { host: '127.0.0.1', port: 5190, ssl: false }, 'oscar.example.net:5190', true],
    ['auto pins 0.0.0.0', 'auto', plain, { host: '0.0.0.0', port: 5190, ssl: false }, 'oscar.example.net:5190', true],
    ['auto pins 0.0.0.0 even when the configured host is loopback', 'auto', { host: 'localhost', port: 5190, tls: false }, { host: '0.0.0.0', port: 6000, ssl: false }, 'localhost:5190', true],
    ['auto pins a link-local address even when the configured host is loopback', 'auto', { host: '127.0.0.1', port: 5190, tls: false }, { host: '169.254.10.1', port: 6000, ssl: false }, '127.0.0.1:5190', true],
    ['auto pins a loopback answer when the configured host is a private address', 'auto', { host: '10.1.2.3', port: 5190, tls: false }, { host: '127.0.0.1', port: 5190, ssl: false }, '10.1.2.3:5190', true],
    ['auto pins when TLS is on and the server says plaintext', 'auto', secure, { host: 'bos.example.net', port: 5190, ssl: false }, 'oscar.example.net:5193', true],
    ['auto follows an SSL redirect under TLS', 'auto', secure, { host: 'bos.example.net', port: 5193, ssl: true }, 'bos.example.net:5193', false],
    ['auto follows loopback when the configured host is loopback too', 'auto', { host: 'localhost', port: 5190, tls: false }, { host: '127.0.0.1', port: 6000, ssl: false }, '127.0.0.1:6000', false],
    ['follow takes a loopback address as given', 'follow', plain, { host: '127.0.0.1', port: 5190, ssl: false }, '127.0.0.1:5190', false],
    ['follow takes an SSL answer under TLS as given', 'follow', secure, { host: 'bos.example.net', port: 5193, ssl: true }, 'bos.example.net:5193', false],
    ['follow pins an address it cannot parse', 'follow', plain, { host: '', port: 5190, ssl: false }, 'oscar.example.net:5190', true],
    ['follow pins a bad port', 'follow', plain, { host: 'bos.example.net', port: 0, ssl: false }, 'oscar.example.net:5190', true],
    ['pin ignores everything', 'pin', plain, { host: 'bos.example.net', port: 5191, ssl: true }, 'oscar.example.net:5190', true],
  ];
  it.each(rows)('%s', (_name, mode, configured, advertised, want, pinned) => {
    const got = decideRedirect(mode, configured, advertised);
    expect(`${got.host}:${got.port}`).toBe(want);
    expect(got.pinned).toBe(pinned);
    expect(got.refused).toBeUndefined();
  });

  it('follow under TLS refuses a plaintext answer instead of dialling it', () => {
    const got = decideRedirect('follow', secure, { host: 'bos.example.net', port: 5190, ssl: false });
    expect(got).toEqual({ host: 'bos.example.net', port: 5190, pinned: false, refused: 'tls' });
    expect(decideRedirect('follow', plain, { host: 'bos.example.net', port: 5190, ssl: false }).refused).toBeUndefined();
    expect(decideRedirect('pin', secure, { host: 'bos.example.net', port: 5190, ssl: false }).refused).toBeUndefined();
  });

  it('says why it pinned', () => {
    expect(decideRedirect('auto', plain, { host: '127.0.0.1', port: 5190, ssl: false }).why).toBe('loopback');
    expect(decideRedirect('auto', plain, { host: '0.0.0.0', port: 5190, ssl: false }).why).toBe('unroutable');
    expect(decideRedirect('auto', secure, { host: 'bos.example.net', port: 5190, ssl: false }).why).toBe('tls-mismatch');
    expect(decideRedirect('follow', plain, { host: '', port: 5190, ssl: false }).why).toBe('malformed');
    expect(decideRedirect('pin', plain, { host: 'bos.example.net', port: 5191, ssl: false }).why).toBe('mode');
  });
});

describe('resolveRedirect, the string form service redirects use', () => {
  const cfg = (tls: boolean, redirect: 'auto' | 'follow' | 'pin') => ({ host: 'oscar.example.net', port: 5190, tls, redirect });
  const rows: [string, string, number, boolean, 'auto' | 'follow' | 'pin', { host: string; port: number }][] = [
    ['follows a routable host', 'chat.example.net:5191', 0, false, 'auto', { host: 'chat.example.net', port: 5191 }],
    ['pins a loopback redirect', '127.0.0.1:5190', 0, false, 'auto', { host: 'oscar.example.net', port: 5190 }],
    ['pins under TLS when the server says no SSL', 'chat.example.net:5191', 0, true, 'auto', { host: 'oscar.example.net', port: 5190 }],
    ['follows under TLS when the server says SSL', 'chat.example.net:5193', 2, true, 'auto', { host: 'chat.example.net', port: 5193 }],
    ['pins when told to', 'chat.example.net:5191', 0, false, 'pin', { host: 'oscar.example.net', port: 5190 }],
    ['uses the configured port when the address has none', 'chat.example.net', 0, false, 'follow', { host: 'chat.example.net', port: 5190 }],
    ['pins an address it cannot read', ':0', 0, false, 'follow', { host: 'oscar.example.net', port: 5190 }],
  ];
  it.each(rows)('%s', (_name, advertised, sslState, tls, redirect, want) => {
    expect(resolveRedirect(advertised, sslState, cfg(tls, redirect))).toMatchObject(want);
  });

  it('reports a plaintext answer under follow with TLS as refused', () => {
    expect(resolveRedirect('chat.example.net:5191', 0, cfg(true, 'follow'))).toMatchObject({ pinned: false, refused: 'tls' });
  });
});
