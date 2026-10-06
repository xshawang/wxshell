import { Client, type ClientChannel, type SFTPWrapper } from 'ssh2';
import type { Readable } from 'node:stream';
import { BaseSession } from './BaseSession';
import { AuthError, HostKeyMismatchError, XshellError } from '../errors';
import { parseSshKeyBlobAlgorithm, sshKeyBase64, sshKeyFingerprint } from '../ssh/sshKeyBlob';
import type { SessionCapabilities } from '../types';

export type SshAuthMethod = 'password' | 'publickey' | 'agent' | 'keyboard-interactive';

export interface SshAuth {
  username: string;
  method: SshAuthMethod;
  /** 明文口令，仅存在于主进程内存，绝不落盘 */
  password?: string;
  privateKey?: Buffer | string;
  passphrase?: string;
  /** agent 管道路径；Windows 上 '\\.\pipe\openssh-ssh-agent' 或 'pageant' */
  agent?: string;
}

export interface HostKeyInfo {
  host: string;
  port: number;
  keyType: string;
  keyBase64: string;
  fingerprint: string;
}

/** 返回 true 才允许继续连接。默认策略见 SessionManager：未记录 -> 拒绝并提示，记录不一致 -> 阻断。 */
export interface HostKeyVerifier {
  verify(info: HostKeyInfo): Promise<boolean>;
}

export interface SshSessionOptions {
  host: string;
  port: number;
  auth: SshAuth;
  cols: number;
  rows: number;
  terminalType?: string;
  readyTimeoutMs?: number;
  keepaliveIntervalMs?: number;
  keepaliveCountMax?: number;
  /** 允许已淘汰的算法（ssh-rsa / diffie-hellman-group1-sha1 等），默认关闭 */
  legacyAlgorithms?: boolean;
  /** 跳板链建立的隧道；有值时不再直连 host:port */
  sock?: Readable;
  hostKeyVerifier: HostKeyVerifier;
  /** 非交互模式：连接后执行该命令并将输出作为 data 抛出 */
  execCommand?: string;
  /** agent 转发，危险特性，默认关闭 */
  agentForward?: boolean;
  debug?: (message: string) => void;
  /** 测试注入点 */
  clientFactory?: () => Client;
}

export interface ExecResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}

const DEFAULT_READY_TIMEOUT = 20000;
const DEFAULT_KEEPALIVE_INTERVAL = 30000;
const DEFAULT_KEEPALIVE_COUNT_MAX = 3;

/**
 * 已淘汰算法集合。默认不启用：这些算法可被主动降级攻击利用，
 * 只在用户显式打开"兼容模式"时附加到默认列表之后。
 */
const LEGACY_ALGORITHMS = {
  kex: [
    'diffie-hellman-group1-sha1',
    'diffie-hellman-group14-sha1',
    'diffie-hellman-group-exchange-sha1',
  ],
  cipher: ['aes128-cbc', 'aes192-cbc', 'aes256-cbc', '3des-cbc'],
  serverHostKey: ['ssh-rsa', 'ssh-dss'],
  hmac: ['hmac-sha1', 'hmac-md5'],
};

export class SshSession extends BaseSession {
  readonly capabilities: SessionCapabilities = {
    shell: true,
    exec: true,
    sftp: true,
    forward: true,
    resize: true,
  };

  private client: Client | null = null;
  private stream: ClientChannel | null = null;
  private closedByUs = false;
  private hostKeyFailure: Error | null = null;
  private exitInfo: { code: number | null; signal: string | null } | null = null;

  constructor(id: string, private readonly options: SshSessionOptions) {
    super(id, 'ssh');
  }

  get connection(): Client | null {
    return this.client;
  }

