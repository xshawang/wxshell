/**
 * Electron 冒烟验证：用真实 Electron 跑一遍
 *   dist/main（主进程） + dist/preload（contextBridge） + dist/renderer（xterm.js） + node-pty
 * 全链路，最后以退出码反映结果。
 *
 * 用法：npx electron scripts/smoke.js
 *
 * 为什么不用 vitest：vitest 跑在 Node 里，起不了 Electron 的渲染进程，
 * 也就验证不了 contextBridge 白名单、preload 路径、renderer bundle 这些真正易错的接缝。
 */

const { app, BrowserWindow, Menu } = require('electron');
const { existsSync, mkdtempSync, readFileSync, readdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

// 冒烟不能把配置写进项目目录：显式指一个临时配置目录（也是 NODE_XSHELL_CONFIG_DIR 的用法示范）
const CONFIG_DIR = mkdtempSync(join(tmpdir(), 'node-xshell-smoke-'));
process.env.NODE_XSHELL_CONFIG_DIR = CONFIG_DIR;

// 无 GPU 的环境（远程桌面 / CI）下 WebGL 会失败，冒烟时直接软渲染，减少无关噪音
app.disableHardwareAcceleration();

// 本机实测：ConPTY 下启动 Windows PowerShell 5.1 会弹交互式安全确认，无法脚本化。
// 冒烟验证只关心链路本身，因此显式指定 cmd.exe 作为本地 shell。
const CMD = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\cmd.exe`;

// 加载真实主进程：它会注册 IPC、装应用菜单、创建窗口、加载 dist/renderer/index.html
require('../dist/main/index.js');

const results = [];
function check(name, ok, extra) {
  results.push({ name, ok, extra });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  ${extra}` : ''}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`等待超时: ${label}`);
}

async function findWindow() {
  return waitFor(() => BrowserWindow.getAllWindows()[0] ?? null, 15000, '主窗口');
}

