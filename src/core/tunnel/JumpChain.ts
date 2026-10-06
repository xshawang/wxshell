import { Client, type ClientChannel } from 'ssh2';
import type { Readable } from 'node:stream';
import type { SshAuth, HostKeyVerifier } from '../transport/SshSession';
import { parseSshKeyBlobAlgorithm, sshKeyBase64, sshKeyFingerprint } from '../ssh/sshKeyBlob';
import { HostKeyMismatchError, XshellError } from '../errors';

/**
 * 跳板机链（ProxyJump）。
 *
 * ssh2 没有内置跳板能力，必须手工串联：
 *   连接 hop1 → hop1.forwardOut(hop2) 拿到一条 direct-tcpip 通道
 *   → 把这个通道当作 hop2 连接的 sock → 递归
 * 最终再对目标地址开一条 forwardOut，把它交给真正的目标会话。
 *
 * 连接是复用的：同一个跳板下开 20 个会话不应该建立 20 条跳板 TCP。
 * 复用的生命周期由 JumpChainPool 的引用计数 + 空闲 TTL 管理。
 */

export interface JumpHop {
  host: string;
  port: number;
  auth: SshAuth;
  hostKeyVerifier: HostKeyVerifier;
  readyTimeoutMs?: number;
  keepaliveIntervalMs?: number;
  legacyAlgorithms?: boolean;
  debug?: (message: string) => void;
}

export interface JumpChainHandle {
  /** 指向目标地址的通道；无跳板时为 null */
  sock: Readable | null;
  /** 已建立的跳板连接，按顺序 */
  connections: Client[];
  /** 释放全部跳板连接 */
  dispose(): void;
}

export type ClientFactory = () => Client;

const DEFAULT_READY_TIMEOUT = 20000;

export class JumpChain {
  constructor(private readonly createClient: ClientFactory = () => new Client()) {}

  /**
   * 按顺序建立跳板链，返回指向 target 的通道。
   * hops 为空时返回 { sock: null }，由调用方执行直连。
   */
  async open(hops: JumpHop[], target: { host: string; port: number }): Promise<JumpChainHandle> {
    const connections: Client[] = [];

    const dispose = (): void => {
      for (const conn of connections.splice(0)) {
        try {
          conn.end();
        } catch {
          // 已断开
        }
      }
    };

    if (hops.length === 0) {
      return { sock: null, connections, dispose };
    }

    try {
      const first = hops[0]!;
      connections.push(await this.connectDirect(first));

      let previous = connections[connections.length - 1]!;
      for (let i = 1; i < hops.length; i += 1) {
        const hop = hops[i]!;
        const sock = await this.forwardOut(previous, hop.host, hop.port);
        const conn = await this.connectOverSock(hop, sock);
        connections.push(conn);
        previous = conn;
      }

      const sock = await this.forwardOut(previous, target.host, target.port);
      return { sock, connections, dispose };
    } catch (err) {
      dispose();
      throw err;
    }
  }

  private connectDirect(hop: JumpHop): Promise<Client> {
    return this.connectWith(hop, {
      host: hop.host,
      port: hop.port,
    });
  }

  private connectOverSock(hop: JumpHop, sock: Readable): Promise<Client> {
    return this.connectWith(hop, { sock });
  }

  private connectWith(hop: JumpHop, transport: { host?: string; port?: number; sock?: Readable }): Promise<Client> {
    const client = this.createClient();

    return new Promise<Client>((resolve, reject) => {
      let settled = false;
      let hostKeyFailure: Error | null = null;

      const config: Record<string, unknown> = {
        username: hop.auth.username,
        readyTimeout: hop.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT,
        keepaliveInterval: hop.keepaliveIntervalMs ?? 30000,
        tryKeyboard: true,
        hostVerifier: (key: Buffer, verify: (ok: boolean) => void) => {
          const keyType = parseSshKeyBlobAlgorithm(key);
          if (!keyType) {
            hostKeyFailure = new XshellError('无法解析跳板主机密钥算法', 'EHOSTKEY_PARSE');
            verify(false);
            return;
          }
          const info = {
            host: hop.host,
            port: hop.port,
            keyType,
            keyBase64: sshKeyBase64(key),
            fingerprint: sshKeyFingerprint(key),
          };
          hop
            .hostKeyVerifier.verify(info)
            .then((ok) => {
              if (!ok) {
                hostKeyFailure = new HostKeyMismatchError(
                  `跳板主机密钥校验未通过: ${info.host}:${info.port} ${info.fingerprint}`,
                  { host: info.host, port: info.port, keyType, expected: '', actual: info.fingerprint },
                );
              }
              verify(ok);
            })
            .catch((err: Error) => {
              hostKeyFailure = err;
              verify(false);
            });
        },
      };

      if (transport.sock) config.sock = transport.sock;
      if (transport.host) config.host = transport.host;
      if (transport.port !== undefined) config.port = transport.port;
      if (hop.debug) config.debug = hop.debug;
      if (hop.legacyAlgorithms) {
        config.algorithms = {
          kex: ['diffie-hellman-group14-sha1', 'diffie-hellman-group-exchange-sha1'],
          cipher: ['aes128-cbc', 'aes192-cbc', 'aes256-cbc'],
          serverHostKey: ['ssh-rsa'],
          hmac: ['hmac-sha1'],
        };
      }

      const auth = hop.auth;
      if (auth.method === 'password' || auth.method === 'keyboard-interactive') {
        config.password = auth.password ?? '';
      } else if (auth.method === 'publickey') {
        config.privateKey = auth.privateKey;
        if (auth.passphrase !== undefined) config.passphrase = auth.passphrase;
      } else if (auth.method === 'agent') {
        config.agent = auth.agent ?? process.env.SSH_AUTH_SOCK;
      }

      client.on('keyboard-interactive', (_n, _i, _l, prompts, finish) => {
        finish(prompts.map(() => auth.password ?? ''));
      });

      client.once('ready', () => {
        if (settled) return;
        settled = true;
        resolve(client);
      });

      // 必须是常驻监听器而不是 once：握手失败后连接会被销毁，socket 还会再抛一次
      // ECONNRESET（ssh2 会以 'error' 事件转发）。EventEmitter 上没有监听者的 'error'
      // 会直接抛出未捕获异常，把整个进程带崩。
      client.on('error', (err: Error) => {
        if (settled) return;
        settled = true;
        const failure = hostKeyFailure ?? err;
        try {
          client.end();
        } catch {
          // 忽略
        }
        reject(failure);
      });

      client.connect(config);
    });
  }

