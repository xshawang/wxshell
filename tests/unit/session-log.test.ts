import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionLogWriter, sanitizeFileName, stripAnsi } from '../../src/core/logging/SessionLog';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';

let dir: string;

beforeEach(() => {
  dir = makeTmpDir('sessionlog-');
});
afterEach(() => removeTmpDir(dir));

describe('stripAnsi', () => {
  it('剥离颜色序列', () => {
    expect(stripAnsi('\u001b[32mok\u001b[0m')).toBe('ok');
  });
  it('剥离光标控制', () => {
    expect(stripAnsi('\u001b[2J\u001b[Hclean')).toBe('clean');
  });
  it('保留普通文本', () => {
    expect(stripAnsi('plain text')).toBe('plain text');
  });
  it('剥离真彩序列', () => {
    expect(stripAnsi('\u001b[38;2;255;0;0mred\u001b[0m')).toBe('red');
  });
});

describe('sanitizeFileName', () => {
  it('替换 Windows 非法字符', () => {
    expect(sanitizeFileName('a<b>c:d"e/f\\g|h?i*j')).toBe('a_b_c_d_e_f_g_h_i_j');
  });
  it('空名字回退为 session', () => {
    expect(sanitizeFileName('   ')).toBe('session');
  });
  it('去掉前导点避免隐藏文件', () => {
    expect(sanitizeFileName('...hidden')).toBe('hidden');
  });
  it('超长名字被截断', () => {
    expect(sanitizeFileName('x'.repeat(500)).length).toBeLessThanOrEqual(120);
  });
});

describe('SessionLogWriter', () => {
  it('写出 raw / idx / text 三个文件', async () => {
    const writer = new SessionLogWriter({ dir, name: 'web-01', text: true, now: () => new Date('2026-10-06T12:00:00Z') });
    writer.write(Buffer.from('\u001b[31mhello\u001b[0m\r\n'));
    writer.write(Buffer.from('world\r\n'));
    await writer.close();

    expect(existsSync(writer.rawPath)).toBe(true);
    expect(existsSync(writer.indexPath)).toBe(true);
    expect(existsSync(writer.textPath!)).toBe(true);
  });

  it('raw 保留原始字节（含转义序列）', async () => {
    const writer = new SessionLogWriter({ dir, name: 'raw', now: () => new Date('2026-10-06T12:00:00Z') });
    const payload = Buffer.from('\u001b[31mhello\u001b[0m');
    writer.write(payload);
    await writer.close();

    expect(readFileSync(writer.rawPath).equals(payload)).toBe(true);
  });

  it('idx 记录字节偏移与时间戳，可用于回放定位', async () => {
    const writer = new SessionLogWriter({ dir, name: 'idx', now: () => new Date('2026-10-06T12:00:00Z') });
    writer.write(Buffer.from('abcde')); // offset 0
    writer.write(Buffer.from('fghij')); // offset 5
    await writer.close();

    const lines = readFileSync(writer.indexPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]!.startsWith('0 ')).toBe(true);
    expect(lines[1]!.startsWith('5 ')).toBe(true);
  });

  it('text 文件已剥离 ANSI', async () => {
    const writer = new SessionLogWriter({ dir, name: 'text', text: true, now: () => new Date('2026-10-06T12:00:00Z') });
    writer.write(Buffer.from('\u001b[32mcolored\u001b[0m'));
    await writer.close();

    expect(readFileSync(writer.textPath!, 'utf8')).toBe('colored');
  });

  it('bytesWritten 累计正确', async () => {
    const writer = new SessionLogWriter({ dir, name: 'bytes', now: () => new Date('2026-10-06T12:00:00Z') });
    writer.write(Buffer.alloc(10));
    writer.write(Buffer.alloc(32));
    expect(writer.bytesWritten).toBe(42);
    await writer.close();
  });

  it('空 chunk 不写索引行', async () => {
    const writer = new SessionLogWriter({ dir, name: 'empty', now: () => new Date('2026-10-06T12:00:00Z') });
    writer.write(Buffer.alloc(0));
    writer.write(Buffer.from('x'));
    await writer.close();

    const lines = readFileSync(writer.indexPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
  });

  it('close 幂等', async () => {
    const writer = new SessionLogWriter({ dir, name: 'idem', now: () => new Date('2026-10-06T12:00:00Z') });
    writer.write(Buffer.from('x'));
    await writer.close();
    await expect(writer.close()).resolves.toBeUndefined();
  });

  it('不同会话产生不同文件（时间戳区分）', async () => {
    const w1 = new SessionLogWriter({ dir, name: 'a', now: () => new Date('2026-10-06T12:00:00Z') });
    await w1.close();
    const w2 = new SessionLogWriter({ dir, name: 'b', now: () => new Date('2026-10-06T12:00:01Z') });
    await w2.close();

    expect(readdirSync(dir).filter((f) => f.startsWith('a-') && f.endsWith('.raw'))).toHaveLength(1);
    expect(readdirSync(dir).filter((f) => f.startsWith('b-') && f.endsWith('.raw'))).toHaveLength(1);
    // 名字不同即文件不同，不会互相覆盖
    expect(readdirSync(dir).filter((f) => f.endsWith('.raw'))).toHaveLength(2);
  });
});