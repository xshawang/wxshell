import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import type { SFTPWrapper } from 'ssh2';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SftpClient } from '../../src/core/transfer/SftpClient';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';

/**
 * SftpClient 的行为测试。
 *
 * 说明：ssh2 只提供 SFTP 客户端，没有服务端实现，本机也没有 sshd（已验证），
 * 因此这里用替身验证 SftpClient 自身的逻辑：目录映射、进度、断点续传、取消。
 * SFTP 的**线路层**（真实协议编解码）不在本测试覆盖范围内，这一点在报告里明确列出。
 */

interface FakeEntry {
  filename: string;
  longname: string;
  attrs: { size: number; mode: number; mtime: number };
}

class FakeSftp {
  files = new Map<string, Buffer>();
  dirs = new Map<string, FakeEntry[]>();
  calls: string[] = [];
  closed = false;

  readdir(path: string, cb: (err: Error | null, list?: FakeEntry[]) => void): void {
    this.calls.push(`readdir:${path}`);
    cb(null, this.dirs.get(path) ?? []);
  }

  stat(path: string, cb: (err: Error | null, stats?: FakeEntry['attrs']) => void): void {
    this.calls.push(`stat:${path}`);
    const file = this.files.get(path);
    if (!file) {
      cb(Object.assign(new Error(`ENOENT: ${path}`), { code: 2 }));
      return;
    }
    cb(null, { size: file.length, mode: 0o100644, mtime: 1700000000 });
  }

  createReadStream(path: string, opts: { start?: number } = {}): Readable {
    const file = this.files.get(path);
    if (!file) throw new Error(`ENOENT: ${path}`);
    const start = opts.start ?? 0;
    // 分片推送，模拟真实网络下的多次 data 事件
    const chunkSize = 4;
    let cursor = start;
    return new Readable({
      read(): void {
        if (cursor >= file.length) {
          this.push(null);
          return;
        }
        const end = Math.min(cursor + chunkSize, file.length);
        this.push(file.subarray(cursor, end));
        cursor = end;
      },
    });
  }

  createWriteStream(path: string, opts: { flags?: string } = {}): Writable {
    const append = opts.flags === 'a';
    const parts: Buffer[] = append ? [this.files.get(path) ?? Buffer.alloc(0)] : [];
    return new Writable({
      write: (chunk: Buffer, _enc, done) => {
        parts.push(Buffer.from(chunk));
        done();
      },
      final: (done) => {
        this.files.set(path, Buffer.concat(parts));
        done();
      },
    });
  }

  mkdir(path: string, _attrs: unknown, cb: (err: Error | null) => void): void {
    this.calls.push(`mkdir:${path}`);
    this.dirs.set(path, []);
    cb(null);
  }

  rmdir(path: string, cb: (err: Error | null) => void): void {
    this.calls.push(`rmdir:${path}`);
    this.dirs.delete(path);
    cb(null);
  }

  unlink(path: string, cb: (err: Error | null) => void): void {
    this.calls.push(`unlink:${path}`);
    this.files.delete(path);
    cb(null);
  }

  rename(from: string, to: string, cb: (err: Error | null) => void): void {
    this.calls.push(`rename:${from}->${to}`);
    const file = this.files.get(from);
    if (file) {
      this.files.set(to, file);
      this.files.delete(from);
    }
    cb(null);
  }

  chmod(path: string, mode: number, cb: (err: Error | null) => void): void {
    this.calls.push(`chmod:${path}:${mode.toString(8)}`);
    cb(null);
  }

  readFile(path: string, cb: (err: Error | null, data?: Buffer) => void): void {
    cb(null, this.files.get(path) ?? Buffer.alloc(0));
  }

  writeFile(path: string, data: Buffer, cb: (err: Error | null) => void): void {
    this.files.set(path, Buffer.from(data));
    cb(null);
  }

  end(): void {
    this.closed = true;
  }
}

let dir: string;
let fake: FakeSftp;
let client: SftpClient;

beforeEach(async () => {
  dir = makeTmpDir('sftp-');
  fake = new FakeSftp();
  client = new SftpClient(async () => fake as unknown as SFTPWrapper);
  await client.connect();
});

afterEach(() => removeTmpDir(dir));

describe('SftpClient - 目录与属性', () => {
  it('list 映射目录/文件/链接标志', async () => {
    fake.dirs.set('/var/log', [
      { filename: 'nginx', longname: 'drwxr-xr-x nginx', attrs: { size: 4096, mode: 0o040755, mtime: 1700000000 } },
      { filename: 'app.log', longname: '-rw-r--r-- app.log', attrs: { size: 1234, mode: 0o100644, mtime: 1700000000 } },
      { filename: 'link', longname: 'lrwxrwxrwx link', attrs: { size: 11, mode: 0o120777, mtime: 1700000000 } },
    ]);

    const entries = await client.list('/var/log');
    expect(entries).toHaveLength(3);
    expect(entries[0]!.isDirectory).toBe(true);
    expect(entries[0]!.isFile).toBe(false);
    expect(entries[1]!.isFile).toBe(true);
    expect(entries[1]!.size).toBe(1234);
    expect(entries[2]!.isSymlink).toBe(true);
    expect(entries[2]!.mtimeMs).toBe(1700000000000);
  });

  it('stat 返回文件大小', async () => {
    fake.files.set('/tmp/a.bin', Buffer.alloc(258));
    const entry = await client.stat('/tmp/a.bin');
    expect(entry.size).toBe(258);
  });

  it('stat 不存在的文件抛出', async () => {
    await expect(client.stat('/nope')).rejects.toThrow(/ENOENT/);
  });
});