async function run() {
  const win = await findWindow();
  const wc = win.webContents;
  await waitFor(() => !wc.isLoading(), 20000, '渲染进程加载完成');

  // 1) 渲染进程确实加载了我们的页面，而不是错误页
  const title = await wc.executeJavaScript('document.title');
  check('渲染进程加载 index.html', title === 'node-xshell', `title=${title}`);

  // 2) preload 的 contextBridge 生效，且没有把 Node 能力漏给页面
  const bridge = await wc.executeJavaScript(
    'JSON.stringify({ api: typeof window.xshell === "object", require: typeof window.require, process: typeof window.process })',
  );
  const b = JSON.parse(bridge);
  check('contextBridge 暴露 window.xshell', b.api === true);
  check('渲染进程未泄漏 require/process', b.require === 'undefined' && b.process === 'undefined');

  // 3) 走真实 UI 路径：点"本地终端" -> 提交表单 -> 出现标签页
  await wc.executeJavaScript('document.getElementById("btn-local").click()');
  const dialogVisible = await wc.executeJavaScript('!document.getElementById("dialog").hidden');
  check('点击"本地终端"打开对话框', dialogVisible === true);

  // 每段脚本都包在 IIFE 里：executeJavaScript 共用同一个全局上下文，
  // 不加会撞上 "Identifier has already been declared"。
  await wc.executeJavaScript(`
    (() => {
      const kind = document.getElementById('f-kind');
      kind.value = 'local';
      kind.dispatchEvent(new Event('change'));
      document.getElementById('f-name').value = 'smoke-local';
      document.getElementById('f-shell').value = ${JSON.stringify(CMD)};
      document.getElementById('session-form').requestSubmit();
      return true;
    })()
  `);

  const tabTitle = await waitFor(
    () => wc.executeJavaScript('document.querySelector(".tab span") ? document.querySelector(".tab span").textContent : ""'),
    20000,
    '标签页出现',
  );
  check('UI 路径创建了标签页', tabTitle.length > 0, `tab=${tabTitle}`);

  const readyStatus = await waitFor(
    () => wc.executeJavaScript('document.getElementById("status").textContent.includes("ready")'),
    20000,
    '会话进入 ready',
  );
  check('本地 PTY 会话进入 ready', readyStatus === true);

  // 4) 直接驱动 API 验证二进制往返 + 背压回报：PTY 输出必须真的到达渲染进程
  const dataProbe = await wc.executeJavaScript(`
    (async () => {
      const id = 'smoke-' + Date.now();
      const chunks = [];
      const off = window.xshell.onData((e) => { if (e.id === id) chunks.push(e.chunk); });
      await window.xshell.openSession({ id, name: 'smoke-probe', kind: 'local', cols: 80, rows: 24, shell: ${JSON.stringify(CMD)} });
      await new Promise((r) => setTimeout(r, 600));
      const enc = new TextEncoder();
      window.xshell.writeSession(id, enc.encode('set /a 6*7\\r\\n'));
      await new Promise((r) => setTimeout(r, 1500));
      off();
      let total = 0;
      for (const c of chunks) total += c.length;
      const text = chunks.map((c) => new TextDecoder().decode(c)).join('');
      await window.xshell.closeSession(id);
      return JSON.stringify({ total, has42: text.includes('42') });
    })()
  `);
  const probe = JSON.parse(dataProbe);
  check('PTY 输出经主进程到达渲染进程', probe.total > 0, `bytes=${probe.total}`);
  check('命令在真 PTY 里被执行（输出含 42）', probe.has42 === true);

  // 5) 应用菜单：文件 -> 新建连接 / 新建文件夹
  const fileMenu = Menu.getApplicationMenu()?.items.find((item) => item.label === '文件');
  const labels = fileMenu ? fileMenu.submenu.items.map((item) => item.label) : [];
  check(
    '文件菜单含新建连接/新建文件夹/打开配置目录',
    labels.includes('新建连接…') && labels.includes('新建文件夹…') && labels.includes('打开配置目录'),
    `items=${labels.filter(Boolean).join('|')}`,
  );

  const clickMenuItem = (label) => {
    const item = fileMenu.submenu.items.find((entry) => entry.label === label);
    if (!item) throw new Error(`菜单项不存在: ${label}`);
    item.click();
  };

  clickMenuItem('新建文件夹…');
  const folderDialogVisible = await wc.executeJavaScript('!document.getElementById("folder-dialog").hidden');
  check('菜单「新建文件夹」打开对话框', folderDialogVisible === true);

  await wc.executeJavaScript(`
    (() => {
      document.getElementById('f-folder-name').value = 'smoke-folder';
      document.getElementById('folder-form').requestSubmit();
      return true;
    })()
  `);
  const folderShown = await waitFor(
    () =>
      wc.executeJavaScript(
        'document.querySelector(".folder-name") ? document.querySelector(".folder-name").textContent : ""',
      ),
    10000,
    '文件夹出现在左栏',
  );
  check('文件夹出现在左侧列表', folderShown === 'smoke-folder', `name=${folderShown}`);

  // 6) 配置落在配置目录里：文件夹进 folders.json
  const foldersFile = join(CONFIG_DIR, 'folders.json');
  const foldersRaw = existsSync(foldersFile) ? readFileSync(foldersFile, 'utf8') : '';
  check('folders.json 写入配置目录', foldersRaw.includes('smoke-folder'), CONFIG_DIR);

  // 7) 菜单「新建连接」-> 保存 SSH 连接 -> 一个连接一个配置文件（配置 + 口令同文件）
  clickMenuItem('新建连接…');
  const newDialogVisible = await wc.executeJavaScript('!document.getElementById("dialog").hidden');
  check('菜单「新建连接」打开对话框', newDialogVisible === true);

  await wc.executeJavaScript(`
    (() => {
      const kind = document.getElementById('f-kind');
      kind.value = 'ssh';
      kind.dispatchEvent(new Event('change'));
      document.getElementById('f-name').value = 'smoke-ssh';
      // 端口 1 上没有服务，握手会立刻失败；这里只验保存，不等连接成功
      document.getElementById('f-host').value = '127.0.0.1';
      document.getElementById('f-port').value = '1';
      document.getElementById('f-user').value = 'root';
      document.getElementById('f-password').value = 'smoke-secret';
      const save = document.getElementById('f-save');
      save.checked = true;
      save.dispatchEvent(new Event('change'));
      document.getElementById('session-form').requestSubmit();
      return true;
    })()
  `);

  const sessionFile = await waitFor(() => {
    const dir = join(CONFIG_DIR, 'sessions');
    const names = existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.json')) : [];
    return names.length === 1 ? join(dir, names[0]) : null;
  }, 15000, '会话配置文件');
  check('一个连接一个配置文件', sessionFile !== null, sessionFile ?? '');

  const sessionRaw = readFileSync(sessionFile, 'utf8');
  const sessionJson = JSON.parse(sessionRaw);
  check(
    '配置与口令写进同一个文件',
    sessionJson.profile.name === 'smoke-ssh' && Object.values(sessionJson.secrets ?? {}).includes('smoke-secret'),
  );

  const savedShown = await waitFor(
    () => wc.executeJavaScript('document.querySelectorAll("#profile-list .profile-open").length'),
    10000,
    '连接出现在左栏',
  );
  check('保存的连接出现在左侧列表', savedShown >= 1, `count=${savedShown}`);

  // 7b) 公钥认证保存：私钥路径必须跟着落盘。
  //     回归用例 —— 漏掉 privateKeyPath 时 profiles:save 会抛
  //     "公钥认证必须指定私钥路径"，整个提交中断，表现为"点连接没反应"。
  clickMenuItem('新建连接…');
  await wc.executeJavaScript(`
    (() => {
      const kind = document.getElementById('f-kind');
      kind.value = 'ssh';
      kind.dispatchEvent(new Event('change'));
      document.getElementById('f-name').value = 'smoke-key';
      document.getElementById('f-host').value = '127.0.0.1';
      document.getElementById('f-port').value = '1';
      document.getElementById('f-user').value = 'root';
      const auth = document.getElementById('f-auth');
      auth.value = 'publickey';
      auth.dispatchEvent(new Event('change'));
      document.getElementById('f-key').value = 'C:/keys/id_ed25519';
      const save = document.getElementById('f-save');
      save.checked = true;
      save.dispatchEvent(new Event('change'));
      document.getElementById('session-form').requestSubmit();
      return true;
    })()
  `);

  const keyFile = await waitFor(() => {
    const dir = join(CONFIG_DIR, 'sessions');
    const names = existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.json')) : [];
    return names.map((n) => join(dir, n)).find((f) => readFileSync(f, 'utf8').includes('smoke-key')) ?? null;
  }, 15000, '公钥会话配置文件');

  const keyProfile = keyFile ? JSON.parse(readFileSync(keyFile, 'utf8')).profile : null;
  check(
    '公钥会话保存成功且私钥路径落盘',
    keyProfile?.name === 'smoke-key' && keyProfile?.ssh?.privateKeyPath === 'C:/keys/id_ed25519',
    `file=${keyFile ?? '-'} path=${keyProfile?.ssh?.privateKeyPath ?? '-'}`,
  );

  // 8) 再打开这条已保存连接时，口令框留空即可复用文件里的口令（渲染进程只被告知"已保存"，拿不到明文）
  await wc.executeJavaScript(`document.querySelector('#profile-list .profile-open').click()`);
  const reuseHint = await wc.executeJavaScript('document.getElementById("form-hint").textContent');
  check('编辑已保存连接时提示复用已存口令', reuseHint.includes('已保存'), `hint=${reuseHint}`);
  await wc.executeJavaScript('document.getElementById("btn-cancel").click()');

  // 9) 关闭窗口后应用应当能正常退出
  const stillAlive = BrowserWindow.getAllWindows().length;
  check('窗口仍然存活（未崩溃）', stillAlive === 1, `windows=${stillAlive}`);
}

const timeout = setTimeout(() => {
  console.log('FAIL  冒烟验证整体超时（90s）');
  app.exit(1);
}, 90000);

app.whenReady().then(async () => {
  try {
    // 让主进程的 whenReady 先跑完（它负责装菜单、建窗）
    await sleep(300);
    await run();
    clearTimeout(timeout);
    const failed = results.filter((r) => !r.ok);
    console.log(`\n通过 ${results.length - failed.length}/${results.length}`);
    app.exit(failed.length === 0 ? 0 : 1);
  } catch (err) {
    clearTimeout(timeout);
    console.log(`FAIL  冒烟异常: ${err.message}`);
    app.exit(1);
  }
});
