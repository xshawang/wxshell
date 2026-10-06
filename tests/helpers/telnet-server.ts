import { createServer, type Server, type Socket } from 'node:net';
import { AddressInfo } from 'node:net';
import { IAC, DO, WILL, SB, SE, OPT } from '../../src/core/telnet/IacParser';

/**
 * 极简 Telnet 服务端夹具：
 * 连接后先发一轮协商（WILL ECHO / DO NAWS / DO TERMINAL-TYPE），
 * 收到客户端回复后把收到的原始字节记录下来，便于断言协商行为。
 */
export interface TelnetTestServer {
  port: number;
  log: Buffer[];
  received: Buffer[];
  /** 当前已建立的客户端连接数 */
  readonly clients: number;
  /** 从服务端向所有已连接客户端写原始字节，用于验证 IAC 转义等场景 */
  send(data: Buffer): void;
  close(): Promise<void>;
}

export async function startTelnetServer(): Promise<TelnetTestServer> {
  const log: Buffer[] = [];
  const received: Buffer[] = [];
  const sockets = new Set<Socket>();

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    // 客户端主动断开是预期行为（例如测试结束时 close），不吞掉会变成未捕获异常
    socket.on('error', () => undefined);

    socket.on('data', (chunk) => {
      received.push(chunk);
      log.push(chunk);
      // 把非协商内容原样回显，便于端到端断言
      socket.write(chunk);
    });

    // 主动发起协商，驱动客户端的 IAC 状态机
    socket.write(Buffer.from([IAC, WILL, OPT.ECHO]));
    socket.write(Buffer.from([IAC, DO, OPT.NAWS]));
    socket.write(Buffer.from([IAC, DO, OPT.TERMINAL_TYPE]));
    socket.write(Buffer.from([IAC, SB, OPT.TERMINAL_TYPE, 1, IAC, SE]));
    socket.write('login: ');
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;

  return {
    port: address.port,
    log,
    received,
    get clients() {
      return sockets.size;
    },
    send: (data: Buffer) => {
      for (const s of sockets) s.write(data);
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        sockets.clear();
        server.close(() => resolve());
      }),
  };
}
