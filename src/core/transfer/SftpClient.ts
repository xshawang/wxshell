import { createReadStream, createWriteStream, existsSync, statSync } from 'node:fs';
import type { Readable, Writable } from 'node:stream';
import type { SFTPWrapper, Stats } from 'ssh2';

/**
 * SFTP 封装。
 *
 * 与 `ssh2-sftp-client` 的差别：这里显式支持断点续传与进度回调，
 * 并且把"打开通道"作为注入点，便于测试。
 * 直接用 ssh2 的 sftp() 通道而不是引入额外封装，是为了能精确控制 chunk 与并发。
 */

export interface RemoteEntry {
  name: string;
  longName: string;
  isDirectory: boolean;
  isFile: boolean;
  isSymlink: boolean;
  size: number;
  mode: number;
  mtimeMs: number;
}

export interface SftpProgress {
  transferred: number;
  total: number | null;
  path: string;
}

export interface TransferOptions {
  onProgress?: (progress: SftpProgress) => void;
  /** 续传：本地/远端已存在的部分不重传 */
  resume?: boolean;
  signal?: AbortSignal;
}

export interface TransferResult {
  bytes: number;
  resumedFrom: number;
}

export function mapStats(name: string, stats: Stats, longName = ''): RemoteEntry {
  const mode = stats.mode ?? 0;
  const type = mode & 0o170000;
  return {
    name,
    longName,
    isDirectory: type === 0o040000,
    isFile: type === 0o100000,
    isSymlink: type === 0o120000,
    size: stats.size ?? 0,
    mode,
    mtimeMs: (stats.mtime ?? 0) * 1000,
  };
}

export class SftpClient {
  private sftp: SFTPWrapper | null = null;

  constructor(private readonly openChannel: () => Promise<SFTPWrapper>) {}

  get raw(): SFTPWrapper | null {
    return this.sftp;
  }

  async connect(): Promise<void> {
    this.sftp = await this.openChannel();
  }

  async close(): Promise<void> {
    const sftp = this.sftp;
    this.sftp = null;
    if (!sftp) return;
    await new Promise<void>((resolve) => {
      try {
        sftp.end();
      } catch {
        // 已关闭
      }
      resolve();
    });
  }

  private require(): SFTPWrapper {
    if (!this.sftp) throw new Error('SFTP 通道尚未建立');
    return this.sftp;
  }

  async list(path: string): Promise<RemoteEntry[]> {
    const sftp = this.require();
    const entries = await new Promise<Array<{ filename: string; longname: string; attrs: Stats }>>(
      (resolve, reject) => {
        sftp.readdir(path, (err, list) => (err ? reject(err) : resolve(list)));
      },
    );
    return entries.map((e) => mapStats(e.filename, e.attrs, e.longname));
  }

  async stat(path: string): Promise<RemoteEntry> {
    const sftp = this.require();
    const stats = await new Promise<Stats>((resolve, reject) => {
      sftp.stat(path, (err, s) => (err ? reject(err) : resolve(s)));
    });
    return mapStats(path.split('/').pop() ?? path, stats);
  }

  async mkdir(path: string, mode = 0o755): Promise<void> {
    const sftp = this.require();
    await new Promise<void>((resolve, reject) => {
      sftp.mkdir(path, { mode }, (err) => (err ? reject(err) : resolve()));
    });
  }

  async rmdir(path: string): Promise<void> {
    const sftp = this.require();
    await new Promise<void>((resolve, reject) => {
      sftp.rmdir(path, (err) => (err ? reject(err) : resolve()));
    });
  }

  async unlink(path: string): Promise<void> {
    const sftp = this.require();
    await new Promise<void>((resolve, reject) => {
      sftp.unlink(path, (err) => (err ? reject(err) : resolve()));
    });
  }

  async rename(from: string, to: string): Promise<void> {
    const sftp = this.require();
    await new Promise<void>((resolve, reject) => {
      sftp.rename(from, to, (err) => (err ? reject(err) : resolve()));
    });
  }

  async chmod(path: string, mode: number): Promise<void> {
    const sftp = this.require();
    await new Promise<void>((resolve, reject) => {
      sftp.chmod(path, mode, (err) => (err ? reject(err) : resolve()));
    });
  }

  async readFile(path: string): Promise<Buffer> {
    const sftp = this.require();
    return new Promise<Buffer>((resolve, reject) => {
      sftp.readFile(path, (err, data) => (err ? reject(err) : resolve(data as Buffer)));
    });
  }

  async writeFile(path: string, data: Buffer | string): Promise<void> {
    const sftp = this.require();
    const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    await new Promise<void>((resolve, reject) => {
      sftp.writeFile(path, payload, (err) => (err ? reject(err) : resolve()));
    });
  }

  /** 下载；resume=true 时从本地已有长度继续 */
  async download(remotePath: string, localPath: string, options: TransferOptions = {}): Promise<TransferResult> {
    const sftp = this.require();
    const remoteStat = await this.stat(remotePath);
    const total = remoteStat.size;

    let start = 0;
    if (options.resume && existsSync(localPath)) {
      const localSize = statSync(localPath).size;
      // 本地比远端还长说明是不同版本的文件，从头来过
      start = localSize <= total ? localSize : 0;
    }

    this.throwIfAborted(options.signal);

    // ssh2 的 SFTP 流有自己的类型，不能按 fs.ReadStream 标注
    const readStream = sftp.createReadStream(remotePath, start > 0 ? { start } : {});
    const writeStream = createWriteStream(localPath, { flags: start > 0 ? 'a' : 'w' });

    return this.pipeWithProgress(readStream, writeStream, total, remotePath, start, options);
  }

  /** 上传；resume=true 时从远端已有长度继续 */
  async upload(localPath: string, remotePath: string, options: TransferOptions = {}): Promise<TransferResult> {
    const sftp = this.require();
    const localSize = statSync(localPath).size;

    let start = 0;
    if (options.resume) {
      try {
        const remoteStat = await this.stat(remotePath);
        start = remoteStat.size <= localSize ? remoteStat.size : 0;
      } catch {
        // 远端不存在 -> 全新上传
        start = 0;
      }
    }

    this.throwIfAborted(options.signal);

    const readStream = createReadStream(localPath, start > 0 ? { start } : {});
    const writeStream = sftp.createWriteStream(remotePath, { flags: start > 0 ? 'a' : 'w' });

    return this.pipeWithProgress(readStream, writeStream, localSize, localPath, start, options);
  }

  private pipeWithProgress(
    source: Readable,
    sink: Writable,
    total: number,
    path: string,
    resumedFrom: number,
    options: TransferOptions,
  ): Promise<TransferResult> {
    return new Promise<TransferResult>((resolve, reject) => {
      let transferred = 0;
      let settled = false;

      const abort = (): void => {
        source.destroy();
        sink.destroy();
        finish(new Error('传输已取消'));
      };

      const finish = (err?: Error): void => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener('abort', abort);
        if (err) reject(err);
        else resolve({ bytes: transferred, resumedFrom });
      };

      options.signal?.addEventListener('abort', abort, { once: true });

      source.on('data', (chunk: Buffer | string) => {
        const len = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
        transferred += len;
        options.onProgress?.({ transferred: resumedFrom + transferred, total, path });
      });

      source.on('error', (err: Error) => finish(err));
      sink.on('error', (err: Error) => finish(err));
      sink.on('close', () => finish());

      source.pipe(sink);
    });
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw new Error('传输已取消');
  }
}