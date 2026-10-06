/**
 * 主进程 / preload / 渲染进程之间共享的 IPC 契约。
 *
 * 只放类型，不放运行时依赖：渲染进程是 esbuild 打成浏览器 bundle 的，
 * 这里一旦引入 `electron` 之类的模块就会把它拖进浏览器包。
 *
 * 关于数据通道：架构方案原本约定终端字节流走独立 MessagePort，但 Electron 的
 * contextBridge 不支持把 MessagePort 传过隔离世界边界（主世界 new 出来的 port
 * 递不进 preload）。因此这里退回普通 IPC：
 *   - 主 -> 渲染：'session:data'（Uint8Array，structured clone）
 *   - 渲染 -> 主：'session:write' / 'session:ack'
 * 背压仍然是真的：渲染进程在 xterm 的 write 回调里回报已消费字节数，主进程据此
 * 决定是否暂停上游（见 FlowController）。
 */

import type { SessionTree, SessionProfile, SessionProfileInput, SessionFolder } from '../core/store/SessionStore';
import type { HostKeyInfo } from '../core/transport/SshSession';

export type { SessionTree, SessionProfile, SessionProfileInput, SessionFolder };

/**
 * 应用菜单 -> 渲染进程的命令。
 * 菜单在左栏里加东西，但左栏是渲染进程画的，所以菜单点击只发命令，由渲染进程决定怎么呈现。
 */
export type MenuCommand = 'new-session' | 'new-folder';

/** 渲染进程发起会话时提交的参数 */
export interface OpenSessionMessage {
  id: string;
  name: string;
  kind: 'local' | 'ssh' | 'telnet' | 'rawtcp';
  cols: number;
  rows: number;
  /** ssh */
  host?: string;
  port?: number;
  username?: string;
  authMethod?: 'password' | 'publickey' | 'keyboard-interactive' | 'agent';
  /** 明文口令。是否落盘由渲染进程的"保存会话/保存口令"选择决定，见 profiles:save */
  password?: string;
  privateKeyPath?: string;
  legacyAlgorithms?: boolean;
  /** local：显式指定 shell 可执行文件；留空则按候选列表自动探测 */
  shell?: string;
}

export interface SessionDataEvent {
  id: string;
  chunk: Uint8Array;
}

export interface HostKeyPromptPayload {
  requestId: string;
  info: HostKeyInfo;
  verdict: 'unknown' | 'mismatch';
}

export type HostKeyDecision = 'accept-once' | 'accept-and-save' | 'replace-and-save' | 'reject';

export interface SessionStateEvent {
  id: string;
  state: string;
  detail?: string;
}

export interface SessionExitEvent {
  id: string;
  reason?: string;
  code?: number;
}

export interface SessionErrorEvent {
  id: string;
  message: string;
  code: string;
}

/** 渲染进程可见的 API（由 preload 通过 contextBridge 暴露） */
export interface XshellApi {
  listProfiles(): Promise<SessionTree>;
  saveProfile(input: SessionProfileInput): Promise<SessionProfile>;
  deleteProfile(id: string): Promise<void>;
  createFolder(name: string, parentId: string | null): Promise<SessionFolder>;
  deleteFolder(id: string): Promise<void>;

  openSession(message: OpenSessionMessage): Promise<void>;
  /** 终端输入（键盘、粘贴） */
  writeSession(id: string, data: Uint8Array): void;
  /** 已消费字节数回报，驱动主进程背压 */
  ackSession(id: string, bytes: number): void;
  resizeSession(id: string, cols: number, rows: number): Promise<void>;
  closeSession(id: string): Promise<void>;

  answerHostKey(requestId: string, decision: HostKeyDecision): Promise<void>;

  onData(cb: (event: SessionDataEvent) => void): () => void;
  onState(cb: (event: SessionStateEvent) => void): () => void;
  onExit(cb: (event: SessionExitEvent) => void): () => void;
  onError(cb: (event: SessionErrorEvent) => void): () => void;
  onHostKeyPrompt(cb: (event: HostKeyPromptPayload) => void): () => void;
  onMenuCommand(cb: (command: MenuCommand) => void): () => void;

  platform: NodeJS.Platform;
}
