import { app, BrowserWindow, dialog, ipcMain, shell, type WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  AuditLog,
  KnownHostsStore,
  SessionManager,
  SessionStore,
  configPaths,
  resolveConfigDir,
  sessionPassphraseRef,
  sessionSecretRef,
  type ConfigPaths,
  type HostKeyInfo,
  type HostKeyVerdict,
  type SessionProfile,
  type SessionProfileInput,
} from '../core';
import type { HostKeyDecision, MenuCommand, OpenSessionMessage } from '../shared/ipc';
import { installAppMenu } from './menu';

/**
 * 主进程。
 *
 * 边界原则（对应架构方案 §3/§5）：
 *  - 会话只存在于主进程，窗口只是视图；
 *  - 渲染进程不接触文件系统、不接触私钥；口令只有两种去处：
 *      · 已保存的会话 -> 各自的会话文件（SessionStore.getSecret）
 *      · 本次输入但未保存 -> 本进程内存，退出即消失
 *    渲染进程永远读不回口令明文；
 *  - 终端字节流与背压回报走独立 channel，控制类消息走 invoke，避免大流量把控制通道堵死。
 */

/** 本次输入但未保存的口令：ref -> 明文。保存过的口令在会话文件里。 */
const transientSecrets = new Map<string, string>();
const pendingHostKeys = new Map<string, (decision: HostKeyDecision) => void>();
const activeSessions = new Set<string>();

let mainWindow: BrowserWindow | null = null;
let manager: SessionManager | null = null;
let store: SessionStore | null = null;
let paths: ConfigPaths | null = null;

/** 配置目录：默认在安装目录下的 config/，便携版整个目录拷走即带走全部连接。 */
function initConfigPaths(): ConfigPaths {
  const resolved = resolveConfigDir({
    portableDir: process.env.PORTABLE_EXECUTABLE_DIR,
    appPath: app.getAppPath(),
    fallbackDir: app.getPath('userData'),
    override: process.env.NODE_XSHELL_CONFIG_DIR,
  });
  if (resolved.note) console.warn(`[config] ${resolved.note}`);
  console.log(`[config] 配置目录（${resolved.source}）：${resolved.dir}`);
  return configPaths(resolved.dir);
}

