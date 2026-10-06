import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * 配置目录解析。
 *
 * 目标：连接配置默认放在"安装目录下的 config 文件夹"，便携版整个目录拷走时配置跟着走。
 *
 * 安装目录由 `app.getAppPath()` 区分：
 *   打包态  .../resources/app.asar  -> 再上两级就是安装目录
 *   开发态  `electron .` 时它就是项目根
 * 安装目录不可写（例如装在 Program Files）时退回 userData，不静默写到别的地方。
 */

export const CONFIG_DIR_NAME = 'config';

export interface ConfigDirInput {
  /** electron-builder portable 目标注入的 PORTABLE_EXECUTABLE_DIR，即 exe 实际所在目录 */
  portableDir?: string;
  /** app.getAppPath() */
  appPath: string;
  /** 兜底：app.getPath('userData') */
  fallbackDir: string;
  /** 显式覆盖：环境变量 NODE_XSHELL_CONFIG_DIR */
  override?: string;
}

export type ConfigDirSource = 'override' | 'portable' | 'install' | 'fallback';

export interface ConfigDirResult {
  dir: string;
  source: ConfigDirSource;
  /** 落到非首选位置时的说明，交给调用方记日志 */
  note?: string;
}

export interface ConfigPaths {
  root: string;
  sessions: string;
  folders: string;
  knownHosts: string;
  auditLog: string;
  logs: string;
}

/** 打包态 app.asar 的祖父目录即安装目录；开发态 getAppPath() 本身就是项目根。 */
export function installDirOf(appPath: string): string {
  return appPath.endsWith('.asar') ? dirname(dirname(appPath)) : appPath;
}

/**
 * 真的写一个临时文件再删掉。
 * 不用 fs.accessSync(W_OK)：Windows 上它只看只读属性、反映不了 ACL，
 * 装在 Program Files 时会误判成可写，然后在第一次保存会话时才炸。
 */
export function probeWritable(dir: string): boolean {
  const probe = join(dir, `.write-probe-${process.pid}`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(probe, '');
    return true;
  } catch {
    return false;
  } finally {
    try {
      rmSync(probe, { force: true });
    } catch {
      // 探测文件删不掉不影响判断结果
    }
  }
}

/** 按优先级挑第一个可写的配置目录。 */
export function resolveConfigDir(input: ConfigDirInput): ConfigDirResult {
  const preferred: ConfigDirResult = input.override?.trim()
    ? { dir: resolve(input.override), source: 'override' }
    : input.portableDir?.trim()
      ? { dir: join(input.portableDir, CONFIG_DIR_NAME), source: 'portable' }
      : { dir: join(installDirOf(input.appPath), CONFIG_DIR_NAME), source: 'install' };

  if (probeWritable(preferred.dir)) return preferred;

  const fallbackDir = join(input.fallbackDir, CONFIG_DIR_NAME);
  return {
    dir: fallbackDir,
    source: 'fallback',
    note: `配置目录 ${preferred.dir} 不可写，已改用 ${fallbackDir}`,
  };
}

/** 配置目录下的固定布局，集中在一处避免各处硬编码文件名。 */
export function configPaths(dir: string): ConfigPaths {
  return {
    root: dir,
    sessions: join(dir, 'sessions'),
    folders: join(dir, 'folders.json'),
    knownHosts: join(dir, 'known_hosts.json'),
    auditLog: join(dir, 'audit.jsonl'),
    logs: join(dir, 'logs'),
  };
}