# node-xshell

Xshell 类终端客户端的 Node.js/Electron 实现。设计依据见 `../Documents/本地/xshell-node-架构方案.md`（v1）。

## 现状

已实现并经过验证的部分：

| 层 | 内容 | 验证方式 |
|---|---|---|
| 传输 | SSH（口令 / 公钥 / Keyboard-Interactive / Agent）、Telnet（RFC 854/855/857/1073/1091）、本地 Shell（ConPTY）、裸 TCP | 集成测试跑真实 socket / 真实 PTY |
| 隧道 | 本地转发 `-L`、远端转发 `-R`、动态转发 `-D`（自实现 SOCKS5 服务端）、ProxyJump 多级跳板 + 连接复用池 | 集成测试（`-R` 用模拟远端，见"未验证"） |
| 存储 | 连接与文件夹：**一个连接一个配置文件**（`config/sessions/<id>.json`，配置与口令同文件）、known_hosts（TOFU，指纹变更默认阻断）、审计 JSONL、会话日志 `.raw/.tsv` | 单元测试 + 集成测试 |
| 凭据 | scrypt KEK + AES-256-GCM + 每条目独立 DEK 的保险库 | 单元测试 |
| 终端 | xterm.js 6 + WebGL（失败回退 DOM）+ 宽字符 + 10 万行回滚 + 搜索 + 8 项 addon | Electron 冒烟验证 |
| 背压 | 高低水位 + ack 消费回报，`cat` 大文件不会撑爆内存 | 集成测试（真实暂停/恢复） |
| 应用外壳 | Electron 主进程 / preload 白名单 / 渲染进程标签页 / 左侧连接树（文件夹 + 连接）/ 文件菜单 | Electron 冒烟验证（18 项） |

尚未实现（对应方案的后续里程碑）：SFTP 面板与拖拽传输（M3 起）、ZMODEM/trzsz 传输状态机（只做了魔数嗅探）、串口、触发器与 JS 沙箱脚本、日志回放的 UI、多窗口/平铺、主题市场、打包签名与自动更新、E2E（Playwright）。

## 命令

```bash
npm install --ignore-scripts      # node-pty 用自带预编译产物，不需要 node-gyp
npx electron --version            # 需要 Electron 44.5.1 二进制（见"本机注意事项"）

npm run typecheck                 # tsc --noEmit，包含 tests/
npm test                          # vitest run：236 个用例（单元 + 集成）
npm run build                     # 主进程/preload (tsc) + 渲染进程 (esbuild)
npm run smoke                     # 真实 Electron 跑一遍主进程+preload+渲染进程+PTY 链路
npm start                         # 构建并启动应用
npm run dist                      # 打包成单个便携 exe（见"打包"）
npm run dist:dir                  # 只产出解包目录，用来排查打包问题
```

连接配置默认落在**安装目录下的 `config/`**，详见"连接与配置"。

## 连接与配置

左侧是连接树：`文件 → 新建连接…`（Ctrl+N）加连接，`文件 → 新建文件夹…`（Ctrl+Shift+N）加文件夹，
文件夹行上的「＋连接」把新连接建在该文件夹里；`文件 → 打开配置目录` 直接打开配置所在目录。

磁盘布局（**一个连接一个配置文件**，单个文件坏掉只丢那一条，不会拖垮启动）：

```
config/
  folders.json           文件夹树
  sessions/<uuid>.json   每个连接一份：profile（主机/端口/用户名/认证方式…）+ secrets（口令）
  known_hosts.json       主机指纹（TOFU）
  audit.jsonl            审计
  logs/                  会话日志 .raw/.tsv
```

配置目录按优先级解析（实现见 `src/core/store/configDir.ts`，有单元测试覆盖）：

1. 环境变量 `NODE_XSHELL_CONFIG_DIR`（测试、多套配置并存时用，冒烟验证就走这条）
2. 便携版：`PORTABLE_EXECUTABLE_DIR/config`，也就是 exe 所在目录
3. 安装目录：打包态取 `app.asar` 的祖父目录，开发态取项目根
4. 前几条都写不进去时（例如装在 `Program Files`）退回 `%APPDATA%/node-xshell/config` 并打日志

**口令是明文保存的**，与连接配置写在同一个文件的 `secrets` 段——这是"整份配置文件拷到哪都能用"的前提。
对话框里的「口令写入会话文件（明文保存）」可以取消，那样只存连接、每次连接手输。
口令输入框留空表示"用文件里已保存的那条"，不会把它清掉。
文件的安全性依赖操作系统对该目录的权限，别把配置目录放到共享位置。

## 打包

