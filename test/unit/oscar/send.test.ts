import { describe, expect, it } from 'vitest';
import { OscarError, RoomJoinError } from 'open-oscar-client-kit/client';
import type { LocalRefusal } from 'open-oscar-client-kit/model';
import { ManualTimers } from 'open-oscar-client-kit/testing';
import { SendQueue, Typing, sendWithResend, toRoomError, toSendError } from '../../../src/oscar/send.js';
import { OscarRoomError, OscarSendError } from '../../../src/oscar/types.js';
import type { SendReceipt } from '../../../src/oscar/types.js';
import { StubClient } from '../../fake/stub-client.js';

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const timeout = (): OscarError => new OscarError({ kind: 'timeout', rateLimited: false });
const lost = (): OscarError => new OscarError({ kind: 'connection-lost' });
const local = (code: LocalRefusal): OscarError => new OscarError({ kind: 'local', code });

async function codeOf(promise: Promise<unknown>): Promise<unknown> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OscarSendError);
  return (error as OscarSendError).code;
}

describe('sendWithResend', () => {
  it('returns the receipt of an acknowledged send and sends once', async () => {
    const client = new StubClient();
    client.script('sendIm', { resolve: { id: '00000000000000aa', stored: true } });
    expect(await sendWithResend(client, 'alice', '<b>hi</b>', false)).toEqual({ id: '00000000000000aa', storedOffline: true });
    expect(client.callsTo('sendIm')).toHaveLength(1);
  });

  it('passes the HTML, the automatic flag and the when-offline store rule', async () => {
    const client = new StubClient();
    await sendWithResend(client, 'Alice B', '<b>hi</b>', true);
    await sendWithResend(client, 'bob', 'yo', false);
    expect(client.callsTo('sendIm')).toEqual([
      ['Alice B', { html: '<b>hi</b>' }, { automatic: true, store: 'when-offline' }],
      ['bob', { html: 'yo' }, { automatic: false, store: 'when-offline' }],
    ]);
  });

  it('sends once more after a timeout and returns the second receipt', async () => {
    const client = new StubClient();
    client.script('sendIm', { reject: timeout() }, { resolve: { id: '00000000000000bb', stored: false } });
    expect(await sendWithResend(client, 'alice', 'hi', false)).toEqual({ id: '00000000000000bb', storedOffline: false });
    const calls = client.callsTo('sendIm');
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
  });

  it('fails rate-limited when the second copy times out too, after exactly two sends', async () => {
    const client = new StubClient();
    client.script('sendIm', { reject: timeout() }, { reject: timeout() }, { resolve: { id: '00000000000000cc', stored: false } });
    expect(await codeOf(sendWithResend(client, 'alice', 'hi', false))).toBe('rate-limited');
    expect(client.callsTo('sendIm')).toHaveLength(2);
  });

  it('fails closed, with one send, when the client went offline after the timeout', async () => {
    const client = new StubClient();
    client.script('sendIm', 'hold');
    const sending = sendWithResend(client, 'alice', 'hi', false);
    client.state = 'reconnecting';
    client.held[0]?.reject(timeout());
    expect(await codeOf(sending)).toBe('closed');
    expect(client.callsTo('sendIm')).toHaveLength(1);
  });

  it.each([
    ['refused', new OscarError({ kind: 'refused', code: 4 }), 'recipient-unavailable'],
    ['connection-lost', lost(), 'closed'],
    ['connection-lost after the send', new OscarError({ kind: 'connection-lost' }, { sent: true }), 'closed'],
    ['too-long', local('message-too-long'), 'too-long'],
    ['not-signed-on', new OscarError({ kind: 'not-signed-on' }), 'not-online'],
    ['rate-held', local('rate-held'), 'rate-limited'],
  ])('does not resend after %s', async (_name, error, code) => {
    const client = new StubClient();
    client.script('sendIm', { reject: error });
    expect(await codeOf(sendWithResend(client, 'alice', 'hi', false))).toBe(code);
    expect(client.callsTo('sendIm')).toHaveLength(1);
  });

  it('maps a failure of the second copy that is not a timeout', async () => {
    const client = new StubClient();
    client.script('sendIm', { reject: timeout() }, { reject: lost() });
    expect(await codeOf(sendWithResend(client, 'alice', 'hi', false))).toBe('closed');
    expect(client.callsTo('sendIm')).toHaveLength(2);
  });
});

