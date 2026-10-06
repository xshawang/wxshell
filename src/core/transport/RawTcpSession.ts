import { createConnection, type Socket } from 'node:net';
import { BaseSession } from './BaseSession';
import { XshellError } from '../errors';
import type { SessionCapabilities } from '../types';

export interface RawTcpOptions {
  host: string;
  port: number;
  connectTimeoutMs?: number;
}

const DEFAULT_CONNECT_TIMEOUT = 15000;

/** 裸 TCP：给串口服务器、调试端口这类没有会话层协议的目标用。 */
export class RawTcpSession extends BaseSession {
  readonly capabilities: SessionCapabilities = {
    shell: false,
    exec: false,
    sftp: false,
    forward: false,
    resize: false,
  };

  private socket: Socket | null = null;
  private closedByUs = false;

  constructor(id: string, private readonly options: RawTcpOptions) {
    super(id, 'rawtcp');
  }

  connect(): Promise<void> {
    this.setState('connecting');
    const { host, port, connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT } = this.options;

    return new Promise<void>((resolve, reject) => {
      const socket = createConnection({ host, port });
      this.socket = socket;
      socket.setNoDelay(true);

      const timer = setTimeout(() => {
        socket.destroy();
        const err = new XshellError(`连接 ${host}:${port} 超时（${connectTimeoutMs}ms）`, 'ETIMEOUT');
        this.fail(err);
        reject(err);
      }, connectTimeoutMs);

      socket.once('connect', () => {
        clearTimeout(timer);
        this.setState('ready');
        resolve();
      });

      socket.on('data', (chunk: Buffer) => this.emit('data', chunk));

      socket.on('error', (err: Error) => {
        clearTimeout(timer);
        if (this.currentState !== 'ready') {
          this.fail(err);
          reject(err);
        } else {
          this.fail(err);
        }
      });

      socket.on('close', () => {
        clearTimeout(timer);
        this.emitClose({ reason: this.closedByUs ? 'local' : 'remote' });
      });
    });
  }

  write(data: Buffer | string): void {
    if (!this.socket || this.socket.destroyed) return;
    this.socket.write(typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
  }

  resize(): void {
    // 裸 TCP 没有窗口尺寸概念
  }

  pause(): void {
    this.socket?.pause();
  }

  resume(): void {
    this.socket?.resume();
  }

  close(reason = 'local'): Promise<void> {
    if (this.isClosed) return Promise.resolve();
    this.setState('closing', reason);
    this.closedByUs = true;
    if (!this.socket) {
      this.emitClose({ reason });
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const socket = this.socket;
      if (!socket) {
        resolve();
        return;
      }
      socket.once('close', () => resolve());
      socket.destroy();
    });
  }
}
