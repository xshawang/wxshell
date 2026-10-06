import { createConnection, type Socket } from 'node:net';
import { BaseSession } from './BaseSession';
import { DefaultTelnetNegotiator, IacParser, OPT } from '../telnet/IacParser';
import { XshellError } from '../errors';
import type { SessionCapabilities } from '../types';

export interface TelnetOptions {
  host: string;
  port?: number;
  cols: number;
  rows: number;
  terminalType?: string;
  connectTimeoutMs?: number;
}

const DEFAULT_PORT = 23;
const DEFAULT_CONNECT_TIMEOUT = 15000;

export class TelnetSession extends BaseSession {
  readonly capabilities: SessionCapabilities = {
    shell: true,
    exec: false,
    sftp: false,
    forward: false,
    resize: true,
  };

  private socket: Socket | null = null;
  private closedByUs = false;
  private readonly negotiator: DefaultTelnetNegotiator;
  private readonly parser: IacParser;

  constructor(id: string, private readonly options: TelnetOptions) {
    super(id, 'telnet');
    this.negotiator = new DefaultTelnetNegotiator({
      terminalType: options.terminalType ?? 'xterm-256color',
      size: { cols: options.cols, rows: options.rows },
    });
    // 协商回复必须从同一个 socket 出去，顺序才能与数据流保持一致
    this.parser = new IacParser(this.negotiator, (data) => this.socket?.write(data));
  }

  connect(): Promise<void> {
    this.setState('connecting');
    const { host, port = DEFAULT_PORT, connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT } = this.options;

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

      socket.on('data', (chunk: Buffer) => {
        const data = this.parser.feed(chunk);
        if (data.length > 0) this.emit('data', data);
      });

      socket.on('error', (err: Error) => {
        clearTimeout(timer);
        this.fail(err);
        if (this.currentState !== 'ready') reject(err);
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

  resize(cols: number, rows: number): void {
    if (cols <= 0 || rows <= 0) return;
    this.negotiator.setSize(cols, rows);
    // 仅在对端已同意 NAWS 时推送才有意义，但重复发送是安全的，对端会忽略未知协商
    this.parser.sendSubnegotiation(OPT.NAWS, this.negotiator.nawsPayload());
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
    const socket = this.socket;
    if (!socket) {
      this.emitClose({ reason });
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      socket.once('close', () => resolve());
      socket.destroy();
    });
  }
}
