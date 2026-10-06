import { setTimeout as delay } from 'node:timers/promises';
import { connect as netConnect, type Socket } from 'node:net';
import { Duplex, PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SshSession } from '../../src/core/transport/SshSession';
import { LocalForwarder, RemoteForwarder, DynamicForwarder } from '../../src/core/tunnel/PortForwarder';
import type { ForwardTransport, RemoteForwardTransport, TcpConnectionHandler } from '../../src/core/tunnel/PortForwarder';
import { startSshServer, type SshTestServer } from '../helpers/ssh-server';
import { startTcpEcho, type TcpEchoServer } from '../helpers/tcp';

const PASSWORD = 'pw';
const servers: SshTestServer[] = [];
const sessions: SshSession[] = [];
const echoes: TcpEchoServer[] = [];
const forwarders: Array<{ stop(): Promise<void> }> = [];

const acceptAll = { verify: async () => true };

async function connectSsh(): Promise<SshSession> {
  const server = await startSshServer({ password: PASSWORD });
  servers.push(server);
  const session = new SshSession(`fwd-${sessions.length}`, {
    host: '127.0.0.1',
    port: server.port,
    auth: { username: 'tester', method: 'password', password: PASSWORD },
    cols: 80,
    rows: 24,
    hostKeyVerifier: acceptAll,
  });
  sessions.push(session);
  await session.connect();
  return session;
}

function waitFor(predicate: () => boolean, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return (async () => {
    while (Date.now() < deadline) {
      if (predicate()) return;
      await delay(25);
    }
    throw new Error('等待条件超时');
  })();
}

/** 通过一个已建立的 TCP 连接做一次往返 */
function roundTrip(port: number, payload: string, host = '127.0.0.1'): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const socket: Socket = netConnect(port, host);
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('往返超时'));
    }, 8000);

    socket.once('connect', () => socket.write(payload));
    socket.on('data', (chunk) => {
      chunks.push(chunk);
      if (Buffer.concat(chunks).toString('utf8').length >= payload.length) {
        clearTimeout(timer);
        const text = Buffer.concat(chunks).toString('utf8');
        socket.end();
        resolve(text);
      }
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

afterEach(async () => {
  await Promise.all(forwarders.splice(0).map((f) => f.stop().catch(() => undefined)));
  for (const s of sessions.splice(0)) await s.close().catch(() => undefined);
  for (const e of echoes.splice(0)) await e.close();
  for (const s of servers.splice(0)) await s.close();
});

describe('本地端口转发 (-L)', () => {
  it('本地监听端口的数据经 SSH 通道到达目标并回传', async () => {
    const echo = await startTcpEcho();
    echoes.push(echo);

    const session = await connectSsh();
    const forwarder = new LocalForwarder(session.connection as unknown as ForwardTransport, {
      bindPort: 0,
      destHost: '127.0.0.1',
      destPort: echo.port,
    });
    forwarders.push(forwarder);

    const addr = await forwarder.start();
    expect(addr.port).toBeGreaterThan(0);

    const reply = await roundTrip(addr.port, 'through-the-tunnel');
    expect(reply).toBe('through-the-tunnel');
    // 目标端确实收到了数据，说明是真的转发而不是本地回显
    expect(Buffer.concat(echo.received).toString()).toContain('through-the-tunnel');
  });

  it('多处连接复用同一转发器', async () => {
    const echo = await startTcpEcho();
    echoes.push(echo);
    const session = await connectSsh();

    const forwarder = new LocalForwarder(session.connection as unknown as ForwardTransport, {
      bindPort: 0,
      destHost: '127.0.0.1',
      destPort: echo.port,
    });
    forwarders.push(forwarder);
    const addr = await forwarder.start();

    const replies = await Promise.all([
      roundTrip(addr.port, 'aaa'),
      roundTrip(addr.port, 'bbbb'),
      roundTrip(addr.port, 'ccccc'),
    ]);
    expect(replies.sort()).toEqual(['aaa', 'bbbb', 'ccccc']);
    expect(echo.connections).toBe(3);
  });

  it('目标不可达时本地连接被关闭而不是挂起', async () => {
    const session = await connectSsh();
    const forwarder = new LocalForwarder(session.connection as unknown as ForwardTransport, {
      bindPort: 0,
      // 指向一个几乎不可能监听的高端口
      destHost: '127.0.0.1',
      destPort: 1,
    });
    forwarders.push(forwarder);
    const addr = await forwarder.start();

    await expect(roundTrip(addr.port, 'x')).rejects.toThrow();
  });

  it('stop 之后端口不再可用', async () => {
    const echo = await startTcpEcho();
    echoes.push(echo);
    const session = await connectSsh();

    const forwarder = new LocalForwarder(session.connection as unknown as ForwardTransport, {
      bindPort: 0,
      destHost: '127.0.0.1',
      destPort: echo.port,
    });
    const addr = await forwarder.start();
    await forwarder.stop();

    await expect(roundTrip(addr.port, 'x')).rejects.toThrow();
  });
});

describe('动态端口转发 (-D / SOCKS5)', () => {
  it('作为 SOCKS5 代理转发到目标', async () => {
    const echo = await startTcpEcho();
    echoes.push(echo);
    const session = await connectSsh();

    const forwarder = new DynamicForwarder(session.connection as unknown as ForwardTransport, { bindPort: 0 });
    forwarders.push(forwarder);
    const addr = await forwarder.start();

    const { SocksClient } = await import('socks');
    const info = await SocksClient.createConnection({
      proxy: { host: '127.0.0.1', port: addr.port, type: 5 },
      command: 'connect',
      destination: { host: '127.0.0.1', port: echo.port },
    });

    const reply = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const timer = setTimeout(() => reject(new Error('超时')), 8000);
      info.socket.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        if (Buffer.concat(chunks).toString().length >= 4) {
          clearTimeout(timer);
          resolve(Buffer.concat(chunks).toString());
        }
      });
      info.socket.once('error', reject);
      info.socket.write('socks');
    });

    expect(reply).toBe('socks');
    info.socket.destroy();
  }, 30000);
});

