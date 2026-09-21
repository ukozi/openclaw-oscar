import net from 'node:net';

const ROAST = 'Tic/Toc';
const FLAP_SIGNON = 1;
const FLAP_DATA = 2;

export function roast(password: string): string {
  const bytes = Buffer.from(password, 'utf8').map((b, i) => b ^ ROAST.charCodeAt(i % ROAST.length));
  return `0x${Buffer.from(bytes).toString('hex')}`;
}

export function quote(text: string): string {
  return `"${text.replace(/([\\$()[\]{}"])/g, '\\$1')}"`;
}

export class TocPeer {
  readonly lines: string[] = [];
  private unclaimed: string[] = [];
  private buffer = Buffer.alloc(0);
  private seq = 0;
  private waiters: { prefix: string; resolve: (line: string) => void }[] = [];
  private signonSeen: (() => void) | null = null;

  private constructor(private readonly socket: net.Socket) {
    socket.on('data', (chunk: Buffer) => this.read(chunk));
  }

  static async signOn(opts: { host: string; port: number; name: string; password: string }): Promise<TocPeer> {
    const socket = net.connect(opts.port, opts.host);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    const peer = new TocPeer(socket);
    const serverSignon = new Promise<void>((resolve) => (peer.signonSeen = resolve));
    socket.write('FLAPON\r\n\r\n');
    await serverSignon;
    const name = Buffer.from(opts.name, 'utf8');
    const hello = Buffer.alloc(8 + name.length);
    hello.writeUInt32BE(1, 0);
    hello.writeUInt16BE(1, 4);
    hello.writeUInt16BE(name.length, 6);
    name.copy(hello, 8);
    peer.frame(FLAP_SIGNON, hello);
    peer.command(`toc_signon localhost 5190 ${opts.name} ${roast(opts.password)} english ${quote('live-test')}`);
    const first = await peer.waitFor('');
    if (!first.startsWith('SIGN_ON')) throw new Error(`TOC sign-on refused: ${first}`);
    peer.command('toc_init_done');
    return peer;
  }

  async joinRoom(name: string, exchange: 4 | 5 = 4): Promise<number> {
    this.command(`toc_chat_join ${exchange} ${quote(name)}`);
    const line = await this.waitFor('CHAT_JOIN:');
    return Number(line.split(':')[1]);
  }

  invite(chatId: number, to: string, text: string): void {
    this.command(`toc_chat_invite ${chatId} ${quote(text)} ${to}`);
  }

  say(chatId: number, text: string): void {
    this.command(`toc_chat_send ${chatId} ${quote(text)}`);
  }

  sendIm(to: string, text: string): void {
    this.command(`toc_send_im ${to} ${quote(text)}`);
  }

  waitFor(prefix: string, ms = 5000): Promise<string> {
    const at = this.unclaimed.findIndex((line) => line.startsWith(prefix));
    if (at !== -1) return Promise.resolve(this.unclaimed.splice(at, 1)[0] ?? '');
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no TOC line starting ${JSON.stringify(prefix)}; got ${JSON.stringify(this.lines)}`)), ms);
      this.waiters.push({
        prefix,
        resolve: (line) => {
          clearTimeout(timer);
          resolve(line);
        },
      });
    });
  }

  close(): void {
    this.socket.destroy();
  }

  private command(text: string): void {
    this.frame(FLAP_DATA, Buffer.from(`${text}\0`, 'utf8'));
  }

  private frame(type: number, payload: Buffer): void {
    const head = Buffer.alloc(6);
    head.writeUInt8(0x2a, 0);
    head.writeUInt8(type, 1);
    head.writeUInt16BE(this.seq++ & 0xffff, 2);
    head.writeUInt16BE(payload.length, 4);
    this.socket.write(Buffer.concat([head, payload]));
  }

  private read(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 6) {
      const length = this.buffer.readUInt16BE(4);
      if (this.buffer.length < 6 + length) return;
      const type = this.buffer.readUInt8(1);
      const payload = this.buffer.subarray(6, 6 + length);
      this.buffer = this.buffer.subarray(6 + length);
      if (type === FLAP_SIGNON) {
        this.signonSeen?.();
      } else if (type === FLAP_DATA && payload.length > 0) {
        const line = payload.toString('utf8');
        this.lines.push(line);
        const waiter = this.waiters.find((w) => line.startsWith(w.prefix));
        if (waiter) {
          this.waiters = this.waiters.filter((w) => w !== waiter);
          waiter.resolve(line);
        } else {
          this.unclaimed.push(line);
        }
      }
    }
  }
}
