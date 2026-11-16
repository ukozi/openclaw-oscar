import { OscarClient } from 'open-oscar-client-kit/client';
import type { OscarClientOptions, ReconnectPolicy } from 'open-oscar-client-kit/client';
import { CAP_CHAT } from 'open-oscar-client-kit/wire';
import { makeDialRule } from './dial.js';
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
  | 'acceptDirectIm'
  | 'declineDirectIm'
  | 'closeDirectIm'
  | 'acceptFileOffer'
  | 'declineFileOffer'
  | 'cancelTransfer'
  | 'sendFiles'
  | 'openDirectIm'
  | 'sendDirectMessage'
>;

// Room for the text and the frame around the pictures of one message.
const DIRECT_IM_SPARE_BYTES = 256 * 1024;

// The idle close bounds a session; the total only stops one that never pauses.
const DIRECT_IM_SESSION_MESSAGES = 100;

export function directImLimits(maxBytes: number): { maxMessageBytes: number; maxSessionBytes: number } {
  const maxMessageBytes = maxBytes + DIRECT_IM_SPARE_BYTES;
  return { maxMessageBytes, maxSessionBytes: DIRECT_IM_SESSION_MESSAGES * maxMessageBytes };
}

export function kitOptions(opts: OscarSessionOptions, hooks: { reconnect: ReconnectPolicy }): OscarClientOptions {
  const t = opts.transfers;
  const dial = (): OscarClientOptions => {
    if (!t?.directIm && !t?.sendFile) return {};
    const allowDial = makeDialRule({
      host: opts.host,
      log: opts.log,
      ...(t.relayHost === undefined ? {} : { relayHost: t.relayHost }),
      ...(t.lookup === undefined ? {} : { lookup: t.lookup }),
    });
    return {
      ...(t.directIm ? { directIm: { allowDial, ...directImLimits(t.maxBytes) } } : {}),
      ...(t.sendFile ? { fileTransfer: { allowDial } } : {}),
    };
  };
  return {
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
    ...dial(),
  };
}

export function makeKitClient(opts: OscarSessionOptions, hooks: { reconnect: ReconnectPolicy }): KitClient {
  return new OscarClient(kitOptions(opts, hooks));
}