  connect(): Promise<void> {
    this.setState('connecting');
    const client = this.options.clientFactory ? this.options.clientFactory() : new Client();
    this.client = client;

    return new Promise<void>((resolve, reject) => {
      let settled = false;

      const settleOk = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const settleErr = (err: Error): void => {
        if (settled) return;
        settled = true;
        this.fail(err);
        reject(err);
      };

      client.on('keyboard-interactive', (_name, _instr, _lang, prompts, finish) => {
        // 多数堡垒机走这条路；用已提供的口令回答全部提示
        const answer = this.options.auth.password ?? '';
        finish(prompts.map(() => answer));
      });

      client.on('ready', () => {
        this.setState('ready');
        if (this.options.execCommand !== undefined) {
          this.startExec(this.options.execCommand).then(settleOk).catch(settleErr);
        } else {
          this.startShell().then(settleOk).catch(settleErr);
        }
      });

      client.on('error', (err: Error) => {
        const failure = this.hostKeyFailure ?? this.decorateAuthError(err);
        settleErr(failure);
        if (settled && this.currentState === 'ready') this.fail(failure);
      });

      client.on('close', () => {
        this.emitClose({
          code: this.exitInfo?.code ?? undefined,
          signal: this.exitInfo?.signal ?? undefined,
          reason: this.closedByUs ? 'local' : 'remote',
        });
      });

      client.connect(this.buildConnectConfig());
    });
  }

  private decorateAuthError(err: Error): Error {
    const message = err.message ?? String(err);
    if (/authentication|All configured authentication methods failed/i.test(message)) {
      return new AuthError(`认证失败: ${message}`, { cause: err });
    }
    return err;
  }

  private buildConnectConfig(): Record<string, unknown> {
    const o = this.options;
    const a = o.auth;

    const config: Record<string, unknown> = {
      host: o.host,
      port: o.port,
      username: a.username,
      readyTimeout: o.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT,
      keepaliveInterval: o.keepaliveIntervalMs ?? DEFAULT_KEEPALIVE_INTERVAL,
      keepaliveCountMax: o.keepaliveCountMax ?? DEFAULT_KEEPALIVE_COUNT_MAX,
      tryKeyboard: true,
      // 主机密钥校验：异步回调形式，允许 UI 弹窗确认
      hostVerifier: (key: Buffer, verify: (ok: boolean) => void) => {
        this.verifyHostKey(key).then(verify).catch((err: Error) => {
          this.hostKeyFailure = err;
          verify(false);
        });
      },
    };

    if (o.sock) config.sock = o.sock;
    if (o.debug) config.debug = o.debug;
    if (o.agentForward) config.agentForward = true;
    if (o.legacyAlgorithms) config.algorithms = LEGACY_ALGORITHMS;

    // 注意：不要同时传 password 与 privateKey。ssh2 会按顺序尝试，但传入多余字段
    // 会让 agent/pageant 路径产生非预期行为，这里按 method 精确投喂。
    switch (a.method) {
      case 'password':
      case 'keyboard-interactive':
        config.password = a.password ?? '';
        break;
      case 'publickey':
        config.privateKey = a.privateKey;
        if (a.passphrase !== undefined) config.passphrase = a.passphrase;
        break;
      case 'agent':
        config.agent = a.agent ?? process.env.SSH_AUTH_SOCK;
        break;
    }

    return config;
  }

  private async verifyHostKey(key: Buffer): Promise<boolean> {
    const keyType = parseSshKeyBlobAlgorithm(key);
    if (!keyType) {
      this.hostKeyFailure = new XshellError('无法解析服务器主机密钥算法', 'EHOSTKEY_PARSE');
      return false;
    }

    const info: HostKeyInfo = {
      host: this.options.host,
      port: this.options.port,
      keyType,
      keyBase64: sshKeyBase64(key),
      fingerprint: sshKeyFingerprint(key),
    };

    const ok = await this.options.hostKeyVerifier.verify(info);
    if (!ok && !this.hostKeyFailure) {
      this.hostKeyFailure = new HostKeyMismatchError(
        `主机密钥校验未通过: ${info.host}:${info.port} ${info.fingerprint}`,
        { host: info.host, port: info.port, keyType: info.keyType, expected: '', actual: info.fingerprint },
      );
    }
    return ok;
  }

