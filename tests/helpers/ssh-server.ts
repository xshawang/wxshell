import { Server, utils, type Connection, type Channel, type Session } from 'ssh2';
import { AddressInfo, createServer as createNetServer, connect as netConnect, type Server as NetServer, type Socket } from 'node:net';
import { pipeBidirectional } from '../../src/core/tunnel/Socks5Server';
import { generateKeyPair } from './keys';

/**
 * 进程内 SSH 服务端夹具。
 *
 * 本机没有 sshd（已验证：C:\Windows\System32\OpenSSH 下只有客户端，无 sshd.exe），
 * 所以集成测试用 ssh2 自带的服务端实现：自包含、不需要容器、不需要管理员权限。
 *
 * 关于关闭：不用 ssh2 自己持有的监听器，而是自己建 net.Server 再 injectSocket。
 * 原因很实际 —— ssh2 的 Server.close(cb) 直接转发给底层 net.Server.close(cb)，
 * 只要还有一个连接没断开，回调就永远不触发，测试会在 afterEach 里挂死。
 * 自己持有 socket 就能确定性地 destroy，再加兜底超时保证不会卡住整个测试进程。
 *
 * 关于转发：夹具的 tcpip 处理器允许把请求地址**重定向**到另一个真实地址。
 * 这是验证跳板链是否真的生效的关键手段 —— 把目标设成本地无法解析的名字，
 * 只有流量确实经过跳板才会连通。
 */

export interface TcpipInfo {
  destIP: string;
  destPort: number;
  srcIP: string;
  srcPort: number;
}

export interface SshServerOptions {
  username?: string;
  password?: string;
  /** OpenSSH 格式公钥文本；提供后接受对应私钥登录 */
  publicKey?: string;
  /** 指定主机私钥，用于测试"指纹变更"场景 */
  hostKey?: string;
  /** 覆盖 exec 行为 */
  onExec?: (command: string, stream: Channel, session: Session) => void;
  /** 把转发目标改写为另一个地址；返回 null 表示拒绝 */
  forwardTarget?: (info: TcpipInfo) => { host: string; port: number } | null;
  /** shell 打开后立即写入的载荷，用于制造背压场景 */
  shellPayload?: Buffer;
  /** shell 横幅，用于区分不同服务端实例 */
  banner?: string;
}

export interface SshTestStats {
  /** 建立过的 SSH 连接数，用于验证跳板链复用 */
  connections: number;
  /** 收到的 direct-tcpip（forwardOut）请求数 */
  forwards: number;
}

export interface SshTestServer {
  port: number;
  hostKey: string;
  execLog: string[];
  forwardLog: TcpipInfo[];
  shellInput: Buffer[];
  stats: SshTestStats;
  close(): Promise<void>;
}