describe('SftpClient - 下载', () => {
  it('下载完整文件并上报进度', async () => {
    const payload = Buffer.from('0123456789ABCDEF');
    fake.files.set('/remote/data.bin', payload);
    const local = join(dir, 'data.bin');

    const progress: number[] = [];
    const result = await client.download('/remote/data.bin', local, {
      onProgress: (p) => progress.push(p.transferred),
    });

    expect(readFileSync(local).equals(payload)).toBe(true);
    expect(result.bytes).toBe(payload.length);
    expect(result.resumedFrom).toBe(0);
    expect(progress.at(-1)).toBe(payload.length);
    // 进度单调不减
    for (let i = 1; i < progress.length; i += 1) expect(progress[i]!).toBeGreaterThanOrEqual(progress[i - 1]!);
  });

  it('resume 从本地已有长度续传并得到完整文件', async () => {
    const payload = Buffer.from('0123456789ABCDEF');
    fake.files.set('/remote/data.bin', payload);
    const local = join(dir, 'partial.bin');
    writeFileSync(local, payload.subarray(0, 6));

    const result = await client.download('/remote/data.bin', local, { resume: true });

    expect(result.resumedFrom).toBe(6);
    expect(result.bytes).toBe(payload.length - 6);
    expect(readFileSync(local).equals(payload)).toBe(true);
  });

  it('本地比远端更长时从头下载（避免拼出损坏文件）', async () => {
    const payload = Buffer.from('short');
    fake.files.set('/remote/s.bin', payload);
    const local = join(dir, 'longer.bin');
    writeFileSync(local, Buffer.alloc(100, 0x41));

    const result = await client.download('/remote/s.bin', local, { resume: true });
    expect(result.resumedFrom).toBe(0);
    expect(readFileSync(local).equals(payload)).toBe(true);
  });

  it('下载前已被取消的 signal 直接拒绝', async () => {
    fake.files.set('/remote/x', Buffer.from('abc'));
    const controller = new AbortController();
    controller.abort();

    await expect(
      client.download('/remote/x', join(dir, 'x'), { signal: controller.signal }),
    ).rejects.toThrow(/取消/);
  });
});

describe('SftpClient - 上传', () => {
  it('上传本地文件到远端', async () => {
    const payload = Buffer.from('upload-content');
    const local = join(dir, 'up.bin');
    writeFileSync(local, payload);

    const result = await client.upload(local, '/remote/up.bin');
    expect(fake.files.get('/remote/up.bin')!.equals(payload)).toBe(true);
    expect(result.bytes).toBe(payload.length);
  });

  it('resume 时从远端已有长度继续', async () => {
    const payload = Buffer.from('0123456789');
    const local = join(dir, 'up2.bin');
    writeFileSync(local, payload);
    fake.files.set('/remote/up2.bin', payload.subarray(0, 4));

    const result = await client.upload(local, '/remote/up2.bin', { resume: true });
    expect(result.resumedFrom).toBe(4);
    expect(fake.files.get('/remote/up2.bin')!.equals(payload)).toBe(true);
  });

  it('远端不存在时 resume 退化为全新上传', async () => {
    const local = join(dir, 'up3.bin');
    writeFileSync(local, Buffer.from('fresh'));
    const result = await client.upload(local, '/remote/up3.bin', { resume: true });
    expect(result.resumedFrom).toBe(0);
    expect(fake.files.get('/remote/up3.bin')!.toString()).toBe('fresh');
  });
});

describe('SftpClient - 其它操作', () => {
  it('mkdir / rmdir / unlink / rename / chmod 正确委派', async () => {
    fake.files.set('/a', Buffer.from('x'));

    await client.mkdir('/newdir', 0o750);
    await client.rename('/a', '/b');
    await client.chmod('/b', 0o600);
    await client.unlink('/b');
    await client.rmdir('/newdir');

    expect(fake.calls).toContain('mkdir:/newdir');
    expect(fake.calls).toContain('rename:/a->/b');
    expect(fake.calls).toContain('chmod:/b:600');
    expect(fake.files.has('/b')).toBe(false);
    expect(fake.dirs.has('/newdir')).toBe(false);
  });

  it('readFile / writeFile 往返', async () => {
    await client.writeFile('/cfg', 'hello');
    expect((await client.readFile('/cfg')).toString()).toBe('hello');
  });

  it('close 后调用操作会抛错而不是静默失败', async () => {
    await client.close();
    expect(fake.closed).toBe(true);
    await expect(client.list('/')).rejects.toThrow(/尚未建立/);
  });

  it('未 connect 就调用操作会抛错', async () => {
    const fresh = new SftpClient(async () => fake as unknown as SFTPWrapper);
    await expect(fresh.stat('/x')).rejects.toThrow(/尚未建立/);
  });
});