  private startShell(): Promise<void> {
    const o = this.options;
    return new Promise<void>((resolve, reject) => {
      const client = this.client;
      if (!client) {
        reject(new Error('客户端未初始化'));
        return;
      }

      client.shell(
        {
          term: o.terminalType ?? 'xterm-256color',
          cols: o.cols,
          rows: o.rows,
        },
        (err: Error | undefined, stream: ClientChannel) => {
          if (err) {
            reject(err);
            return;
          }
          this.stream = stream;
          stream.on('data', (chunk: Buffer) => this.emit('data', chunk));
          stream.stderr.on('data', (chunk: Buffer) => this.emit('data', chunk));
          stream.on('close', (code?: number, signal?: string) => {
            this.exitInfo = { code: code ?? null, signal: signal ?? null };
          });
          resolve();
        },
      );
    });
  }

  private startExec(command: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const client = this.client;
      if (!client) {
        reject(new Error('客户端未初始化'));
        return;
      }

      client.exec(command, (err: Error | undefined, stream: ClientChannel) => {
        if (err) {
          reject(err);
          return;
        }
        this.stream = stream;
        stream.on('data', (chunk: Buffer) => this.emit('data', chunk));
        stream.stderr.on('data', (chunk: Buffer) => this.emit('data', chunk));
        stream.on('exit', (code: number | null, signal?: string) => {
          this.exitInfo = { code: code ?? null, signal: signal ?? null };
        });
        stream.on('close', () => {
          this.emitClose({
            code: this.exitInfo?.code ?? undefined,
            reason: 'exit',
          });
        });
        resolve();
      });
    });
  }

  /** 在已建立连接上执行一次性命令（与交互 shell 互斥使用） */
  runCommand(command: string): Promise<ExecResult> {
    const client = this.client;
    if (!client) return Promise.reject(new Error('会话尚未连接'));

    return new Promise<ExecResult>((resolve, reject) => {
      client.exec(command, (err: Error | undefined, stream: ClientChannel) => {
        if (err) {
          reject(err);
          return;
        }
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let code: number | null = null;
        let signal: string | null = null;

        stream.on('data', (chunk: Buffer) => stdout.push(chunk));
        stream.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
        stream.on('exit', (c: number | null, s?: string) => {
          code = c ?? null;
          signal = s ?? null;
        });
        stream.on('close', () => {
          resolve({
            code,
            signal,
            stdout: Buffer.concat(stdout).toString('utf8'),
            stderr: Buffer.concat(stderr).toString('utf8'),
          });
        });
      });
    });
  }

  openSftp(): Promise<SFTPWrapper> {
    const client = this.client;
    if (!client) return Promise.reject(new Error('会话尚未连接'));
    return new Promise<SFTPWrapper>((resolve, reject) => {
      client.sftp((err: Error | undefined, sftp: SFTPWrapper) => (err ? reject(err) : resolve(sftp)));
    });
  }

  write(data: Buffer | string): void {
    if (!this.stream) return;
    this.stream.write(typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
  }

  resize(cols: number, rows: number): void {
    if (!this.stream || cols <= 0 || rows <= 0) return;
    // ssh2 的签名是 (rows, cols, height, width)
    this.stream.setWindow(rows, cols, 0, 0);
  }

  pause(): void {
    this.stream?.pause();
  }

  resume(): void {
    this.stream?.resume();
  }

  close(reason = 'local'): Promise<void> {
    if (this.isClosed) return Promise.resolve();
    this.setState('closing', reason);
    this.closedByUs = true;
    const client = this.client;
    if (!client) {
      this.emitClose({ reason });
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      const done = (): void => resolve();
      const timer = setTimeout(() => {
        try {
          client.destroy();
        } catch {
          // 忽略
        }
        done();
      }, 3000);

      client.once('close', () => {
        clearTimeout(timer);
        done();
      });

      try {
        client.end();
      } catch {
        clearTimeout(timer);
        done();
      }
    });
  }
}