export async function startSshServer(options: SshServerOptions = {}): Promise<SshTestServer> {
  const username = options.username ?? 'tester';
  const hostKey = options.hostKey ?? generateKeyPair('ed25519').private;

  const execLog: string[] = [];
  const forwardLog: TcpipInfo[] = [];
  const shellInput: Buffer[] = [];

  const connections = new Set<Connection>();
  const sockets = new Set<Socket>();
  const stats: SshTestStats = { connections: 0, forwards: 0 };

  const sshServer = new Server({ hostKeys: [hostKey] }, (client) => {
    stats.connections += 1;
    connections.add(client);
    client.on('close', () => connections.delete(client));
    // 客户端在 KEX/认证中途断开是**预期行为**（例如主机密钥校验失败主动 abort）。
    // 不吞掉这个错误会变成未捕获异常，污染整个测试进程。
    client.on('error', () => undefined);

    client.on('authentication', (ctx) => {
      if (ctx.username !== username) {
        ctx.reject();
        return;
      }

      if (options.password !== undefined && ctx.method === 'password') {
        if (ctx.password === options.password) ctx.accept();
        else ctx.reject();
        return;
      }

      if (options.publicKey !== undefined && ctx.method === 'publickey') {
        const parsed = utils.parseKey(options.publicKey);
        if (parsed instanceof Error) {
          ctx.reject();
          return;
        }
        const sameKey =
          ctx.key.algo === parsed.type && Buffer.compare(ctx.key.data, parsed.getPublicSSH()) === 0;
        if (!sameKey) {
          ctx.reject();
          return;
        }
        if (ctx.signature) {
          // 真正校验签名，确保客户端确实持有对应私钥
          // 有签名却没有待验数据属于协议异常，同样拒绝
          if (ctx.blob && parsed.verify(ctx.blob, ctx.signature, ctx.hashAlgo)) ctx.accept();
          else ctx.reject();
        } else {
          // 先接受"密钥查询"，客户端随后会带签名再来一次
          ctx.accept();
        }
        return;
      }

      ctx.reject(['password', 'publickey']);
    });

    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();

        session.on('pty', (acceptPty) => {
          acceptPty?.();
        });

        session.on('window-change', (acceptWindow) => {
          acceptWindow?.();
        });

        session.on('shell', (acceptShell) => {
          const stream = acceptShell();
          stream.write(`${options.banner ?? 'welcome to test sshd'}\r\n$ `);
          if (options.shellPayload) stream.write(options.shellPayload);
          stream.on('data', (chunk: Buffer) => {
            shellInput.push(chunk);
            stream.write(`IN:${chunk.toString('utf8')}`);
          });
          stream.on('close', () => stream.exit(0));
        });

        session.on('exec', (acceptExec, _reject, info) => {
          const stream = acceptExec();
          execLog.push(info.command);
          if (options.onExec) {
            options.onExec(info.command, stream, session);
            return;
          }
          runDefaultExec(info.command, stream);
        });

        session.on('sftp', (acceptSftp) => {
          const stream = acceptSftp();
          stream.end();
        });
      });

      client.on('tcpip', (accept, reject, info) => {
        stats.forwards += 1;
        forwardLog.push(info as TcpipInfo);
        const target = options.forwardTarget
          ? options.forwardTarget(info as TcpipInfo)
          : { host: info.destIP, port: info.destPort };

        if (!target) {
          reject();
          return;
        }

        const stream = accept();
        const socket = netConnect(target.port, target.host);
        socket.once('connect', () => pipeBidirectional(stream, socket));
        socket.once('error', () => stream.destroy());
        stream.once('error', () => socket.destroy());
      });
    });
  });

  const netServer: NetServer = createNetServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    sshServer.injectSocket(socket);
  });
  netServer.on('error', () => undefined);

  await new Promise<void>((resolve, reject) => {
    netServer.once('error', reject);
    netServer.listen(0, '127.0.0.1', () => {
      netServer.off('error', reject);
      resolve();
    });
  });

  const port = (netServer.address() as AddressInfo).port;

  return {
    port,
    hostKey,
    execLog,
    forwardLog,
    shellInput,
    stats,
    close: () =>
      new Promise<void>((resolve) => {
        let settled = false;
        const done = (): void => {
          if (settled) return;
          settled = true;
          resolve();
        };
        // 兜底：无论如何 2 秒内必须返回，绝不允许挂住 afterEach
        const timer = setTimeout(done, 2000);

        for (const c of connections) {
          try {
            c.end();
          } catch {
            // 已断开
          }
        }
        connections.clear();

        for (const s of sockets) {
          try {
            s.destroy();
          } catch {
            // 已关闭
          }
        }
        sockets.clear();

        try {
          netServer.close(() => {
            clearTimeout(timer);
            done();
          });
        } catch {
          clearTimeout(timer);
          done();
        }
      }),
  };
}

/** 确定性 exec 行为，便于断言 */
function runDefaultExec(command: string, stream: Channel): void {
  const trimmed = command.trim();

  const exitMatch = /^exit\s+(\d+)$/.exec(trimmed);
  if (exitMatch) {
    stream.exit(Number(exitMatch[1]));
    stream.end();
    return;
  }

  if (trimmed.startsWith('echo ')) {
    stream.write(`${trimmed.slice(5)}\n`);
    stream.exit(0);
    stream.end();
    return;
  }

  stream.write(`ran:${trimmed}\n`);
  stream.exit(0);
  stream.end();
}
