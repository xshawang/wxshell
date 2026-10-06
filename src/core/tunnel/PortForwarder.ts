import { connect, createServer, type Server } from 'node:net';
import type { Duplex } from 'node:stream';
import { Socks5Server, pipeBidirectional, type Socks5Target } from './Socks5Server';

/**
 * 端口转发三种形态：
 *   local   —— 本地监听，流量经 SSH 出去（-L）
 *   remote  —— 远端监听，流量回到本地（-R）
 *   dynamic —— 本地 SOCKS5 代理，目标由客户端每次请求指定（-D）
 *
 * 对 transport 只依赖结构化的方法签名，不直接依赖 ssh2 的 Client，
 * 这样转发逻辑可以在没有真实 SSH 连接的情况下被测试。
 */

export interface ForwardTransport {
  forwardOut(
    srcIP: string,
    srcPort: number,
    dstIP: string,
    dstPort: number,
    callback: (err: Error | undefined, channel: Duplex) => void,
  ): void;
}

export interface RemoteForwardTransport extends ForwardTransport {
  forwardIn(remoteAddr: string, remotePort: number, callback: (err?: Error, boundPort?: number) => void): void;
  unforwardIn(remoteAddr: string, remotePort: number, callback?: () => void): void;
  on(event: 'tcp connection', handler: TcpConnectionHandler): void;
  removeListener?(event: 'tcp connection', handler: TcpConnectionHandler): void;
}

export interface TcpConnectionDetails {
  destIP: string;
  destPort: number;
  srcIP: string;
  srcPort: number;
}

export type TcpConnectionHandler = (
  details: TcpConnectionDetails,
  accept: () => Duplex,
  reject: () => void,
) => void;

export interface ForwardAddress {
  host: string;
  port: number;
}

function forwardOutAsync(
  transport: ForwardTransport,
  srcIP: string,
  srcPort: number,
  dstIP: string,
  dstPort: number,
): Promise<Duplex> {
  return new Promise<Duplex>((resolve, reject) => {
    transport.forwardOut(srcIP, srcPort, dstIP, dstPort, (err, channel) => {
      if (err) reject(err);
      else resolve(channel);
    });
  });
}

/** -L：本地端口转发 */
export class LocalForwarder {
  private server: Server | null = null;
  private address: ForwardAddress | null = null;
  private readonly sockets = new Set<Duplex>();

  constructor(
    private readonly transport: ForwardTransport,
    private readonly options: { bindHost?: string; bindPort: number; destHost: string; destPort: number },
  ) {}

  get listening(): ForwardAddress | null {
    return this.address;
  }

  start(): Promise<ForwardAddress> {
    return new Promise<ForwardAddress>((resolve, reject) => {
      const server = createServer((socket) => {
        void (async () => {
          try {
            const channel = await forwardOutAsync(
              this.transport,
              socket.remoteAddress ?? '127.0.0.1',
              socket.remotePort ?? 0,
              this.options.destHost,
              this.options.destPort,
            );
            this.sockets.add(socket);
            this.sockets.add(channel);
            socket.once('close', () => this.sockets.delete(socket));
            channel.once('close', () => this.sockets.delete(channel));
            pipeBidirectional(socket, channel);
          } catch {
            socket.destroy();
          }
        })();
      });

      this.server = server;
      server.once('error', reject);
      server.listen(this.options.bindPort, this.options.bindHost ?? '127.0.0.1', () => {
        server.off('error', reject);
        const addr = server.address();
        if (addr === null || typeof addr === 'string') {
          reject(new Error('本地转发监听地址解析失败'));
          return;
        }
        this.address = { host: addr.address, port: addr.port };
        resolve(this.address);
      });
    });
  }

  stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    const server = this.server;
    this.server = null;
    this.address = null;
    if (!server) return Promise.resolve();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/**
 * 同一个 SSH 连接上可以并存多个 -R 转发，而 ssh2 的 'tcp connection' 是广播语义：
 * 所有监听者都会被调用，而 accept/reject 整体只能生效一次。若每个 RemoteForwarder
 * 各自挂监听器，B 实例的 reject 会把 A 实例刚 accept 的通道打掉（reject 会发
 * channelOpenFail 并把通道从通道表移除）。因此按连接共享一个按端口分发的分发器，
 * 只让端口匹配的那个转发器处理。
 */
class RemoteConnectionDispatcher {
  private readonly byPort = new Map<number, TcpConnectionHandler>();
  private readonly listener: TcpConnectionHandler;

  constructor(private readonly transport: RemoteForwardTransport) {
    this.listener = (details, accept, reject) => {
      const handler = this.byPort.get(details.destPort);
      if (!handler) {
        reject();
        return;
      }
      handler(details, accept, reject);
    };
  }

  add(port: number, handler: TcpConnectionHandler): void {
    if (this.byPort.size === 0) this.transport.on('tcp connection', this.listener);
    this.byPort.set(port, handler);
  }

  remove(port: number): void {
    this.byPort.delete(port);
    if (this.byPort.size === 0) this.transport.removeListener?.('tcp connection', this.listener);
  }
}

const dispatchers = new WeakMap<RemoteForwardTransport, RemoteConnectionDispatcher>();

function dispatcherFor(transport: RemoteForwardTransport): RemoteConnectionDispatcher {
  let dispatcher = dispatchers.get(transport);
  if (!dispatcher) {
    dispatcher = new RemoteConnectionDispatcher(transport);
    dispatchers.set(transport, dispatcher);
  }
  return dispatcher;
}

/** -R：远端端口转发 */
export class RemoteForwarder {
  private boundPort: number | null = null;
  private readonly channels = new Set<Duplex>();

  constructor(
    private readonly transport: RemoteForwardTransport,
    private readonly options: { bindHost?: string; bindPort: number; destHost: string; destPort: number },
  ) {}

  get listeningPort(): number | null {
    return this.boundPort;
  }

  start(): Promise<number> {
    const bindHost = this.options.bindHost ?? '127.0.0.1';

    return new Promise<number>((resolve, reject) => {
      this.transport.forwardIn(bindHost, this.options.bindPort, (err, boundPort) => {
        if (err) {
          reject(err);
          return;
        }
        this.boundPort = boundPort ?? this.options.bindPort;
        // ssh2 在 forwardIn 回调之前就已把 _forwarding 登记好，且回调是同步调用的，
        // 因此这里注册分发不存在"连接已到但还没挂处理器"的窗口。
        dispatcherFor(this.transport).add(this.boundPort, (_details, accept) => {
          const channel = accept();
          const local = connect(this.options.destPort, this.options.destHost);
          this.channels.add(channel);
          channel.once('close', () => this.channels.delete(channel));
          local.once('error', () => channel.destroy());
          channel.once('error', () => local.destroy());
          pipeBidirectional(channel, local);
        });
        resolve(this.boundPort);
      });
    });
  }

  stop(): Promise<void> {
    for (const ch of this.channels) ch.destroy();
    this.channels.clear();

    const port = this.boundPort;
    if (port !== null) dispatcherFor(this.transport).remove(port);
    this.boundPort = null;
    if (port === null) return Promise.resolve();

    return new Promise<void>((resolve) => {
      this.transport.unforwardIn(this.options.bindHost ?? '127.0.0.1', port, () => resolve());
    });
  }
}

/** -D：动态端口转发（本地 SOCKS5 服务端） */
export class DynamicForwarder {
  private readonly server: Socks5Server;

  constructor(
    private readonly transport: ForwardTransport,
    options: { bindHost?: string; bindPort: number; onLog?: (m: string) => void },
  ) {
    this.server = new Socks5Server({
      bindHost: options.bindHost,
      bindPort: options.bindPort,
      onLog: options.onLog,
      openChannel: (target: Socks5Target) =>
        forwardOutAsync(this.transport, '127.0.0.1', 0, target.host, target.port),
    });
  }

  get listening(): ForwardAddress | null {
    return this.server.address;
  }

  start(): Promise<ForwardAddress> {
    return this.server.listen();
  }

  stop(): Promise<void> {
    return this.server.close();
  }
}
