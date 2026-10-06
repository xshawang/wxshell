/**
 * 打包脚本：固定好下载镜像后调用 electron-builder。
 *
 * 为什么用脚本而不是直接写进 npm script：
 *  - electron-builder 的辅助二进制（winCodeSign / nsis）不走 electronDownload 配置，
 *    只认环境变量 ELECTRON_BUILDER_BINARIES_MIRROR；
 *  - Windows 上 npm script 里写 `VAR=x cmd` 需要 cross-env，多一个依赖。
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// electron-builder 在 Windows 上靠 `powershell.exe` 调 npm 收集生产依赖树，
// 而本机 PATH 里没有 WindowsPowerShell\v1.0（默认应有该目录），会 spawn ENOENT。
const psDir = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0');

const env = {
  ...process.env,
  PATH: `${existsSync(psDir) ? `${psDir};` : ''}${process.env.PATH ?? ''}`,
  // 本机 GitHub releases 不可达，走 npmmirror（已验证可直连）
  ELECTRON_MIRROR: 'https://npmmirror.com/mirrors/electron/',
  ELECTRON_BUILDER_BINARIES_MIRROR: 'https://npmmirror.com/mirrors/electron-builder-binaries/',
  // 需要代理时通过 PROXY_URL 注入，例如 PROXY_URL=http://127.0.0.1:7890
  ...(process.env.PROXY_URL
    ? { HTTPS_PROXY: process.env.PROXY_URL, HTTP_PROXY: process.env.PROXY_URL }
    : {}),
};

const args = process.argv.slice(2);
const target = args.length > 0 ? args : ['--win', 'portable', '--x64'];

console.log(`electron-builder ${target.join(' ')}`);
// 直接跑 electron-builder 的 JS 入口，不经 npx/.cmd：
// Node 18.20+ 起不允许无 shell 地 spawn .cmd（CVE-2024-27980 的修复），
// 走 JS 入口既能绕开这个限制，也不依赖 PATH。
const cli = join(root, 'node_modules', 'electron-builder', 'cli.js');
const result = spawnSync(process.execPath, [cli, ...target], { cwd: root, env, stdio: 'inherit' });

if (result.error) {
  console.error(`无法启动 electron-builder: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