  private forwardOut(client: Client, host: string, port: number): Promise<ClientChannel> {
    return new Promise<ClientChannel>((resolve, reject) => {
      client.forwardOut('127.0.0.1', 0, host, port, (err: Error | undefined, channel: ClientChannel) => {
        if (err) reject(err);
        else resolve(channel);
      });
    });
  }
}

export interface JumpChainLease {
  readonly sock: Readable | null;
  readonly reuseKey: string;
  release(): void;
}

interface PoolEntry {
  key: string;
  handle: JumpChainHandle;
  refs: number;
  idleTimer: NodeJS.Timeout | null;
}

export interface JumpChainPoolOptions {
  /** 引用归零后多久回收；期间再次 acquire 会复用 */
  idleTtlMs?: number;
  setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
}

export const DEFAULT_JUMP_IDLE_TTL = 60000;

/** 跳板链复用池：引用计数 + 空闲回收。 */
export class JumpChainPool {
  private readonly entries = new Map<string, PoolEntry>();
  private readonly idleTtlMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => NodeJS.Timeout;
  private readonly clearTimer: (timer: NodeJS.Timeout) => void;

  constructor(
    private readonly chain: JumpChain,
    options: JumpChainPoolOptions = {},
  ) {
    this.idleTtlMs = options.idleTtlMs ?? DEFAULT_JUMP_IDLE_TTL;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
  }

  /** 复用键：跳板链定义相同即视为同一条链路 */
  static keyOf(hops: JumpHop[], target: { host: string; port: number }): string {
    const hopPart = hops.map((h) => `${h.auth.username}@${h.host}:${h.port}`).join('>');
    return `${hopPart}=>${target.host}:${target.port}`;
  }

  get size(): number {
    return this.entries.size;
  }


  async acquireWith(hops: JumpHop[], target: { host: string; port: number }): Promise<JumpChainLease> {
    const key = JumpChainPool.keyOf(hops, target);
    const existing = this.entries.get(key);

    if (existing) {
      // 必须显式判 null：定时器句柄不保证是真值（数字 ID 可能为 0）
      if (existing.idleTimer !== null) {
        this.clearTimer(existing.idleTimer);
        existing.idleTimer = null;
      }
      existing.refs += 1;
      return this.makeLease(key, existing);
    }

    const handle = await this.chain.open(hops, target);
    const entry: PoolEntry = { key, handle, refs: 1, idleTimer: null };
    this.entries.set(key, entry);
    return this.makeLease(key, entry);
  }

  /** 释放全部条目（应用退出时调用） */
  disposeAll(): void {
    for (const entry of this.entries.values()) {
      if (entry.idleTimer !== null) this.clearTimer(entry.idleTimer);
      entry.handle.dispose();
    }
    this.entries.clear();
  }

  private makeLease(key: string, entry: PoolEntry): JumpChainLease {
    let released = false;
    return {
      sock: entry.handle.sock,
      reuseKey: key,
      release: () => {
        if (released) return; // 幂等：重复 release 不能把引用计数打成负数
        released = true;
        entry.refs -= 1;
        if (entry.refs > 0) return;
        entry.idleTimer = this.setTimer(() => {
          const current = this.entries.get(key);
          if (!current || current.refs > 0) return;
          current.handle.dispose();
          this.entries.delete(key);
        }, this.idleTtlMs);
      },
    };
  }
}
