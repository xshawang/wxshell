import { describe, expect, it } from 'vitest';
import { resolveShell, shellCandidates } from '../../src/core/shell/resolveShell';
import { ConfigError } from '../../src/core/errors';

describe('resolveShell - 候选列表', () => {
  it('Windows 候选里包含 PowerShell 的绝对路径', () => {
    const list = shellCandidates('win32');
    const ps = list.find((c) => c.path.endsWith('powershell.exe'));
    expect(ps).toBeDefined();
    // 关键：必须是绝对路径。powershell.exe 所在目录默认不在 PATH 中，
    // 交给 node-pty 自己按 PATH 查找会抛 "File not found:"
    expect(ps!.path).toContain('WindowsPowerShell');
    expect(ps!.path).toMatch(/^[A-Za-z]:\\/);
  });

  it('Unix 候选包含 bash 与 sh', () => {
    const list = shellCandidates('linux');
    expect(list.some((c) => c.path === '/bin/bash')).toBe(true);
    expect(list.some((c) => c.path === '/bin/sh')).toBe(true);
  });
});

describe('resolveShell - 解析行为', () => {
  it('显式指定存在的路径时使用该路径', () => {
    const explicit = shellCandidates(process.platform).find((c) => c.path);
    const resolved = resolveShell(explicit!.path);
    expect(resolved.path).toBe(explicit!.path);
  });

  it('显式指定不存在的路径时抛 ConfigError', () => {
    expect(() => resolveShell('C:\\definitely\\not\\here\\shell.exe')).toThrow(ConfigError);
  });

  it('本机可解析出一个真实存在的 shell', () => {
    const resolved = resolveShell();
    expect(resolved.path).toBeTruthy();
    expect(resolved.label).toBeTruthy();
  });
});