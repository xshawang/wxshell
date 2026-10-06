/**
 * 会话层的公共契约。UI 只依赖这里的类型，不直接依赖任何具体协议实现。
 */

export type SessionKind = 'ssh' | 'telnet' | 'local' | 'rawtcp';

export type SessionState =
  | 'idle'
  | 'connecting'
  | 'authenticating'
  | 'ready'
  | 'closing'
  | 'closed'
  | 'error';

export interface SessionCapabilities {
  /** 提供交互式 shell 通道 */
  shell: boolean;
  /** 提供一次性命令执行 */
  exec: boolean;
  /** 提供 SFTP 文件通道 */
  sftp: boolean;
  /** 提供端口转发 */
  forward: boolean;
  /** 支持远端窗口尺寸同步 */
  resize: boolean;
}

export interface CloseInfo {
  code?: number;
  signal?: string;
  reason?: string;
}

/** 终端数据一律以 Buffer 传递：xterm.js 自带分片 UTF-8 解码器，自己拼字符串会在多字节字符边界出错。 */
export interface SessionEvents {
  data: (chunk: Buffer) => void;
  state: (state: SessionState, detail?: string) => void;
  error: (err: Error) => void;
  close: (info: CloseInfo) => void;
}

export interface Session {
  readonly id: string;
  readonly kind: SessionKind;
  readonly state: SessionState;
  readonly capabilities: SessionCapabilities;

  on<E extends keyof SessionEvents>(ev: E, cb: SessionEvents[E]): this;
  off<E extends keyof SessionEvents>(ev: E, cb: SessionEvents[E]): this;

  /** 建立连接；成功后状态变为 ready，失败抛出并置为 error */
  connect(): Promise<void>;

  write(data: Buffer | string): void;
  resize(cols: number, rows: number): void;
  /** 背压：消费者跟不上时暂停上游读取 */
  pause(): void;
  resume(): void;
  close(reason?: string): Promise<void>;
}

export interface TerminalSize {
  cols: number;
  rows: number;
}

export const DEFAULT_TERMINAL_SIZE: TerminalSize = { cols: 120, rows: 30 };