function send(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function buildSessionManager(sessionStore: SessionStore, config: ConfigPaths): SessionManager {
  return new SessionManager({
    knownHosts: new KnownHostsStore(config.knownHosts),
    audit: new AuditLog(config.auditLog),
    logDir: config.logs,
    // 本次输入的口令优先，其次回落到会话文件里保存的那条
    resolveSecret: (ref) => transientSecrets.get(ref) ?? sessionStore.getSecret(ref),
    resolveProfile: (id) => sessionStore.getSession(id),
    hostKeyPrompt: (info: HostKeyInfo, verdict: HostKeyVerdict) =>
      new Promise<HostKeyDecision>((resolve) => {
        const requestId = randomUUID();
        pendingHostKeys.set(requestId, resolve);
        send('hostkey:prompt', { requestId, info, verdict });
      }),
  });
}

/** 把渲染进程的请求翻译成核心库的 SessionProfile */
function toProfile(message: OpenSessionMessage): SessionProfile {
  const now = new Date().toISOString();
  const profile: SessionProfile = {
    id: message.id,
    name: message.name,
    kind: message.kind,
    parentId: null,
    createdAt: now,
    updatedAt: now,
  };

  if (message.kind === 'ssh') {
    const method = message.authMethod ?? 'password';
    const ssh: NonNullable<SessionProfile['ssh']> = { method, username: message.username ?? '' };
    if (method === 'password' || method === 'keyboard-interactive') {
      // ref 由会话 id 推导：已保存的会话直接命中文件里的口令，未保存的走本次进程的内存表
      const ref = sessionSecretRef(message.id);
      ssh.secretRef = ref;
      if (message.password) transientSecrets.set(ref, message.password);
      // 这次没输入口令时不要写入空串，否则会盖掉会话文件里已保存的那条
      else transientSecrets.delete(ref);
    } else if (method === 'publickey') {
      ssh.privateKeyPath = message.privateKeyPath ?? '';
      // 私钥口令与登录口令同一套语义：这次没输入就沿用会话文件里已保存的那条
      const pref = sessionPassphraseRef(message.id);
      ssh.passphraseRef = pref;
      if (message.passphrase) transientSecrets.set(pref, message.passphrase);
      else transientSecrets.delete(pref);
    }
    profile.ssh = ssh;
    profile.host = message.host;
    profile.port = message.port ?? 22;
  } else if (message.kind === 'telnet' || message.kind === 'rawtcp') {
    profile.host = message.host;
    profile.port = message.port ?? (message.kind === 'telnet' ? 23 : 0);
  }

  return profile;
}

async function openSession(message: OpenSessionMessage): Promise<void> {
  if (!manager) throw new Error('会话管理器未初始化');
  activeSessions.add(message.id);

  try {
    if (message.kind === 'ssh') {
      await manager.open({
        kind: 'ssh',
        profile: toProfile(message),
        cols: message.cols,
        rows: message.rows,
        legacyAlgorithms: message.legacyAlgorithms,
      });
      return;
    }
    if (message.kind === 'telnet') {
      await manager.open({
        kind: 'telnet',
        id: message.id,
        name: message.name,
        host: message.host ?? '',
        port: message.port ?? 23,
        cols: message.cols,
        rows: message.rows,
      });
      return;
    }
    if (message.kind === 'rawtcp') {
      await manager.open({
        kind: 'rawtcp',
        id: message.id,
        name: message.name,
        host: message.host ?? '',
        port: message.port ?? 0,
        cols: message.cols,
        rows: message.rows,
      });
      return;
    }
    await manager.open({
      kind: 'local',
      id: message.id,
      name: message.name,
      shell: message.shell,
      cols: message.cols,
      rows: message.rows,
    });
  } catch (err) {
    activeSessions.delete(message.id);
    const error = err as Error & { code?: string };
    send('session:error', {
      id: message.id,
      message: error.message,
      code: error.code ?? 'EUNKNOWN',
    });
    throw error;
  }
}

function registerIpc(sessionStore: SessionStore): void {
  ipcMain.handle('profiles:list', () => ({
    folders: sessionStore.listFolders(),
    sessions: sessionStore.listSessions(),
  }));

  ipcMain.handle('profiles:save', (_event, input: SessionProfileInput) =>
    sessionStore.upsertSession(input),
  );

  ipcMain.handle('profiles:delete', (_event, id: string) => {
    sessionStore.deleteSession(id);
  });

  ipcMain.handle('folders:create', (_event, name: string, parentId: string | null) =>
    sessionStore.createFolder(name, parentId),
  );

  ipcMain.handle('folders:delete', (_event, id: string) => {
    sessionStore.deleteFolder(id);
  });

  // 只暴露"选私钥"这一件事，不做通用文件选择器：渲染进程拿不到任意路径的读取能力
  ipcMain.handle('dialog:pick-private-key', async (event) => {
    const options: Electron.OpenDialogOptions = {
      title: '选择私钥文件',
      properties: ['openFile'],
      filters: [
        { name: '私钥文件', extensions: ['pem', 'key', 'ppk'] },
        // 私钥常常没有扩展名（id_rsa / id_ed25519），必须留"所有文件"
        { name: '所有文件', extensions: ['*'] },
      ],
    };
    const owner = BrowserWindow.fromWebContents(event.sender);
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.handle('session:open', (_event, message: OpenSessionMessage) => openSession(message));

  ipcMain.on('session:write', (_event, id: string, data: Uint8Array) => {
    manager?.write(id, Buffer.from(data));
  });

  ipcMain.on('session:ack', (_event, id: string, bytes: number) => {
    manager?.ack(id, bytes);
  });

  ipcMain.handle('session:resize', (_event, id: string, cols: number, rows: number) => {
    manager?.resize(id, cols, rows);
  });

  ipcMain.handle('session:close', async (_event, id: string) => {
    await manager?.close(id);
  });

  ipcMain.handle('hostkey:answer', (_event, requestId: string, decision: HostKeyDecision) => {
    const resolve = pendingHostKeys.get(requestId);
    pendingHostKeys.delete(requestId);
    resolve?.(decision);
  });
}

function wireManager(instance: SessionManager, contents: WebContents): void {
  instance.on('data', (id, chunk) => {
    if (!activeSessions.has(id)) return;
    // 结构化克隆到渲染进程即 Uint8Array；xterm.js 自带跨分片 UTF-8 解码
    send('session:data', { id, chunk: new Uint8Array(chunk) });
  });

  instance.on('state', (id, state, detail) => send('session:state', { id, state, detail }));

  instance.on('sessionError', (id, err) => {
    const error = err as Error & { code?: string };
    send('session:error', { id, message: error.message, code: error.code ?? 'EUNKNOWN' });
  });

  instance.on('close', (id, info) => {
    activeSessions.delete(id);
    // 会话结束后本次输入的口令没有留着的必要
    transientSecrets.delete(sessionSecretRef(id));
    transientSecrets.delete(sessionPassphraseRef(id));
    send('session:exit', { id, reason: info.reason, code: info.code });
  });

  contents.once('destroyed', () => {
    for (const id of [...activeSessions]) void instance.close(id, 'window-closed');
  });
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 860,
    minHeight: 560,
    backgroundColor: '#12141a',
    title: 'node-xshell',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  });

  mainWindow = window;
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });

  // 新建窗口一律拒绝；https 链接交给系统浏览器，不在应用内打开
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event) => event.preventDefault());

  void window.loadFile(join(__dirname, '../renderer/index.html'));
}

app.whenReady().then(() => {
  paths = initConfigPaths();
  store = new SessionStore(paths.root);
  manager = buildSessionManager(store, paths);
  registerIpc(store);
  installAppMenu(paths.root, (command: MenuCommand) => send('menu:command', command));

  createWindow();
  if (mainWindow) wireManager(manager, mainWindow.webContents);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      if (mainWindow && manager) wireManager(manager, mainWindow.webContents);
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  void manager?.closeAll();
});
