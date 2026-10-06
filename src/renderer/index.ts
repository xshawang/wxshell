import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import './style.css';

import type {
  HostKeyDecision,
  HostKeyPromptPayload,
  OpenSessionMessage,
  SessionProfile,
  SessionProfileInput,
  SessionFolder,
  SessionTree,
  XshellApi,
} from '../shared/ipc';

/**
 * 渲染进程：只做两件事 —— 把字节喂给 xterm.js，把键盘输入送回主进程。
 *
 * 三条硬性约束（都来自架构方案 §4.4，且都有实际后果）：
 *  1) 数据一律以 Uint8Array 交给 term.write：xterm 内部有跨分片的 UTF-8 解码器，
 *     自己先 toString 会在中文/emoji 跨包时出现半个字符；
 *  2) write 的回调里回报已消费字节数，主进程据此暂停/恢复上游，否则 cat 大文件会 OOM；
 *  3) resize 去抖：拖动窗口时不能每帧都往远端发窗口尺寸。
 *
 * 口令：渲染进程只"写"不"读" —— 用户输入的口令会送往主进程，但已保存的口令
 * 永远不回传到这里（否则等于把明文摊在窗口里）。留空即表示使用已保存的那条。
 */

declare global {
  interface Window {
    xshell: XshellApi;
  }
}

const api = window.xshell;
const utf8 = new TextEncoder();

interface Tab {
  id: string;
  title: string;
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  panel: HTMLDivElement;
  button: HTMLDivElement;
  label: HTMLSpanElement;
}

const tabs = new Map<string, Tab>();
let activeId: string | null = null;

/** 对话框正在编辑哪条已保存会话；null 表示新建 */
let editingProfile: SessionProfile | null = null;
/** 新建会话要挂进哪个目录；null 表示根 */
let newParentId: string | null = null;

const terminalHost = document.getElementById('terminal-host') as HTMLDivElement;
const tabsBar = document.getElementById('tabs') as HTMLDivElement;
const statusBar = document.getElementById('status') as HTMLElement;
const profileList = document.getElementById('profile-list') as HTMLUListElement;
const dialog = document.getElementById('dialog') as HTMLElement;
const form = document.getElementById('session-form') as HTMLFormElement;
const folderDialog = document.getElementById('folder-dialog') as HTMLElement;
const folderForm = document.getElementById('folder-form') as HTMLFormElement;

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const fKind = el<HTMLSelectElement>('f-kind');
const fName = el<HTMLInputElement>('f-name');
const fHost = el<HTMLInputElement>('f-host');
const fPort = el<HTMLInputElement>('f-port');
const fUser = el<HTMLInputElement>('f-user');
const fAuth = el<HTMLSelectElement>('f-auth');
const fPassword = el<HTMLInputElement>('f-password');
const fKey = el<HTMLInputElement>('f-key');
const fPassphrase = el<HTMLInputElement>('f-passphrase');
const fShell = el<HTMLInputElement>('f-shell');
const fSave = el<HTMLInputElement>('f-save');
const fSaveSecret = el<HTMLInputElement>('f-save-secret');
const formHint = el<HTMLParagraphElement>('form-hint');
const fFolderName = el<HTMLInputElement>('f-folder-name');
const folderHint = el<HTMLParagraphElement>('folder-hint');
const hostKeyDialog = el<HTMLElement>('hostkey-dialog');

