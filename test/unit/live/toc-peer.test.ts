import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { TocPeer, quote, roast } from '../../live/toc-peer.js';

function frame(type: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(6);
  head.writeUInt8(0x2a, 0);
  head.writeUInt8(type, 1);
  head.writeUInt16BE(0, 2);
  head.writeUInt16BE(payload.length, 4);
  return Buffer.concat([head, payload]);
}

let server: net.Server | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
});

function tocServer(onCommand: (command: string, reply: (line: string) => void) => void): Promise<number> {
  return new Promise((resolve) => {
    server = net.createServer((socket) => {
      let buffer = Buffer.alloc(0);
      let greeted = false;
      socket.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (!greeted) {
          if (buffer.length < 10) return;
          expect(buffer.subarray(0, 10).toString()).toBe('FLAPON\r\n\r\n');
          buffer = buffer.subarray(10);
          greeted = true;
          socket.write(frame(1, Buffer.from([0, 0, 0, 1])));
        }
        while (buffer.length >= 6 && buffer.length >= 6 + buffer.readUInt16BE(4)) {
          const length = buffer.readUInt16BE(4);
          const type = buffer.readUInt8(1);
          const payload = buffer.subarray(6, 6 + length);
          buffer = buffer.subarray(6 + length);
          if (type === 2) onCommand(payload.toString('utf8').replace(/\0+$/, ''), (line) => socket.write(frame(2, Buffer.from(line))));
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server?.address();
      resolve(address && typeof address === 'object' ? address.port : 0);
    });
  });
}

describe('TOC test peer', () => {
  it('roasts a password the documented way', () => {
    expect(roast('password')).toBe('0x2408105c23001130');
  });

  it('quotes and escapes an argument', () => {
    expect(quote('say "hi" (now) $5')).toBe('"say \\"hi\\" \\(now\\) \\$5"');
  });

  it('signs on, joins a room, invites and speaks', async () => {
    const commands: string[] = [];
    let sawFifth: () => void = () => undefined;
    const fifth = new Promise<void>((resolve) => (sawFifth = resolve));
    const port = await tocServer((command, reply) => {
      commands.push(command);
      if (commands.length === 5) sawFifth();
      if (command.startsWith('toc_signon')) reply('SIGN_ON:TOC1.0');
      if (command.startsWith('toc_chat_join')) {
        reply('CHAT_UPDATE_BUDDY:7:T:alice');
        reply('CHAT_JOIN:7:testroom');
      }
    });
    const peer = await TocPeer.signOn({ host: '127.0.0.1', port, name: 'alice', password: 'password' });
    const id = await peer.joinRoom('testroom');
    peer.invite(id, 'botone', 'come in');
    peer.say(id, 'café');
    await fifth;
    peer.close();
    expect(id).toBe(7);
    expect(commands).toEqual([
      'toc_signon localhost 5190 alice 0x2408105c23001130 english "live-test"',
      'toc_init_done',
      'toc_chat_join 4 "testroom"',
      'toc_chat_invite 7 "come in" botone',
      'toc_chat_send 7 "café"',
    ]);
  });

  it('fails sign-on on an error line', async () => {
    const port = await tocServer((command, reply) => {
      if (command.startsWith('toc_signon')) reply('ERROR:980');
    });
    await expect(TocPeer.signOn({ host: '127.0.0.1', port, name: 'alice', password: 'wrong' })).rejects.toThrow('ERROR:980');
  });
});
