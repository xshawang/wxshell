import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { TypedEmitter } from '../emitter';
import { FlowController } from '../terminal/FlowController';
import { AuditLog } from '../store/AuditLog';
import { KnownHostsStore, type HostKeyVerdict } from '../store/KnownHostsStore';
import { SessionLogWriter } from '../logging/SessionLog';
import { SshSession, type HostKeyInfo, type SshAuth, type SshSessionOptions } from '../transport/SshSession';
import { TelnetSession } from '../transport/TelnetSession';
import { LocalPtySession } from '../transport/LocalPtySession';
import { RawTcpSession } from '../transport/RawTcpSession';
import { JumpChain, JumpChainPool, type JumpChainLease, type JumpHop } from '../tunnel/JumpChain';
import type { SessionProfile } from '../store/SessionStore';
import type { CloseInfo, Session } from '../types';
import { ConfigError, HostKeyMismatchError } from '../errors';

/**
 * 会话管理器：唯一持有活跃会话的地方。
 *
 * 三个职责必须放在一起，因为它们共享同一份状态：
 *   1) 生命周期（建立/关闭/回收）
 *   2) 背压（把 FlowController 接到真实数据流上）
 *   3) 审计与日志（在数据经过时顺带落盘）
 */

export type HostKeyDecision = 'accept-once' | 'accept-and-save' | 'replace-and-save' | 'reject';

export interface HostKeyPrompt {
  (info: HostKeyInfo, verdict: HostKeyVerdict): Promise<HostKeyDecision>;
}

export interface SessionManagerDeps {
  knownHosts: KnownHostsStore;
  audit?: AuditLog;
  /** 未知/变更指纹时的交互回调；未提供则一律拒绝 */
  hostKeyPrompt?: HostKeyPrompt;
  /** 从保险库读取凭据；未提供时视为无凭据 */
  resolveSecret?: (ref: string) => string | null;
  /** 读取私钥文件；默认用 fs */
  loadPrivateKey?: (path: string) => Buffer;
  /** 会话日志根目录；为空则不写日志 */
  logDir?: string;
  /** 解析跳板会话配置（通常查 SessionStore） */
  resolveProfile?: (id: string) => SessionProfile | null;
  jumpChain?: JumpChain;
  jumpPool?: JumpChainPool;
}

export interface ManagedSessionEvents {
  data: (sessionId: string, chunk: Buffer) => void;
  state: (sessionId: string, state: string, detail?: string) => void;
  close: (sessionId: string, info: CloseInfo) => void;
  /**
   * 会话级错误。
   * 刻意不叫 'error'：EventEmitter 对 'error' 有特殊语义（无监听者时直接抛出），
   * 而这里的事件来自第三方库回调，抛出会变成未捕获异常并让 open() 的 promise 永不 settle。
   */
  sessionError: (sessionId: string, err: Error) => void;
}

export interface OpenLocalRequest {
  kind: 'local';
  id?: string;
  name?: string;
  shell?: string;
  args?: string[];
  cwd?: string;
  cols: number;
  rows: number;
}

export interface OpenRawRequest {
  kind: 'rawtcp';
  id?: string;
  name?: string;
  host: string;
  port: number;
  cols: number;
  rows: number;
}

export interface OpenTelnetRequest {
  kind: 'telnet';
  id?: string;
  name?: string;
  host: string;
  port: number;
  cols: number;
  rows: number;
  terminalType?: string;
}

export interface OpenSshRequest {
  kind: 'ssh';
  profile: SessionProfile;
  cols: number;
  rows: number;
  /** 覆盖 profile 中的终端类型 */
  terminalType?: string;
  legacyAlgorithms?: boolean;
}

export type OpenSessionRequest = OpenLocalRequest | OpenRawRequest | OpenTelnetRequest | OpenSshRequest;

interface Managed {
  session: Session;
  flow: FlowController;
  log: SessionLogWriter | null;
}

export class SessionManager extends TypedEmitter<ManagedSessionEvents> {
  private readonly sessions = new Map<string, Managed>();
  private readonly jumpPool: JumpChainPool;

  constructor(private readonly deps: SessionManagerDeps) {
    super();
    const chain = deps.jumpChain ?? new JumpChain();
    this.jumpPool = deps.jumpPool ?? new JumpChainPool(chain);
  }

  list(): string[] {
    return [...this.sessions.keys()];
  }

  get(id: string): Session | null {
    return this.sessions.get(id)?.session ?? null;
  }

  get pendingBytes(): Map<string, number> {
    const out = new Map<string, number>();
    for (const [id, managed] of this.sessions) out.set(id, managed.flow.pending);
    return out;
  }