`npm run dist` 产出 `release/node-xshell-0.1.0-portable.exe`（约 98MB，单文件、不写注册表、双击即运行）。
Electron 与 NSIS 辅助二进制走 npmmirror 镜像（本机 GitHub releases 不可达），由 `scripts/package.mjs` 固定。

- 连接配置跟着 exe 走：便携版用 `PORTABLE_EXECUTABLE_DIR/config`，实测双击运行后配置目录建在 exe 同级。Electron 自身的缓存（GPU / Code Cache）仍在 `%APPDATA%/node-xshell/`，那是 Chromium 的既定行为，与连接数据无关。
- `npmRebuild: false`：node-pty 的 `prebuilds/` 是 N-API 构建（ABI 稳定），Electron 直接加载即可，不必按 Electron ABI 重编译。
- `asarUnpack` 必须包含整个 `node-pty`：asar 内的 `.node` / `.dll` / `.exe` 无法 dlopen / CreateProcess。已验证打包后能真实拉起 ConPTY。
- 打包工具链需要 **Node ≥ 22.12**：`electron-builder` 的依赖 `@noble/hashes@2` 是 ESM-only，而 `app-builder-lib` 用 `require()` 加载它，低版本 Node 直接抛 `ERR_REQUIRE_ESM`。
- 产物未签名：首次运行会被 SmartScreen 拦一次（"更多信息"→"仍要运行"）；图标是 Electron 默认图标（未提供 `build/icon.ico`）。对外分发前两者都要补。

## 目录

```
src/core/        与 Electron 无关的核心库（可单独复用、可被 vitest 直接测）
src/main/        主进程：窗口、IPC、会话管理装配
src/preload/     contextBridge 白名单
src/renderer/    xterm.js 界面（esbuild 打成浏览器 bundle）
src/shared/      三端共享的 IPC 类型契约
tests/unit/      单元测试
tests/integration/ 集成测试（真实 socket / 真实 PTY / 进程内 sshd 夹具）
scripts/smoke.js Electron 冒烟验证（18 项）
config/          运行期配置：开发态在项目根，打包后与 exe 同级
```

## 安全边界

- 渲染进程：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`、禁用 `webview`、CSP 只允许本地脚本与样式；preload 只暴露白名单方法，不暴露 `ipcRenderer` 本身。
- 口令**明文保存在连接配置文件里**（`config/sessions/*.json` 的 `secrets` 段，见"连接与配置"），不打进日志与错误堆栈；渲染进程对口令只写不读——已保存的口令永远不回传到窗口，输入框留空即沿用文件里那条。
- 主机指纹首次连接 TOFU 需显式确认；指纹变更默认阻断，只有显式选择"替换"才放行，并写审计。
- 不包含任何 NetSarang 的二进制、资源或图标。

## 本机注意事项（实测，非推测）

- **Windows PowerShell 5.1 在 ConPTY 下不可用**：`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` 作为 PTY 子进程启动时会被本机环境保护机制拦成交互式确认提示（"从不运行/不运行/运行一次/始终运行"），无法脚本化；同一个 exe 由普通子进程启动则正常。新建本地终端时请在"Shell 路径"里显式填写 `C:\Windows\System32\cmd.exe`（或 pwsh）。
- **`@electron/get@5` 是 ESM-only**：Node 20 上跑不了 Electron 的 postinstall，本仓库的 `node_modules/electron/dist` 是手工解压 + 手写 `path.txt` 的；重装 `node_modules` 后要么重做这步，要么在 Node ≥ 22.12 上重试 postinstall。
- **node-pty 关闭 ConPTY 会话时会打印 `Error: AttachConsole failed`**：这是 node-pty 内部分支进程 `conpty_console_list_agent` 在无控制台的宿主里枚举控制台进程失败导致的，属于上游行为，不影响会话关闭（进程确实被杀死）。
- **better-sqlite3 未采用，依赖已移除**：会话与审计改用 JSON 原子写 + JSONL，见 `src/core/store/`；它还需要按 Electron ABI 重编译原生模块，留在 `dependencies` 里只会拖累打包。
- **本机 `%LOCALAPPDATA%\electron-builder` 缓存目录会报 `EXDEV: cross-device link not permitted`**：该目录 ACL 挡住了目录重命名（实测 `%TEMP%`、项目目录下重命名正常，EFS 加密已排除），electron-builder 解压辅助二进制时依赖"临时目录改名"这一步。把缓存挪到不受限的目录即可：`$env:ELECTRON_BUILDER_CACHE='C:\Users\wrong\.cache\electron-builder'`（`scripts/package.mjs` 会原样透传环境变量）。另：本机 PATH 里缺 `System32\WindowsPowerShell\v1.0`，而 electron-builder 要用 `powershell.exe` 调 npm 收集依赖树，`scripts/package.mjs` 已把该目录补进子进程 PATH。
