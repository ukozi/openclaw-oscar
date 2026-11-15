import { OscarClient } from 'open-oscar-client-kit/client';
import type { ReconnectPolicy } from 'open-oscar-client-kit/client';
import { CAP_CHAT } from 'open-oscar-client-kit/wire';
import { CLIENT_ID } from './login.js';
import type { OscarSessionOptions } from './types.js';

export type KitClient = Pick<
  OscarClient,
  | 'state'
  | 'self'
  | 'on'
  | 'signOnWith'
  | 'signOff'
  | 'presenceOf'
  | 'refreshSessionBuddies'
  | 'sendIm'
  | 'sendTyping'
  | 'setAway'
  | 'joinRoom'
  | 'leaveRoom'
  | 'rooms'
  | 'sendRoomMessage'
  | 'forgetInvite'
>;

export function makeKitClient(opts: OscarSessionOptions, hooks: { reconnect: ReconnectPolicy }): KitClient {
  return new OscarClient({
    log: opts.log,
    now: opts.now,
    timers: opts.timers,
    clientId: CLIENT_ID,
    capabilities: [CAP_CHAT],
    tls: opts.tls ? { caFile: opts.caFile } : undefined,
    pinRedirects: opts.redirect === 'pin' ? { host: opts.host, port: opts.port } : undefined,
    followRedirects: opts.redirect === 'follow',
    sessionBuddies: opts.buddies,
    wireDetail: true,
    botFlagExempt: true,
    iconsFrom: 'none',
    // The plugin's own room limit is the one a person meets.
    maxRooms: 10_000,
    autoRespond: () => 'skip',
    reconnect: hooks.reconnect,
    rejoin: { afterReconnect: async () => [], afterRoomClosed: async () => 'stay' },
  });
}
