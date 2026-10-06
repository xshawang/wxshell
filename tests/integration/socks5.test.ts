import { setTimeout as delay } from 'node:timers/promises';
import { connect as netConnect, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { Socks5Server, type Socks5Target } from '../../src/core/tunnel/Socks5Server';
import { startTcpEcho, type TcpEchoServer } from '../helpers/tcp';

/**
 * SOCKS5 服务端（动态转发 -D 的核心）协议级测试。
 *
 * 为什么单独测：npm 的 `socks` 包只有客户端，这个服务端是自己实现的（RFC 1928），
 * 握手与请求都必须能跨 TCP 分片解析，失败路径要回正确的 REP 码。
 */

const servers: Socks5Server[] = [];
const clients: Socket[] = [];
const echoes: TcpEchoServer[] = [];

const REPLY_SUCCESS = 0x00;
const REPLY_CONNECTION_REFUSED = 0x05;
const REPLY_COMMAND_NOT_SUPPORTED = 0x07;
const REPLY_ADDRESS_TYPE_NOT_SUPPORTED = 0x08;
const REPLY_NO_ACCEPTABLE_METHODS = 0xff;

function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return (async () => {
    while (Date.now() < deadline) {
      if (predicate()) return;
      await delay(20);
    }
    throw new Error('等待条件超时');
  })();
}

interface RawClient {
  socket: Socket;
  bytes: () => Buffer;
  isClosed: () => boolean;
  write(data: Buffer): void;
}

function rawClient(port: number): RawClient {
  const socket = netConnect(port, '127.0.0.1');
  clients.push(socket);
  const chunks: Buffer[] = [];
  let closed = false;
  socket.on('data', (chunk: Buffer) => chunks.push(chunk));
  socket.on('close', () => {
    closed = true;
  });
  socket.on('error', () => undefined);
  return {
    socket,
    bytes: () => Buffer.concat(chunks),
    isClosed: () => closed,
    write: (data: Buffer) => socket.write(data),
  };
}