function newId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ?? `s-${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;
}

function setStatus(text: string): void {
  statusBar.textContent = text;
}

function themeOptions(): Record<string, string> {
  return {
    background: '#12141a',
    foreground: '#d7dae0',
    cursor: '#7ec8ff',
    selectionBackground: '#2c3550',
  };
}

function createTerminal(id: string): Tab {
  const panel = document.createElement('div');
  panel.className = 'term-panel';
  terminalHost.appendChild(panel);

  const term = new Terminal({
    // 10 万行回滚：方案要求的最低线
    scrollback: 100000,
    fontFamily: 'Cascadia Mono, Consolas, Menlo, monospace',
    fontSize: 14,
    allowProposedApi: true,
    cursorBlink: true,
    theme: themeOptions(),
  });

  const fit = new FitAddon();
  const search = new SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  try {
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = '11';
  } catch {
    // 宽字符表加载失败不致命，退回内置宽度
  }

  term.open(panel);
  try {
    term.loadAddon(new WebglAddon());
  } catch {
    // WebGL 不可用（远程桌面/无 GPU）时退回内置 DOM 渲染器
  }

  term.onData((data: string) => api.writeSession(id, utf8.encode(data)));
  term.onResize(({ cols, rows }) => void api.resizeSession(id, cols, rows));

  const button = document.createElement('div');
  button.className = 'tab';
  const label = document.createElement('span');
  label.textContent = 'session';
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = '×';
  close.title = '关闭会话';
  close.addEventListener('click', (event) => {
    event.stopPropagation();
    void api.closeSession(id);
  });
  button.append(label, close);
  button.addEventListener('click', () => focusTab(id));
  tabsBar.appendChild(button);

  return { id, title: 'session', term, fit, search, panel, button, label };
}

function focusTab(id: string): void {
  const tab = tabs.get(id);
  if (!tab) return;
  activeId = id;
  for (const other of tabs.values()) {
    const active = other.id === id;
    other.panel.classList.toggle('active', active);
    other.button.classList.toggle('active', active);
  }
  tab.fit.fit();
  tab.term.focus();
}

function closeTab(id: string): void {
  const tab = tabs.get(id);
  if (!tab) return;
  tab.term.dispose();
  tab.panel.remove();
  tab.button.remove();
  tabs.delete(id);
  if (activeId === id) {
    const next = tabs.keys().next();
    activeId = null;
    if (!next.done) focusTab(next.value);
  }
}

function titleFor(message: OpenSessionMessage): string {
  if (message.kind === 'local') return message.name || '本地 Shell';
  return message.name || `${message.host ?? ''}:${message.port ?? ''}`;
}

async function openSession(message: OpenSessionMessage): Promise<void> {
  const tab = createTerminal(message.id);
  tabs.set(message.id, tab);
  tab.title = titleFor(message);
  tab.label.textContent = tab.title;
  focusTab(message.id);
  setStatus(`正在连接 ${tab.title} …`);

  // 终端已经挂到 DOM 上，先量一次尺寸再发起连接，避免远端拿到错误的初始行列
  tab.fit.fit();
  message.cols = tab.term.cols;
  message.rows = tab.term.rows;

  try {
    await api.openSession(message);
  } catch (err) {
    setStatus(`连接失败：${(err as Error).message}`);
  }
}

/* ---------- 主进程事件 ---------- */

api.onData(({ id, chunk }) => {
  const tab = tabs.get(id);
  if (!tab) {
    // 会话已经关掉但上游还有在途数据：必须回报，否则主进程的背压会一直压着
    api.ackSession(id, chunk.length);
    return;
  }
  tab.term.write(chunk, () => api.ackSession(id, chunk.length));
});

api.onState(({ id, state, detail }) => {
  setStatus(detail ? `${id.slice(0, 8)} · ${state} · ${detail}` : `${id.slice(0, 8)} · ${state}`);
});

api.onExit(({ id, reason, code }) => {
  const tab = tabs.get(id);
  if (tab) tab.term.write(`\r\n\x1b[33m[会话结束 reason=${reason ?? 'remote'} code=${code ?? '-'}]\x1b[0m\r\n`);
  setStatus(`会话 ${id.slice(0, 8)} 已结束（${reason ?? 'remote'}）`);
});

api.onError(({ id, message, code }) => {
  const tab = tabs.get(id);
  if (tab) tab.term.write(`\r\n\x1b[31m[错误 ${code}] ${message}\x1b[0m\r\n`);
  setStatus(`错误 ${code}：${message}`);
});

/* ---------- 主机密钥确认 ---------- */

/**
 * 不用 window.confirm：它是模态阻塞的，对话框一旦被挡在窗口后面，
 * 整个渲染进程会卡住 —— 从用户角度看就是"点了连接没反应"。
 */
let hostKeyRequestId: string | null = null;
let hostKeyMismatch = false;

function finishHostKey(decision: HostKeyDecision): void {
  const requestId = hostKeyRequestId;
  hostKeyRequestId = null;
  hostKeyDialog.hidden = true;
  if (requestId) void api.answerHostKey(requestId, decision);
}

function showHostKeyDialog({ requestId, info, verdict }: HostKeyPromptPayload): void {
  hostKeyRequestId = requestId;
  hostKeyMismatch = verdict === 'mismatch';
  el('hostkey-title').textContent = hostKeyMismatch ? '主机密钥已变更！' : '首次连接该主机';
  el('hostkey-text').textContent = hostKeyMismatch
    ? '指纹与记录不一致，可能遭到中间人攻击。除非确认服务器确实换过密钥，否则请拒绝。'
    : '请核对指纹后再决定是否信任并记录。';
  el('hostkey-details').textContent =
    `主机：${info.host}:${info.port}\n算法：${info.keyType}\n指纹：${info.fingerprint}`;
  el('btn-hostkey-save').textContent = hostKeyMismatch ? '替换并保存' : '信任并保存';
  hostKeyDialog.hidden = false;
  el('btn-hostkey-once').focus();
}

el('btn-hostkey-once').addEventListener('click', () => finishHostKey('accept-once'));
el('btn-hostkey-save').addEventListener('click', () =>
  finishHostKey(hostKeyMismatch ? 'replace-and-save' : 'accept-and-save'),
);
el('btn-hostkey-reject').addEventListener('click', () => finishHostKey('reject'));

api.onHostKeyPrompt(showHostKeyDialog);

/** 菜单命令由主进程发过来：左栏是这里画的，所以怎么呈现由渲染进程决定 */
api.onMenuCommand((command) => {
  if (command === 'new-folder') showFolderDialog();
  else showDialog();
});

/* ---------- 左侧连接树 ---------- */

function profileItem(profile: SessionProfile): HTMLLIElement {
  const item = document.createElement('li');
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'profile-open';
  open.title = '连接（可修改配置后再连）';
  open.textContent = `${profile.name}  (${profile.kind}${profile.host ? ` ${profile.host}:${profile.port ?? ''}` : ''})`;
  open.addEventListener('click', () => showDialog(profile));
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'profile-del';
  del.textContent = '删除';
  del.addEventListener('click', async (event) => {
    event.stopPropagation();
    await api.deleteProfile(profile.id);
    await refreshProfiles();
  });
  item.append(open, del);
  return item;
}

function folderItem(folder: SessionFolder, tree: SessionTree): HTMLLIElement {
  const item = document.createElement('li');
  item.className = 'folder';

  const head = document.createElement('div');
  head.className = 'folder-head';
  const name = document.createElement('span');
  name.className = 'folder-name';
  name.textContent = folder.name;
  name.title = folder.name;
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'folder-add';
  add.textContent = '＋连接';
  add.title = '在该文件夹中新建连接';
  add.addEventListener('click', () => showDialog(undefined, folder.id));
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'profile-del';
  del.textContent = '删除';
  del.title = '删除文件夹（里面的连接会上移到上一层）';
  del.addEventListener('click', async () => {
    await api.deleteFolder(folder.id);
    await refreshProfiles();
  });
  head.append(name, add, del);
  item.appendChild(head);

  const children = document.createElement('ul');
  children.className = 'folder-children';
  renderLevel(folder.id, tree, children);
  if (children.childElementCount === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = '（空）';
    children.appendChild(empty);
  }
  item.appendChild(children);
  return item;
}

/** 目录树按层级渲染；parentId 指向缺失目录的项在 store.tree() 里已经被归到根 */
function renderLevel(parentId: string | null, tree: SessionTree, host: HTMLElement): void {
  for (const folder of tree.folders.filter((f) => f.parentId === parentId)) {
    host.appendChild(folderItem(folder, tree));
  }
  for (const profile of tree.sessions.filter((s) => s.parentId === parentId)) {
    host.appendChild(profileItem(profile));
  }
}

async function refreshProfiles(): Promise<void> {
  const tree: SessionTree = await api.listProfiles();
  profileList.replaceChildren();
  if (tree.folders.length === 0 && tree.sessions.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = '还没有连接。菜单「文件 → 新建连接」。';
    profileList.appendChild(empty);
    return;
  }
  renderLevel(null, tree, profileList);
}

/* ---------- 新建文件夹 ---------- */

function showFolderDialog(): void {
  fFolderName.value = '';
  folderHint.textContent = '只记在配置目录的 folders.json 里，不会在磁盘上新建真实目录。';
  folderDialog.hidden = false;
  fFolderName.focus();
}

folderForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = fFolderName.value.trim();
  if (!name) {
    folderHint.textContent = '文件夹名称不能为空。';
    return;
  }
  // 菜单新建的目录一律挂在根下
  await api.createFolder(name, null);
  folderDialog.hidden = true;
  await refreshProfiles();
});

el('btn-folder-cancel').addEventListener('click', () => {
  folderDialog.hidden = true;
});

/* ---------- 新建/编辑会话表单 ---------- */

function syncFormRows(): void {
  const kind = fKind.value;
  const ssh = kind === 'ssh';
  const network = kind === 'ssh' || kind === 'telnet' || kind === 'rawtcp';
  const passwordAuth = fAuth.value === 'password' || fAuth.value === 'keyboard-interactive';
  document.querySelectorAll<HTMLElement>('.row-ssh').forEach((node) => {
    node.hidden = !network;
  });
  document.querySelectorAll<HTMLElement>('.row-secret').forEach((node) => {
    node.hidden = !(ssh && passwordAuth);
  });
  document.querySelectorAll<HTMLElement>('.row-key').forEach((node) => {
    node.hidden = !(ssh && fAuth.value === 'publickey');
  });
  document.querySelectorAll<HTMLElement>('.row-local').forEach((node) => {
    node.hidden = kind !== 'local';
  });
  // "口令写入文件"只在确实要保存、且确实有口令可存的时候才有意义
  const secretRow = fSaveSecret.parentElement as HTMLElement | null;
  if (secretRow) {
    secretRow.hidden = !(ssh && (passwordAuth || fAuth.value === 'publickey') && fSave.checked);
  }
}

function showDialog(profile?: SessionProfile, parentId: string | null = null): void {
  form.reset();
  editingProfile = profile ?? null;
  newParentId = profile ? profile.parentId : parentId;

  if (profile) {
    fKind.value = profile.kind === 'local' ? 'local' : profile.kind;
    fName.value = profile.name;
    fHost.value = profile.host ?? '';
    fPort.value = profile.port === undefined ? '' : String(profile.port);
    fUser.value = profile.ssh?.username ?? '';
    if (profile.ssh) fAuth.value = profile.ssh.method;
    fKey.value = profile.ssh?.privateKeyPath ?? '';
    if (profile.kind === 'local') fShell.value = '';
    fSave.checked = true;
  } else {
    fPort.value = '22';
  }
  fSaveSecret.checked = true;

  el('dialog-title').textContent = profile ? `连接 ${profile.name}` : '新建连接';
  formHint.textContent =
    profile?.ssh?.secretRef || profile?.ssh?.passphraseRef
      ? '口令已保存在会话文件中：留空即用已保存的口令。'
      : '口令默认与会话配置写进同一个文件。';
  dialog.hidden = false;
  syncFormRows();
  (profile ? fPassword : fHost).focus();
}

function hideDialog(): void {
  dialog.hidden = true;
}

fKind.addEventListener('change', syncFormRows);
fAuth.addEventListener('change', syncFormRows);
fSave.addEventListener('change', syncFormRows);
el('btn-cancel').addEventListener('click', hideDialog);
el('btn-local').addEventListener('click', () => showDialog());

el('btn-pick-key').addEventListener('click', async () => {
  const picked = await api.pickPrivateKeyFile();
  if (picked) fKey.value = picked;
});

form.addEventListener('submit', (event) => {
  event.preventDefault();
  // 失败必须显示出来：静默抛出会表现成"点了连接没反应"
  void saveAndConnect().catch((err: Error) => {
    formHint.textContent = `操作失败：${err.message}`;
    setStatus(`操作失败：${err.message}`);
  });
});

async function saveAndConnect(): Promise<void> {
  const kind = fKind.value as OpenSessionMessage['kind'];
  const portText = fPort.value.trim();
  const typedPassword = fPassword.value;
  const typedPassphrase = fPassphrase.value;
  const name = fName.value.trim() || `${fHost.value.trim() || kind}`;

  const message: OpenSessionMessage = {
    // 编辑已保存会话时沿用它的 id：主进程据此命中会话文件里的口令
    id: editingProfile?.id ?? newId(),
    name,
    kind,
    cols: 80,
    rows: 24,
  };

  if (kind !== 'local') {
    message.host = fHost.value.trim();
    message.port = portText ? Number(portText) : kind === 'ssh' ? 22 : kind === 'telnet' ? 23 : undefined;
    if (!message.host) {
      formHint.textContent = '主机不能为空。';
      return;
    }
  }

  if (kind === 'ssh') {
    message.username = fUser.value.trim();
    message.authMethod = fAuth.value as OpenSessionMessage['authMethod'];
    if (message.authMethod === 'password' || message.authMethod === 'keyboard-interactive') {
      // 留空表示"用已保存的口令"，不能传空串，否则会盖掉文件里那条
      if (typedPassword !== '') message.password = typedPassword;
    } else if (message.authMethod === 'publickey') {
      message.privateKeyPath = fKey.value.trim();
      if (!message.privateKeyPath) {
        formHint.textContent = '公钥认证需要填写或选择私钥文件。';
        return;
      }
      // 留空表示沿用会话文件里已保存的私钥口令（没有则视为私钥未加密）
      if (typedPassphrase !== '') message.passphrase = typedPassphrase;
    }
  } else if (kind === 'local' && fShell.value.trim()) {
    message.shell = fShell.value.trim();
  }

  if (fSave.checked) {
    const input: SessionProfileInput = {
      name,
      kind,
      host: message.host,
      port: message.port,
      parentId: newParentId,
      ssh:
        kind === 'ssh'
          ? {
              method: message.authMethod ?? 'password',
              username: message.username ?? '',
              // 公钥认证必须把私钥路径一并存下来：SessionStore.validate 会校验它，
              // 漏掉的话保存这一步就抛错，后面的连接根本不会发起
              privateKeyPath: message.privateKeyPath,
            }
          : undefined,
    };
    if (editingProfile) input.id = editingProfile.id;
    if (kind === 'ssh' && fSaveSecret.checked && typedPassword !== '') input.password = typedPassword;
    if (kind === 'ssh' && fSaveSecret.checked && typedPassphrase !== '') input.passphrase = typedPassphrase;

    const saved = await api.saveProfile(input);
    message.id = saved.id;
    await refreshProfiles();
  }

  hideDialog();
  await openSession(message);
}

/* ---------- 搜索 ---------- */

const searchBar = el('search-bar');
const searchInput = el<HTMLInputElement>('search-input');
const searchHint = el('search-hint');

window.addEventListener('keydown', (event) => {
  if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'f') {
    event.preventDefault();
    searchBar.hidden = false;
    searchInput.focus();
    searchInput.select();
  }
  if (event.key === 'Escape' && !searchBar.hidden) {
    searchBar.hidden = true;
    tabs.get(activeId ?? '')?.term.focus();
  }
});

searchInput.addEventListener('keydown', (event) => {
  const tab = tabs.get(activeId ?? '');
  if (!tab) return;
  if (event.key === 'Enter') {
    const found = event.shiftKey
      ? tab.search.findPrevious(searchInput.value)
      : tab.search.findNext(searchInput.value);
    searchHint.textContent = found ? '' : '无匹配';
    event.preventDefault();
  }
});

/* ---------- resize 去抖 ---------- */

let resizeTimer: number | null = null;
window.addEventListener('resize', () => {
  if (resizeTimer !== null) window.clearTimeout(resizeTimer);
  // 50ms 去抖：拖动窗口期间每帧都发 setWindow 会把远端刷爆
  resizeTimer = window.setTimeout(() => {
    resizeTimer = null;
    const tab = tabs.get(activeId ?? '');
    if (tab) tab.fit.fit();
  }, 50);
});

void refreshProfiles();
setStatus(`就绪（${api.platform}）`);
