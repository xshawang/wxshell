import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CONFIG_DIR_NAME,
  configPaths,
  installDirOf,
  probeWritable,
  resolveConfigDir,
} from '../../src/core/store/configDir';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';

let tmp: string;

beforeEach(() => {
  tmp = makeTmpDir('config-dir-');
});
afterEach(() => removeTmpDir(tmp));

describe('installDirOf - 安装目录推导', () => {
  it('打包态：app.asar 的祖父目录就是安装目录', () => {
    expect(installDirOf('E:\\app\\resources\\app.asar')).toBe('E:\\app');
  });

  it('开发态：getAppPath() 本身就是项目根', () => {
    expect(installDirOf('E:\\work\\node-xshell')).toBe('E:\\work\\node-xshell');
  });
});

describe('probeWritable - 真实写盘探测', () => {
  it('可写目录返回 true 并顺手建出来', () => {
    const dir = join(tmp, 'new-dir');
    expect(probeWritable(dir)).toBe(true);
    expect(existsSync(dir)).toBe(true);
  });

  it('路径被同名文件占住时返回 false', () => {
    const blocked = join(tmp, 'blocked');
    writeFileSync(blocked, 'x');
    expect(probeWritable(blocked)).toBe(false);
  });

  it('探测不留残留文件', () => {
    const dir = join(tmp, 'clean');
    expect(probeWritable(dir)).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('resolveConfigDir - 优先级', () => {
  it('显式覆盖优先于一切', () => {
    const override = join(tmp, 'explicit');
    const result = resolveConfigDir({
      override,
      portableDir: join(tmp, 'portable'),
      appPath: join(tmp, 'install'),
      fallbackDir: join(tmp, 'userdata'),
    });
    expect(result.dir).toBe(override);
    expect(result.source).toBe('override');
  });

  it('便携版：配置目录在 exe 同级目录下', () => {
    const portableDir = join(tmp, 'portable');
    mkdirSync(portableDir, { recursive: true });
    const result = resolveConfigDir({
      portableDir,
      appPath: 'E:\\app\\resources\\app.asar',
      fallbackDir: join(tmp, 'userdata'),
    });
    expect(result.dir).toBe(join(portableDir, CONFIG_DIR_NAME));
    expect(result.source).toBe('portable');
  });

  it('开发态：配置目录在项目根下', () => {
    const project = join(tmp, 'project');
    mkdirSync(project, { recursive: true });
    const result = resolveConfigDir({ appPath: project, fallbackDir: join(tmp, 'userdata') });
    expect(result.dir).toBe(join(project, CONFIG_DIR_NAME));
    expect(result.source).toBe('install');
  });

  it('安装目录不可写时退回 userData，并给出说明', () => {
    const project = join(tmp, 'ro-project');
    mkdirSync(project, { recursive: true });
    // 用同名文件占住 <project>/config，模拟"安装目录写不进去"
    writeFileSync(join(project, CONFIG_DIR_NAME), 'x');

    const fallbackDir = join(tmp, 'userdata');
    const result = resolveConfigDir({ appPath: project, fallbackDir });

    expect(result.dir).toBe(join(fallbackDir, CONFIG_DIR_NAME));
    expect(result.source).toBe('fallback');
    expect(result.note).toContain(join(project, CONFIG_DIR_NAME));
  });
});

describe('configPaths - 目录布局', () => {
  it('会话是目录、其余是文件', () => {
    const dir = join(tmp, 'cfg');
    const p = configPaths(dir);
    expect(p.root).toBe(dir);
    expect(p.sessions).toBe(join(dir, 'sessions'));
    expect(p.folders).toBe(join(dir, 'folders.json'));
    expect(p.knownHosts).toBe(join(dir, 'known_hosts.json'));
    expect(p.auditLog).toBe(join(dir, 'audit.jsonl'));
    expect(p.logs).toBe(join(dir, 'logs'));
  });
});
