import { existsSync } from 'node:fs';
import { ConfigError } from '../errors';

export interface ShellCandidate {
  path: string;
  args: string[];
  label: string;
}

/**
 * 本地 Shell 必须解析成绝对路径后再交给 node-pty。
 *
 * 原因（本机实测）：node-pty 对相对文件名会走自己的 PATH 查找，而它的实现只在
 * `Path` 环境变量里逐段拼接查找。当目标 shell 不在 PATH 中（例如 Windows 的
 * powershell.exe 实际位于 System32\WindowsPowerShell\v1.0，该目录默认不在 PATH 里）
 * 就会抛 `File not found:`。自己解析可以给出明确错误，也不依赖 PATH 配置。
 */

export function windowsShellCandidates(): ShellCandidate[] {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  return [
    {
      path: `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
      args: ['-NoLogo'],
      label: 'Windows PowerShell',
    },
    { path: `${programFiles}\\PowerShell\\7\\pwsh.exe`, args: ['-NoLogo'], label: 'PowerShell 7' },
    { path: `${programFilesX86}\\PowerShell\\7\\pwsh.exe`, args: ['-NoLogo'], label: 'PowerShell 7 (x86)' },
    { path: `${systemRoot}\\System32\\cmd.exe`, args: [], label: 'Command Prompt' },
  ];
}

export function unixShellCandidates(): ShellCandidate[] {
  const envShell = process.env.SHELL;
  const candidates: ShellCandidate[] = [];
  if (envShell) candidates.push({ path: envShell, args: ['-l'], label: envShell });
  candidates.push({ path: '/bin/bash', args: ['-l'], label: 'bash' });
  candidates.push({ path: '/bin/sh', args: [], label: 'sh' });
  return candidates;
}

export function shellCandidates(platform: NodeJS.Platform = process.platform): ShellCandidate[] {
  return platform === 'win32' ? windowsShellCandidates() : unixShellCandidates();
}

/** 显式指定优先；未指定或不存在时按候选列表回退，全部失败则报错。 */
export function resolveShell(
  explicitPath?: string,
  platform: NodeJS.Platform = process.platform,
): ShellCandidate {
  if (explicitPath) {
    if (!existsSync(explicitPath)) {
      throw new ConfigError(`指定的 shell 不存在: ${explicitPath}`);
    }
    const known = shellCandidates(platform).find((c) => c.path.toLowerCase() === explicitPath.toLowerCase());
    return known ?? { path: explicitPath, args: [], label: explicitPath };
  }

  const found = shellCandidates(platform).find((c) => existsSync(c.path));
  if (!found) {
    throw new ConfigError(`未找到可用的本地 shell，候选路径均已尝试: ${shellCandidates(platform).map((c) => c.path).join(', ')}`);
  }
  return found;
}