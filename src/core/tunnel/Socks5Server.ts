import { createServer, type Server, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';

/**
 * SOCKS5 动态转发服务端（RFC 1928）。
 *
 * 这是"动态端口转发"（ssh -D）的本质：本地起一个 SOCKS5 服务，
 * 每个 CONNECT 请求通过 SSH 连接开一条 direct-tcpip 通道转发出去。
 *
 * 为什么自己写：npm 上的 `socks` 包只提供**客户端**，没有可用且维护中的
 * SOCKS5 服务端实现。这里只实现 CONNECT（BIND/UDP ASSOCIATE 对 SSH 转发无意义，
 * 按规范回 0x07 command not supported）。
 *
 * 解析必须是流式的：握手与请求都可能跨 TCP 分片到达。
 */

const VER = 0x05;
const AUTH_NONE = 0x00;
const AUTH_NO_ACCEPTABLE = 0xff;

const CMD_CONNECT = 0x01;

const ATYP_IPV4 = 0x01;
const ATYP_DOMAIN = 0x03;
const ATYP_IPV6 = 0x04;

const REP_SUCCESS = 0x00;
const REP_GENERAL_FAILURE = 0x01;
const REP_HOST_UNREACHABLE = 0x04;
const REP_CONNECTION_REFUSED = 0x05;
const REP_COMMAND_NOT_SUPPORTED = 0x07;
const REP_ADDRESS_TYPE_NOT_SUPPORTED = 0x08;

export interface Socks5Target {
  host: string;
  port: number;
}

export interface Socks5ServerOptions {
  bindHost?: string;
  bindPort: number;
  /** 为每个 CONNECT 请求建立到目标的通道（通常包装 SSH 的 forwardOut） */
  openChannel: (target: Socks5Target) => Promise<Duplex>;
  onLog?: (message: string) => void;
}

export interface Socks5Address {
  host: string;
  port: number;
}

export class Socks5Server {
  private server: Server | null = null;
  private boundAddress: Socks5Address | null = null;
  private readonly sockets = new Set<Socket>();

  constructor(private readonly options: Socks5ServerOptions) {}

  get address(): Socks5Address | null {
    return this.boundAddress;
  }

  listen(): Promise<Socks5Address> {
    return new Promise<Socks5Address>((resolve, reject) => {
      const server = createServer((socket) => {
        this.sockets.add(socket);
        socket.once('close', () => this.sockets.delete(socket));
        void this.handleConnection(socket);
      });
      this.server = server;

      server.once('error', reject);
      server.listen(this.options.bindPort, this.options.bindHost ?? '127.0.0.1', () => {
        server.off('error', reject);
        const addr = server.address();
        if (addr === null || typeof addr === 'string') {
          reject(new Error('SOCKS5 服务端地址解析失败'));
          return;
        }
        this.boundAddress = { host: addr.address, port: addr.port };
        resolve(this.boundAddress);
      });
    });
  }

  close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    const server = this.server;
    this.server = null;
    this.boundAddress = null;
    if (!server) return Promise.resolve();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handleConnection(socket: Socket): Promise<void> {
    socket.setNoDelay(true);
    const reader = new SocketReader(socket);

    try {
      // --- 方法协商 ---
      const header = await reader.read(2);
      if (header[0] !== VER) {
        socket.destroy();
        return;
      }
      const methodCount = header[1]!;
      const methods = await reader.read(methodCount);
      if (!methods.includes(AUTH_NONE)) {
        socket.write(Buffer.from([VER, AUTH_NO_ACCEPTABLE]));
        socket.destroy();
        return;
      }
      socket.write(Buffer.from([VER, AUTH_NONE]));

      // --- 请求 ---
      const reqHead = await reader.read(4);
      if (reqHead[0] !== VER) {
        socket.destroy();
        return;
      }
      const command = reqHead[1]!;
      const atyp = reqHead[3]!;

      const target = await this.readTarget(reader, atyp);
      if (!target) {
        this.reply(socket, REP_ADDRESS_TYPE_NOT_SUPPORTED);
        socket.destroy();
        return;
      }
      if (command !== CMD_CONNECT) {
        this.reply(socket, REP_COMMAND_NOT_SUPPORTED);
        socket.destroy();
        return;
      }

      // --- 建通道 ---
      let channel: Duplex;
      try {
        channel = await this.options.openChannel(target);
      } catch (err) {
        const rep = mapErrorToReply(err);
        this.options.onLog?.(`SOCKS5 连接 ${target.host}:${target.port} 失败: ${(err as Error).message}`);
        this.reply(socket, rep);
        socket.destroy();
        return;
      }

      this.reply(socket, REP_SUCCESS);
      reader.flush(socket);
      pipeBidirectional(socket, channel);
    } catch {
      socket.destroy();
    }
  }

  private async readTarget(reader: SocketReader, atyp: number): Promise<Socks5Target | null> {
    switch (atyp) {
      case ATYP_IPV4: {
        const raw = await reader.read(4);
        const port = (await reader.read(2)).readUInt16BE(0);
        return { host: Array.from(raw).join('.'), port };
      }
      case ATYP_IPV6: {
        const raw = await reader.read(16);
        const port = (await reader.read(2)).readUInt16BE(0);
        const groups: string[] = [];
        for (let i = 0; i < 16; i += 2) groups.push(raw.readUInt16BE(i).toString(16));
        return { host: groups.join(':'), port };
      }
      case ATYP_DOMAIN: {
        const len = (await reader.read(1))[0]!;
        const host = (await reader.read(len)).toString('ascii');
        const port = (await reader.read(2)).readUInt16BE(0);
        return { host, port };
      }
      default:
        return null;
    }
  }

  private reply(socket: Socket, rep: number): void {
    if (socket.destroyed) return;
    // BND.ADDR / BND.PORT 填 0，客户端不依赖这两个字段做后续寻址
    socket.write(Buffer.from([VER, rep, 0x00, ATYP_IPV4, 0, 0, 0, 0, 0, 0]));
  }
}

/** 按需累积的字节读取器：处理握手跨分片到达的情况。 */
class SocketReader {
  private buffer: Buffer = Buffer.alloc(0);
  private waiters: Array<() => void> = [];
  private ended = false;

  constructor(private readonly socket: Socket) {
    socket.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      const waiters = this.waiters;
      this.waiters = [];
      for (const w of waiters) w();
    });
    socket.once('close', () => {
      this.ended = true;
      const waiters = this.waiters;
      this.waiters = [];
      for (const w of waiters) w();
    });
  }

  async read(bytes: number): Promise<Buffer> {
    while (this.buffer.length < bytes) {
      if (this.ended) throw new Error('连接在读取完成前关闭');
      this.socket.resume();
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    const out = this.buffer.subarray(0, bytes);
    this.buffer = this.buffer.subarray(bytes);
    return out;
  }

  /** 把读取器中剩余字节交还给 socket（转成管道前必须调用，否则会丢数据） */
  flush(socket: Socket): void {
    if (this.buffer.length > 0) socket.unshift(this.buffer);
    this.buffer = Buffer.alloc(0);
  }
}

export function pipeBidirectional(a: Duplex, b: Duplex): void {
  a.pipe(b);
  b.pipe(a);
  const cleanup = (): void => {
    a.destroy();
    b.destroy();
  };
  a.once('error', cleanup);
  b.once('error', cleanup);
  a.once('close', () => b.destroy());
  b.once('close', () => a.destroy());
}

function mapErrorToReply(err: unknown): number {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  switch (code) {
    case 'ECONNREFUSED':
      return REP_CONNECTION_REFUSED;
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return REP_HOST_UNREACHABLE;
    default:
      return REP_GENERAL_FAILURE;
  }
}