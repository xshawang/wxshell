import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * 原子写入。用于会话配置、known_hosts、保险库这些"写坏就等于丢数据"的文件。
 * 直接 writeFileSync 在中途崩溃/断电时会留下截断的 JSON，下次启动直接解析失败。
 * 做法是写临时文件 → fsync → rename 覆盖，rename 在同一文件系统上是原子的。
 */
export function writeFileAtomicSync(path: string, content: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  const data = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;

  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  try {
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // 清理失败不影响主错误
    }
    throw err;
  }
}

export function readJsonFileSync<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  const raw = readFileSync(path, 'utf8');
  if (raw.trim() === '') return fallback;
  return JSON.parse(raw) as T;
}

export function writeJsonAtomicSync(path: string, value: unknown): void {
  writeFileAtomicSync(path, `${JSON.stringify(value, null, 2)}\n`);
}