/** 直连目标的 openChannel：模拟"经 SSH 开 direct-tcpip 通道" */
function tcpOpenChannel(target: Socks5Target): Promise<Duplex> {
  return new Promise<Duplex>((resolve, reject) => {
    const socket = netConnect(target.port, target.host);
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

async function startServer(openChannel: (target: Socks5Target) => Promise<Duplex>): Promise<number> {
  const server = new Socks5Server({ bindPort: 0, openChannel });
  servers.push(server);
  const addr = await server.listen();
  return addr.port;
}

const GREETING = Buffer.from([0x05, 0x01, 0x00]);

function connectRequestV4(port: number, host = [127, 0, 0, 1]): Buffer {
  return Buffer.concat([
    Buffer.from([0x05, 0x01, 0x00, 0x01]),
    Buffer.from(host),
    Buffer.from([(port >> 8) & 0xff, port & 0xff]),
  ]);
}

function connectRequestDomain(host: string, port: number): Buffer {
  const name = Buffer.from(host, 'ascii');
  return Buffer.concat([
    Buffer.from([0x05, 0x01, 0x00, 0x03, name.length]),
    name,
    Buffer.from([(port >> 8) & 0xff, port & 0xff]),
  ]);
}

afterEach(async () => {
  for (const socket of clients.splice(0)) socket.destroy();
  for (const server of servers.splice(0)) await server.close();
  for (const echo of echoes.splice(0)) await echo.close();
});

describe('SOCKS5 服务端', () => {
  it('CONNECT 成功：回全零应答并双向搬运数据', async () => {
    const echo = await startTcpEcho();
    echoes.push(echo);
    const port = await startServer(tcpOpenChannel);

    const client = rawClient(port);
    client.write(GREETING);
    await waitFor(() => client.bytes().length >= 2);
    expect(client.bytes().subarray(0, 2).equals(Buffer.from([0x05, 0x00]))).toBe(true);

    client.write(connectRequestV4(echo.port));
    await waitFor(() => client.bytes().length >= 12);
    const reply = client.bytes().subarray(2);
    expect(reply[0]).toBe(0x05);
    expect(reply[1]).toBe(REPLY_SUCCESS);

    client.write(Buffer.from('through-socks'));
    await waitFor(() => client.bytes().subarray(12).toString().includes('through-socks'));
    expect(Buffer.concat(echo.received).toString()).toBe('through-socks');
  });

  it('域名目标按 ATYP=0x03 解析后交给 openChannel', async () => {
    const echo = await startTcpEcho();
    echoes.push(echo);

    const seen: Socks5Target[] = [];
    const port = await startServer((target) => {
      seen.push(target);
      return tcpOpenChannel(target);
    });

    const client = rawClient(port);
    client.write(GREETING);
    await waitFor(() => client.bytes().length >= 2);

    client.write(connectRequestDomain('127.0.0.1', echo.port));
    await waitFor(() => client.bytes().length >= 12);
    expect(client.bytes()[3]).toBe(REPLY_SUCCESS);
    expect(seen).toEqual([{ host: '127.0.0.1', port: echo.port }]);
  });

  it('目标不可达时回 0x05 connection refused', async () => {
    const port = await startServer(async () => {
      const err = new Error('connect ECONNREFUSED') as Error & { code: string };
      err.code = 'ECONNREFUSED';
      throw err;
    });

    const client = rawClient(port);
    client.write(GREETING);
    await waitFor(() => client.bytes().length >= 2);

    client.write(connectRequestV4(9));
    await waitFor(() => client.bytes().length >= 10);
    // 偏移 0-1 是方法协商应答，请求应答从偏移 2 开始，REP 在偏移 3
    expect(client.bytes()[3]).toBe(REPLY_CONNECTION_REFUSED);
  });

  it('不支持的命令（BIND / UDP ASSOCIATE）回 0x07', async () => {
    const port = await startServer(tcpOpenChannel);

    const client = rawClient(port);
    client.write(GREETING);
    await waitFor(() => client.bytes().length >= 2);

    const bind = connectRequestV4(80);
    bind[1] = 0x02;
    client.write(bind);
    await waitFor(() => client.bytes().length >= 10);
    expect(client.bytes()[3]).toBe(REPLY_COMMAND_NOT_SUPPORTED);
  });

  it('不支持的地址类型回 0x08', async () => {
    const port = await startServer(tcpOpenChannel);

    const client = rawClient(port);
    client.write(GREETING);
    await waitFor(() => client.bytes().length >= 2);

    client.write(Buffer.from([0x05, 0x01, 0x00, 0x02, 0x00, 0x50]));
    await waitFor(() => client.bytes().length >= 10);
    expect(client.bytes()[3]).toBe(REPLY_ADDRESS_TYPE_NOT_SUPPORTED);
  });

  it('没有可接受的方法时回 0xFF 并断开', async () => {
    const port = await startServer(tcpOpenChannel);

    const client = rawClient(port);
    client.write(Buffer.from([0x05, 0x01, 0x02]));
    await waitFor(() => client.bytes().length >= 2);
    expect(client.bytes().subarray(0, 2).equals(Buffer.from([0x05, REPLY_NO_ACCEPTABLE_METHODS]))).toBe(true);
    await waitFor(() => client.isClosed());
  });

  it('非 SOCKS5 版本直接断开，不回任何字节', async () => {
    const port = await startServer(tcpOpenChannel);

    const client = rawClient(port);
    client.write(Buffer.from([0x04, 0x01, 0x00]));
    await waitFor(() => client.isClosed());
    expect(client.bytes().length).toBe(0);
  });

  it('握手与请求跨 TCP 分片到达时仍能正确解析', async () => {
    const echo = await startTcpEcho();
    echoes.push(echo);
    const port = await startServer(tcpOpenChannel);

    const client = rawClient(port);
    // 逐字节写握手
    for (const byte of GREETING) {
      client.write(Buffer.from([byte]));
      await delay(15);
    }
    await waitFor(() => client.bytes().length >= 2);

    // 请求拆成"头 4 字节 + 地址"两段
    const request = connectRequestV4(echo.port);
    client.write(request.subarray(0, 4));
    await delay(30);
    client.write(request.subarray(4));

    await waitFor(() => client.bytes().length >= 12);
    expect(client.bytes()[3]).toBe(REPLY_SUCCESS);

    client.write(Buffer.from('fragmented'));
    await waitFor(() => client.bytes().subarray(12).toString().includes('fragmented'));
  });
});