describe('SendQueue', () => {
  const receipt = (id: string): SendReceipt => ({ id, storedOffline: false });

  function gate(): { open: () => void; wait: Promise<void> } {
    let open = (): void => {};
    const wait = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { open, wait };
  }

  it('runs reply before control before notice, one at a time', async () => {
    const queue = new SendQueue();
    const order: string[] = [];
    let running = 0;
    let most = 0;
    const first = gate();
    const job = (name: string, wait?: Promise<void>) => async (): Promise<SendReceipt> => {
      running += 1;
      most = Math.max(most, running);
      order.push(name);
      await (wait ?? settle());
      running -= 1;
      return receipt(name);
    };
    const all = [
      queue.push('notice', job('head', first.wait)),
      queue.push('notice', job('notice')),
      queue.push('control', job('control')),
      queue.push('reply', job('reply-1')),
      queue.push('reply', job('reply-2')),
    ];
    await settle();
    expect(order).toEqual(['head']);
    first.open();
    expect((await Promise.all(all)).map((r) => r.id)).toEqual(['head', 'notice', 'control', 'reply-1', 'reply-2']);
    expect(order).toEqual(['head', 'reply-1', 'reply-2', 'control', 'notice']);
    expect(most).toBe(1);
  });

  it('holds the lane behind a send that is waiting to resend', async () => {
    const queue = new SendQueue();
    const client = new StubClient();
    client.script('sendIm', { reject: timeout() }, 'hold');
    const first = queue.push('reply', () => sendWithResend(client, 'alice', 'one', false));
    const second = queue.push('reply', () => sendWithResend(client, 'bob', 'two', false));
    await settle();
    expect(client.callsTo('sendIm').map((c) => c[0])).toEqual(['alice', 'alice']);
    client.held[0]?.resolve({ id: '00000000000000dd', stored: false });
    expect((await first).id).toBe('00000000000000dd');
    await second;
    expect(client.callsTo('sendIm').map((c) => c[0])).toEqual(['alice', 'alice', 'bob']);
  });

  it('runs the next job after one that failed', async () => {
    const queue = new SendQueue();
    const failed = queue.push('reply', () => Promise.reject(new OscarSendError('closed')));
    const next = queue.push('reply', async () => receipt('next'));
    expect(await codeOf(failed)).toBe('closed');
    expect((await next).id).toBe('next');
  });

  it('failAll rejects what waits and not what runs', async () => {
    const queue = new SendQueue();
    const head = gate();
    const started: string[] = [];
    const running = queue.push('reply', async () => {
      started.push('running');
      await head.wait;
      return receipt('running');
    });
    const waiting = queue.push('control', async () => {
      started.push('waiting');
      return receipt('waiting');
    });
    await settle();
    queue.failAll(new OscarSendError('closed'));
    expect(await codeOf(waiting)).toBe('closed');
    head.open();
    expect((await running).id).toBe('running');
    expect(started).toEqual(['running']);
  });
});

describe('toSendError and toRoomError', () => {
  it.each([
    ['not-signed-on', new OscarError({ kind: 'not-signed-on' }), 'not-online', 'not-online'],
    ['connection-lost', lost(), 'closed', 'closed'],
    ['connection-lost after the send', new OscarError({ kind: 'connection-lost' }, { sent: true }), 'closed', 'closed'],
    ['timeout', timeout(), 'rate-limited', 'rate-limited'],
    ['refused 0x04', new OscarError({ kind: 'refused', code: 0x04 }), 'recipient-unavailable', 'send refused (0x4)'],
    ['refused 0x1f', new OscarError({ kind: 'refused', code: 0x1f }), 'recipient-unavailable', 'send refused (0x1f)'],
    ['message-too-long', local('message-too-long'), 'too-long', 'too-long'],
    ['text-too-long', local('text-too-long'), 'too-long', 'too-long'],
    ['invalid-argument', local('invalid-argument'), 'recipient-unavailable', 'bad screen name'],
    ['invalid-screen-name', local('invalid-screen-name'), 'recipient-unavailable', 'bad screen name'],
    ['not-in-room', local('not-in-room'), 'room-not-joined', 'room-not-joined'],
    ['unknown-conversation', local('unknown-conversation'), 'room-not-joined', 'room-not-joined'],
    ['rate-held', local('rate-held'), 'rate-limited', 'rate-limited'],
    ['another local refusal', local('whisper-roll'), 'closed', 'closed'],
    ['an account refusal', new OscarError({ kind: 'account', reason: 'invalid' }), 'closed', 'closed'],
    ['a plain error', new Error('boom'), 'closed', 'closed'],
    ['a value that is no error', 'boom', 'closed', 'closed'],
  ])('send: %s -> %s', (_name, error, code, message) => {
    const mapped = toSendError(error);
    expect(mapped).toBeInstanceOf(OscarSendError);
    expect(mapped.code).toBe(code);
    expect(mapped.message).toBe(message);
  });

  it('send: an OscarSendError is itself', () => {
    const error = new OscarSendError('too-long', 'as it was');
    expect(toSendError(error)).toBe(error);
  });

  it.each([
    ['no-such-room', new RoomJoinError('no-such-room'), 'no-such-room'],
    ['name-too-long', new RoomJoinError('name-too-long'), 'too-long'],
    ['room-limit', new RoomJoinError('room-limit'), 'unavailable'],
    ['invalid-name', new RoomJoinError('invalid-name'), 'unavailable'],
    ['unavailable', new RoomJoinError('unavailable'), 'unavailable'],
    ['not-signed-on', new OscarError({ kind: 'not-signed-on' }), 'not-online'],
    ['connection-lost', lost(), 'unavailable'],
    ['a timeout', timeout(), 'unavailable'],
    ['a plain error', new Error('boom'), 'unavailable'],
    ['a value that is no error', undefined, 'unavailable'],
  ])('room: %s -> %s', (_name, error, code) => {
    const mapped = toRoomError(error);
    expect(mapped).toBeInstanceOf(OscarRoomError);
    expect(mapped.code).toBe(code);
  });

  it('room: an OscarRoomError is itself', () => {
    const error = new OscarRoomError('no-such-room');
    expect(toRoomError(error)).toBe(error);
  });
});

