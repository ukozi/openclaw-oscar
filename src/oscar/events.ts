import { htmlToText, normalizeScreenName } from 'open-oscar-client-kit/wire';
import type { IncomingIm, Invite, MessageWire, RoomMessage } from 'open-oscar-client-kit/model';
import type { ImEvent, InviteEvent, RoomMessageEvent, RoomRef } from './types.js';

const SYSTEM_SENDER = 'oossystemmsg';

function wireOf<T>(wire: T | undefined): T {
  if (wire === undefined) throw new Error('the client gave no wire detail');
  return wire;
}

const cookieOf = (wire: MessageWire): bigint => BigInt(`0x${wire.cookie}`);

export function toImEvent(im: IncomingIm): ImEvent {
  const wire = wireOf(im.wire);
  const from = normalizeScreenName(im.from);
  const cookie = cookieOf(wire);
  const event: ImEvent = {
    from,
    fromDisplay: im.from,
    text: htmlToText(wire.html),
    cookie,
    autoResponse: im.autoResponse,
    offline: im.offline,
    // the kit's notice test is an empty user-info block and no send time
    system: im.serverNotice && from === SYSTEM_SENDER && cookie === 0n,
  };
  if (im.offline) event.sentAt = im.at;
  return event;
}

export function toRoomMessageEvent(room: RoomRef, message: RoomMessage): RoomMessageEvent {
  const wire = wireOf(message.wire);
  return {
    room,
    from: normalizeScreenName(message.from),
    fromDisplay: message.from,
    text: htmlToText(wire.html),
    cookie: cookieOf(wire),
    whisper: message.whisper,
    serverGenerated: message.fromServer,
  };
}

export function toInviteEvent(invite: Invite): InviteEvent {
  const wire = wireOf(invite.wire);
  return {
    from: normalizeScreenName(invite.from),
    fromDisplay: invite.from,
    room: { exchange: invite.room.exchange, name: invite.room.name.toLowerCase() },
    roomCookie: invite.id,
    text: htmlToText(wire.html),
  };
}
