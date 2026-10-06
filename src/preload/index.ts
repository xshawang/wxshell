import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type {
  HostKeyDecision,
  HostKeyPromptPayload,
  MenuCommand,
  OpenSessionMessage,
  SessionDataEvent,
  SessionErrorEvent,
  SessionExitEvent,
  SessionStateEvent,
  SessionProfileInput,
  XshellApi,
} from '../shared/ipc';

/**
 * preload —— 渲染进程唯一能碰到主进程的地方。
 *
 * 白名单原则：只暴露下面这些方法，不暴露 `ipcRenderer` 本身，
 * 渲染进程就无法自行构造任意 channel，也没有 require / process / fs。
 */

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T): void => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: XshellApi = {
  listProfiles: () => ipcRenderer.invoke('profiles:list'),
  saveProfile: (input: SessionProfileInput) => ipcRenderer.invoke('profiles:save', input),
  deleteProfile: (id: string) => ipcRenderer.invoke('profiles:delete', id),
  createFolder: (name: string, parentId: string | null) =>
    ipcRenderer.invoke('folders:create', name, parentId),
  deleteFolder: (id: string) => ipcRenderer.invoke('folders:delete', id),

  openSession: (message: OpenSessionMessage) => ipcRenderer.invoke('session:open', message),
  writeSession: (id: string, data: Uint8Array) => ipcRenderer.send('session:write', id, data),
  ackSession: (id: string, bytes: number) => ipcRenderer.send('session:ack', id, bytes),
  resizeSession: (id: string, cols: number, rows: number) =>
    ipcRenderer.invoke('session:resize', id, cols, rows),
  closeSession: (id: string) => ipcRenderer.invoke('session:close', id),

  answerHostKey: (requestId: string, decision: HostKeyDecision) =>
    ipcRenderer.invoke('hostkey:answer', requestId, decision),

  onData: (cb) => subscribe<SessionDataEvent>('session:data', cb),
  onState: (cb) => subscribe<SessionStateEvent>('session:state', cb),
  onExit: (cb) => subscribe<SessionExitEvent>('session:exit', cb),
  onError: (cb) => subscribe<SessionErrorEvent>('session:error', cb),
  onHostKeyPrompt: (cb) => subscribe<HostKeyPromptPayload>('hostkey:prompt', cb),
  onMenuCommand: (cb) => subscribe<MenuCommand>('menu:command', cb),

  platform: process.platform,
};

contextBridge.exposeInMainWorld('xshell', api);