describe('Typing', () => {
  function make(): { client: StubClient; timers: ManualTimers; typing: Typing; flags: { limited: boolean; online: boolean } } {
    const client = new StubClient();
    const timers = new ManualTimers();
    const flags = { limited: false, online: true };
    const typing = new Typing({
      client: () => (flags.online ? client : null),
      limited: () => flags.limited,
      now: timers.now,
      timers: timers.api,
    });
    return { client, timers, typing, flags };
  }
  const events = (client: StubClient): unknown[] => client.callsTo('sendTyping').map((c) => c[1]);

  it('sends none as stopped', () => {
    const { client, timers, typing } = make();
    typing.send('Alice B', 'none');
    typing.send('Alice B', 'typed');
    expect(client.callsTo('sendTyping')).toEqual([
      ['Alice B', 'stopped'],
      ['Alice B', 'typed'],
    ]);
    expect(timers.pending()).toEqual([]);
  });

  it('repeats typing every 8 s and stops at 120 s', async () => {
    const { client, timers, typing } = make();
    typing.send('alice', 'typing');
    expect(events(client)).toEqual(['typing']);
    await timers.advance(7_999);
    expect(events(client)).toEqual(['typing']);
    await timers.advance(1);
    expect(events(client)).toEqual(['typing', 'typing']);
    await timers.advance(111_999);
    expect(events(client)).toEqual(Array.from({ length: 15 }, () => 'typing'));
    await timers.advance(1);
    expect(events(client)).toEqual([...Array.from({ length: 15 }, () => 'typing'), 'stopped']);
    expect(timers.pending()).toEqual([]);
    await timers.advance(60_000);
    expect(events(client)).toHaveLength(16);
  });

  it('keeps the 120 s limit when typing is sent again', async () => {
    const { client, timers, typing } = make();
    typing.send('alice', 'typing');
    await timers.advance(100_000);
    typing.send('Alice', 'typing');
    await timers.advance(16_000);
    expect(events(client).at(-1)).toBe('typing');
    await timers.advance(8_000);
    expect(events(client).at(-1)).toBe('stopped');
    expect(timers.pending()).toEqual([]);
  });

  it('ends the keepalive on typed or none, and for every name on clearAll', async () => {
    const { client, timers, typing } = make();
    typing.send('alice', 'typing');
    typing.send('alice', 'none');
    expect(timers.pending()).toEqual([]);
    typing.send('alice', 'typing');
    typing.send('bob', 'typing');
    expect(timers.pending()).toHaveLength(2);
    typing.clearAll();
    expect(timers.pending()).toEqual([]);
    await timers.advance(60_000);
    expect(events(client)).toEqual(['typing', 'stopped', 'typing', 'typing']);
  });

  it('sends nothing while limited', async () => {
    const { client, timers, typing, flags } = make();
    flags.limited = true;
    typing.send('alice', 'typing');
    await timers.advance(8_000);
    expect(events(client)).toEqual([]);
    flags.limited = false;
    await timers.advance(8_000);
    expect(events(client)).toEqual(['typing']);
  });

  it('sends nothing with no client', async () => {
    const { client, timers, typing, flags } = make();
    flags.online = false;
    typing.send('alice', 'typing');
    typing.send('alice', 'none');
    await timers.advance(16_000);
    expect(events(client)).toEqual([]);
    expect(timers.pending()).toEqual([]);
  });

  it('swallows a rejected sendTyping', async () => {
    const { client, timers, typing } = make();
    const unhandled: unknown[] = [];
    const note = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', note);
    try {
      client.script('sendTyping', { reject: new OscarError({ kind: 'not-signed-on' }) }, { reject: lost() });
      expect(() => typing.send('alice', 'typing')).not.toThrow();
      await timers.advance(8_000);
      await settle();
      expect(events(client)).toEqual(['typing', 'typing']);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', note);
    }
  });

  it('swallows a sendTyping that throws', () => {
    const { client, typing } = make();
    client.sendTyping = () => {
      throw new Error('boom');
    };
    expect(() => typing.send('alice', 'typing')).not.toThrow();
  });
});