describe('远端端口转发 (-R)', () => {
  /**
   * 远端转发需要服务端主动向客户端开 forwarded-tcpip 通道，
   * 进程内夹具无法扮演完整 sshd 的这部分行为，因此用一个模拟远端来验证
   * RemoteForwarder 自身的接线与数据搬运是否正确。
   */

  interface RemoteSide {
    /** 远端 -> 客户端方向：写入即代表"远端发来数据" */
    toClient: PassThrough;
    /** 客户端 -> 远端方向：读出即代表"客户端发往远端的数据" */
    fromClient: PassThrough;
  }

  function makeFakeRemote() {
    let handler: TcpConnectionHandler | null = null;
    let unforwarded = false;
    let nextPort = 45678;

    const transport: RemoteForwardTransport = {
      forwardOut: (_sip, _sp, _dip, _dp, cb) => cb(new Error('未使用'), new PassThrough()),
      forwardIn: (_addr, port, cb) => {
        // 0 表示让远端挑一个端口，这里从 45678 起顺次分配
        cb(undefined, port === 0 ? nextPort++ : port);
      },
      unforwardIn: (_addr, _port, cb) => {
        unforwarded = true;
        cb?.();
      },
      on: (event, h) => {
        if (event === 'tcp connection') handler = h;
      },
      removeListener: () => undefined,
    };

    return {
      transport,
      get unforwarded() {
        return unforwarded;
      },
      /** 模拟"外部有人连上了远端监听端口"，返回该连接远端侧的双工端点 */
      simulateIncoming(destPort: number): RemoteSide {
        if (!handler) throw new Error('处理函数未注册');
        // 远端侧必须是一条真正的双工流。若只用一个 PassThrough，既当"远端写入"
        // 又当"远端读出"，pipeBidirectional 会把它接成自我回环，数据永远到不了目标。
        const toClient = new PassThrough();
        const fromClient = new PassThrough();
        const channel = Duplex.from({ readable: toClient, writable: fromClient });
        handler({ destIP: '127.0.0.1', destPort, srcIP: '1.2.3.4', srcPort: 5000 }, () => channel, () => {
          throw new Error('不应被拒绝');
        });
        return { toClient, fromClient };
      },
      /** 模拟不属于本实例的转发请求 */
      simulateForeignIncoming(destPort: number) {
        const reject = vi.fn();
        handler!({ destIP: '127.0.0.1', destPort, srcIP: '1.2.3.4', srcPort: 5000 }, () => new PassThrough(), reject);
        return reject;
      },
    };
  }

  it('建立远端监听并回传协商到的端口', async () => {
    const echo = await startTcpEcho();
    echoes.push(echo);
    const remote = makeFakeRemote();

    const forwarder = new RemoteForwarder(remote.transport, {
      bindPort: 0,
      destHost: '127.0.0.1',
      destPort: echo.port,
    });
    forwarders.push(forwarder);

    const port = await forwarder.start();
    expect(port).toBe(45678);
    expect(forwarder.listeningPort).toBe(45678);
  });

  it('远端来连接时把数据搬到本地目标', async () => {
    const echo = await startTcpEcho();
    echoes.push(echo);
    const remote = makeFakeRemote();

    const forwarder = new RemoteForwarder(remote.transport, {
      bindPort: 0,
      destHost: '127.0.0.1',
      destPort: echo.port,
    });
    forwarders.push(forwarder);
    const port = await forwarder.start();

    const side = remote.simulateIncoming(port);
    const received: Buffer[] = [];
    side.fromClient.on('data', (c) => received.push(c));

    side.toClient.write('remote-inbound');
    await waitFor(() => Buffer.concat(received).toString() === 'remote-inbound');
    expect(Buffer.concat(echo.received).toString()).toContain('remote-inbound');
  });

  it('同一连接上多个 -R 转发各自只处理自己的端口', async () => {
    const echoA = await startTcpEcho();
    echoes.push(echoA);
    const echoB = await startTcpEcho();
    echoes.push(echoB);
    const remote = makeFakeRemote();

    const forwarderA = new RemoteForwarder(remote.transport, {
      bindPort: 0,
      destHost: '127.0.0.1',
      destPort: echoA.port,
    });
    const forwarderB = new RemoteForwarder(remote.transport, {
      bindPort: 0,
      destHost: '127.0.0.1',
      destPort: echoB.port,
    });
    forwarders.push(forwarderA, forwarderB);

    const portA = await forwarderA.start();
    const portB = await forwarderB.start();
    expect(portA).not.toBe(portB);

    const sideA = remote.simulateIncoming(portA);
    const sideB = remote.simulateIncoming(portB);
    const backA: Buffer[] = [];
    const backB: Buffer[] = [];
    sideA.fromClient.on('data', (c) => backA.push(c));
    sideB.fromClient.on('data', (c) => backB.push(c));

    sideA.toClient.write('to-a');
    sideB.toClient.write('to-b');

    await waitFor(
      () => Buffer.concat(backA).length > 0 && Buffer.concat(backB).length > 0,
    );
    expect(Buffer.concat(echoA.received).toString()).toBe('to-a');
    expect(Buffer.concat(echoB.received).toString()).toBe('to-b');
  });

  it('不属于本实例的转发请求被拒绝', async () => {
    const echo = await startTcpEcho();
    echoes.push(echo);
    const remote = makeFakeRemote();

    const forwarder = new RemoteForwarder(remote.transport, {
      bindPort: 0,
      destHost: '127.0.0.1',
      destPort: echo.port,
    });
    forwarders.push(forwarder);
    await forwarder.start();

    const reject = remote.simulateForeignIncoming(9999);
    expect(reject).toHaveBeenCalled();
  });

  it('stop 会取消远端监听', async () => {
    const echo = await startTcpEcho();
    echoes.push(echo);
    const remote = makeFakeRemote();

    const forwarder = new RemoteForwarder(remote.transport, {
      bindPort: 0,
      destHost: '127.0.0.1',
      destPort: echo.port,
    });
    await forwarder.start();
    await forwarder.stop();

    expect(remote.unforwarded).toBe(true);
    expect(forwarder.listeningPort).toBeNull();
  });
});
