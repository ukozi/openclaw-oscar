import { richTextToAimHtml } from 'open-oscar-client-kit/client';
import { ROOM_SERVER_SENDER, htmlToText, normalizeScreenName } from 'open-oscar-client-kit/wire';
import type {
  DirectImOffer,
  DirectMessage,
  FileOfferNotice,
  IncomingIm,
  Invite,
  MessageWire,
  RichText,
  RoomMessage,
  TransferStatus,
} from 'open-oscar-client-kit/model';
import type {
  DirectImOfferEvent,
  DirectMessageEvent,
  FileOfferEvent,
  ImEvent,
  InviteEvent,
  RoomMessageEvent,
  RoomRef,
  TransferEvent,
} from './types.js';

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

// The client gives the server's rewrite of a sent line as the send's result, not as a line.
export function toRewrittenLine(room: RoomRef, id: string, body: RichText): RoomMessageEvent {
  return {
    room,
    from: ROOM_SERVER_SENDER,
    fromDisplay: 'OnlineHost',
    text: body.map((run) => run.text).join(''),
    cookie: BigInt(`0x${id}`),
    whisper: false,
    serverGenerated: true,
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

export function toDirectImOfferEvent(offer: DirectImOffer): DirectImOfferEvent {
  return { id: offer.id, from: normalizeScreenName(offer.from), fromDisplay: offer.from };
}

// As in an IM, the runs of one link count as one link.
function plain(body: RichText): string {
  const runs: RichText = [];
  for (const { text, link } of body) {
    const last = runs.at(-1);
    if (last !== undefined && last.link === link) last.text += text;
    else runs.push(link === undefined ? { text } : { text, link });
  }
  return htmlToText(richTextToAimHtml(runs));
}

export function toDirectMessageEvent(message: DirectMessage): DirectMessageEvent {
  return {
    id: message.id,
    from: normalizeScreenName(message.from),
    fromDisplay: message.from,
    text: message.parts.map((part) => (part.kind === 'text' ? plain(part.body) : '')).join(''),
    autoResponse: message.autoResponse,
    damaged: message.damaged,
    pictures: message.attachments.map((a) => ({ name: a.name, bytes: a.bytes })),
  };
}

export function toFileOfferEvent(offer: FileOfferNotice): FileOfferEvent {
  return {
    id: offer.id,
    from: normalizeScreenName(offer.from),
    fromDisplay: offer.from,
    count: offer.count,
    totalBytes: offer.totalBytes,
    name: offer.name,
    folder: offer.folder !== null,
  };
}

export function toTransferEvent(status: TransferStatus): TransferEvent {
  return {
    id: status.id,
    peer: normalizeScreenName(status.peer),
    direction: status.direction,
    state: status.state,
    ...(status.failure === undefined ? {} : { failure: status.failure }),
    ...(status.by === undefined ? {} : { by: status.by }),
    index: status.index,
    bytesDone: status.bytesDone,
  };
}
