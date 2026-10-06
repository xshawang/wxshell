import { createServer, type Server, type Socket } from 'node:net';
import { AddressInfo } from 'node:net';

export interface TcpEchoServer {
  port: number;
  received: Buffer[];
  connections: number;
  close(): Promise<void>;
}

/** 回显 TCP 服务：转发类测试用它验证数据是否真的被搬过去了。 */
export async function startTcpEcho(): Promise<TcpEchoServer> {
  const sockets = new Set<Socket>();
  const received: Buffer[] = [];
  const state = { connections: 0 };

  const server: Server = createServer((socket) => {
    state.connections += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('data', (chunk) => {
      received.push(chunk);
      socket.write(chunk);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  return {
    port: (server.address() as AddressInfo).port,
    received,
    get connections() {
      return state.connections;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        sockets.clear();
        server.close(() => resolve());
      }),
  };
}