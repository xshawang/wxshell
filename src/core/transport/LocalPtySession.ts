import * as pty from 'node-pty';
import { BaseSession } from './BaseSession';
import { resolveShell, type ShellCandidate } from '../shell/resolveShell';
import type { SessionCapabilities } from '../types';

export interface LocalPtyOptions {
  /** 显式指定 shell；不指定时按候选列表探测（见 resolveShell 的说明） */
  shell?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  cols: number;
  rows: number;
  /** 传给远端的 TERM 值 */
  termName?: string;
}

/** 本地终端。必须走真 PTY（ConPTY / openpty），子进程才会按终端模式工作。 */
export class LocalPtySession extends BaseSession {
  readonly capabilities: SessionCapabilities = {
    shell: true,
    exec: false,
    sftp: false,
    forward: false,
    resize: true,
  };

  private proc: pty.IPty | null = null;
  private closedByUs = false;
  private resolved: ShellCandidate | null = null;

  constructor(id: string, private readonly options: LocalPtyOptions) {
    super(id, 'local');
  }

  /** 解析到的 shell，便于 UI 显示与排障 */
  get shellInfo(): ShellCandidate | null {
    return this.resolved;
  }

  async connect(): Promise<void> {
    this.setState('connecting');
    const candidate = resolveShell(this.options.shell);
    this.resolved = candidate;

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.options.env ?? process.env)) {
      if (typeof v === 'string') env[k] = v;
    }
    env.TERM = this.options.termName ?? 'xterm-256color';

    const args = this.options.args ?? candidate.args;

    const proc = pty.spawn(candidate.path, args, {
      name: env.TERM,
      cols: this.options.cols,
      rows: this.options.rows,
      cwd: this.options.cwd ?? process.cwd(),
      env,
      // 使用自带的 conpty，避免依赖系统版本
      useConpty: true,
    });
    this.proc = proc;

    proc.onData((chunk: string) => this.emit('data', Buffer.from(chunk, 'utf8')));
    proc.onExit(({ exitCode, signal }) => {
      this.emitClose({
        code: exitCode,
        signal: signal === undefined ? undefined : String(signal),
        reason: this.closedByUs ? 'local' : 'exit',
      });
    });

    this.setState('ready', candidate.label);
  }

  write(data: Buffer | string): void {
    if (!this.proc) return;
    this.proc.write(typeof data === 'string' ? data : data.toString('utf8'));
  }

  resize(cols: number, rows: number): void {
    if (!this.proc) return;
    if (cols <= 0 || rows <= 0) return;
    this.proc.resize(cols, rows);
  }

  pause(): void {
    this.proc?.pause();
  }

  resume(): void {
    this.proc?.resume();
  }

  async close(reason = 'local'): Promise<void> {
    if (this.isClosed) return;
    this.setState('closing', reason);
    this.closedByUs = true;
    const proc = this.proc;
    if (!proc) {
      this.emitClose({ reason });
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), 3000);
      proc.onExit(() => {
        clearTimeout(timer);
        resolve();
      });
      try {
        proc.kill();
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
    this.emitClose({ reason });
  }
}