  async open(request: OpenSessionRequest): Promise<Session> {
    switch (request.kind) {
      case 'local': {
        const session = new LocalPtySession(request.id ?? randomUUID(), {
          shell: request.shell,
          args: request.args,
          cwd: request.cwd,
          cols: request.cols,
          rows: request.rows,
        });
        return this.attach(session, request.name ?? 'local');
      }
      case 'rawtcp': {
        const session = new RawTcpSession(request.id ?? randomUUID(), {
          host: request.host,
          port: request.port,
        });
        return this.attach(session, request.name ?? `${request.host}:${request.port}`);
      }
      case 'telnet': {
        const session = new TelnetSession(request.id ?? randomUUID(), {
          host: request.host,
          port: request.port,
          cols: request.cols,
          rows: request.rows,
          terminalType: request.terminalType,
        });
        return this.attach(session, request.name ?? `${request.host}:${request.port}`);
      }
      case 'ssh':
        return this.openSsh(request);
    }
  }

  private async openSsh(request: OpenSshRequest): Promise<Session> {
    const profile = request.profile;
    const deps = this.deps;

    const auth = this.buildAuth(profile);
    const jumpHops = this.buildJumpHops(profile);

    let sock: import('node:stream').Readable | null = null;
    let lease: JumpChainLease | null = null;

    if (jumpHops.length > 0) {
      lease = await this.jumpPool.acquireWith(jumpHops, {
        host: profile.host!,
        port: profile.port ?? 22,
      });
      sock = lease.sock;
    }

    const options: SshSessionOptions = {
      host: profile.host!,
      port: profile.port ?? 22,
      auth,
      cols: request.cols,
      rows: request.rows,
      terminalType: request.terminalType ?? profile.terminal?.type,
      keepaliveIntervalMs: profile.keepalive?.intervalMs,
      keepaliveCountMax: profile.keepalive?.countMax,
      legacyAlgorithms: request.legacyAlgorithms,
      hostKeyVerifier: { verify: (info) => this.verifyHostKey(info) },
    };
    if (sock) options.sock = sock;

    const session = new SshSession(profile.id, options);

    try {
      const managed = await this.attach(session, profile.name);
      this.deps.audit?.append('session.open', {
        sessionId: profile.id,
        detail: { host: profile.host, port: profile.port ?? 22, user: auth.username, method: auth.method },
      });
      return managed;
    } catch (err) {
      // 连接失败必须释放跳板引用，否则链路永不回收
      lease?.release();
      throw err;
    }
  }

  private buildAuth(profile: SessionProfile): SshAuth {
    const ssh = profile.ssh;
    if (!ssh) throw new ConfigError(`会话 ${profile.name} 缺少 SSH 认证配置`);

    const resolve = this.deps.resolveSecret ?? (() => null);

    switch (ssh.method) {
      case 'password':
      case 'keyboard-interactive': {
        const password = ssh.secretRef ? resolve(ssh.secretRef) : null;
        if (password === null) {
          throw new ConfigError(`会话 ${profile.name} 的密码未在保险库中找到: ${ssh.secretRef ?? '(未设置)'}`);
        }
        return { username: ssh.username, method: ssh.method, password };
      }
      case 'publickey': {
        if (!ssh.privateKeyPath) throw new ConfigError(`会话 ${profile.name} 未指定私钥路径`);
        const loader = this.deps.loadPrivateKey ?? ((p: string) => readFileSync(p));
        const privateKey = loader(ssh.privateKeyPath);
        const passphrase = ssh.passphraseRef ? resolve(ssh.passphraseRef) ?? undefined : undefined;
        const auth: SshAuth = { username: ssh.username, method: 'publickey', privateKey };
        if (passphrase !== undefined) auth.passphrase = passphrase;
        return auth;
      }
      case 'agent':
        return { username: ssh.username, method: 'agent', agent: process.env.SSH_AUTH_SOCK };
    }
  }

  private buildJumpHops(profile: SessionProfile): JumpHop[] {
    const chain = profile.jumpChain ?? [];
    if (chain.length === 0) return [];

    return chain.map((hopId) => {
      const hop = this.lookupProfile(hopId);
      if (!hop) throw new ConfigError(`跳板会话不存在: ${hopId}`);
      const auth = this.buildAuth(hop);
      return {
        host: hop.host!,
        port: hop.port ?? 22,
        auth,
        hostKeyVerifier: { verify: (info) => this.verifyHostKey(info) },
      } as JumpHop;
    });
  }

  /** 跳板配置由外部注入的解析器提供（通常查 SessionStore） */
  private lookupProfile(id: string): SessionProfile | null {
    return this.deps.resolveProfile?.(id) ?? null;
  }

  private async verifyHostKey(info: HostKeyInfo): Promise<boolean> {
    const store = this.deps.knownHosts;
    const result = store.check(info.host, info.port, info.keyType, info.keyBase64);

    if (result.verdict === 'match') return true;

    if (result.verdict === 'mismatch') {
      // 指纹变更默认阻断；只有用户显式选择"替换"才放行
      this.deps.audit?.append('hostkey.mismatch', {
        detail: {
          host: info.host,
          port: info.port,
          keyType: info.keyType,
          expected: result.existing?.key ? 'recorded' : 'unknown',
          actual: info.fingerprint,
        },
      });

      if (!this.deps.hostKeyPrompt) {
        throw new HostKeyMismatchError(
          `${info.host}:${info.port} 主机密钥已变更（${info.fingerprint}），已阻断连接`,
          {
            host: info.host,
            port: info.port,
            keyType: info.keyType,
            expected: result.existing?.key ?? '',
            actual: info.fingerprint,
          },
        );
      }

      const decision = await this.deps.hostKeyPrompt(info, 'mismatch');
      if (decision === 'replace-and-save') {
        store.replace(info.host, info.port, info.keyType, info.keyBase64);
        this.deps.audit?.append('hostkey.trust', {
          detail: { host: info.host, port: info.port, keyType: info.keyType, mode: 'replace' },
        });
        return true;
      }
      return false;
    }

    // unknown：TOFU，必须显式确认
    this.deps.audit?.append('hostkey.unknown', {
      detail: { host: info.host, port: info.port, keyType: info.keyType, fingerprint: info.fingerprint },
    });

    if (!this.deps.hostKeyPrompt) return false;

    const decision = await this.deps.hostKeyPrompt(info, 'unknown');
    if (decision === 'reject') return false;

    if (decision === 'accept-and-save' || decision === 'replace-and-save') {
      store.trust(info.host, info.port, info.keyType, info.keyBase64);
      this.deps.audit?.append('hostkey.trust', {
        detail: { host: info.host, port: info.port, keyType: info.keyType, mode: 'save' },
      });
    }
    return true;
  }

  private async attach(session: Session, name: string): Promise<Session> {
    const managed: Managed = {
      session,
      flow: new FlowController({
        onPause: () => session.pause(),
        onResume: () => session.resume(),
      }),
      log: this.createLogWriter(name),
    };

    session.on('data', (chunk: Buffer) => {
      managed.log?.write(chunk);
      this.emit('data', session.id, chunk);
      // push 必须在 emit 之后：消费者回来后才知道实际处理了多少
      managed.flow.push(chunk.length);
    });

    session.on('state', (state, detail) => this.emit('state', session.id, state, detail));
    session.on('error', (err) => this.emit('sessionError', session.id, err));
    session.on('close', (info) => {
      managed.flow.reset();
      void managed.log?.close();
      this.sessions.delete(session.id);
      this.emit('close', session.id, info);
    });

    this.sessions.set(session.id, managed);
    try {
      await session.connect();
    } catch (err) {
      // 建立失败必须立即从注册表摘除：否则认证失败会留下"幽灵会话"，
      // 上层 list() 会看到它、后续 close 也没有对应连接可关。
      this.sessions.delete(session.id);
      void managed.log?.close();
      throw err;
    }
    return session;
  }

  private createLogWriter(name: string): SessionLogWriter | null {
    const dir = this.deps.logDir;
    if (!dir) return null;
    return new SessionLogWriter({ dir, name, text: true });
  }

  /** 消费者处理完数据后必须回报，否则背压会一直压住上游 */
  ack(sessionId: string, bytes: number): void {
    this.sessions.get(sessionId)?.flow.ack(bytes);
  }

  write(sessionId: string, data: Buffer | string): void {
    this.sessions.get(sessionId)?.session.write(data);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    this.sessions.get(sessionId)?.session.resize(cols, rows);
  }

  async close(sessionId: string, reason = 'local'): Promise<void> {
    const managed = this.sessions.get(sessionId);
    if (!managed) return;
    this.deps.audit?.append('session.close', { sessionId, detail: { reason } });
    await managed.session.close(reason);
  }

  async closeAll(): Promise<void> {
    const ids = [...this.sessions.keys()];
    await Promise.all(ids.map((id) => this.close(id, 'shutdown')));
    this.jumpPool.disposeAll();
  }
}
