import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';

/**
 * 会话日志。两种形态并存：
 *   .raw —— 原始字节，配 .idx 时间戳索引，可无损回放
 *   .log —— 剥离 ANSI 的纯文本，给人看、给 grep
 * raw 与 idx 分开写是必要的：把时间戳插进字节流会破坏转义序列，回放就废了。
 */

const ANSI_PATTERN = /[\u001B\u009B][[\]()#;?]*(?:(?:\d{1,4}(?:;\d{0,4})*)?[0-9A-ORZcf-nqry=><]|(?:[0-9A-Za-z])?(?:\u0007))/g;

export function stripAnsi(input: string): string {
  return input.replace(ANSI_PATTERN, '');
}

export interface SessionLogOptions {
  dir: string;
  /** 文件名前缀，通常是会话名（会做文件系统安全化处理） */
  name: string;
  /** 是否同时写纯文本日志 */
  text?: boolean;
  now?: () => Date;
}

export interface SessionLogHandle {
  readonly rawPath: string;
  readonly indexPath: string;
  readonly textPath: string | null;
  readonly bytesWritten: number;
  write(chunk: Buffer): void;
  close(): Promise<void>;
}

export function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').replace(/^\.+/, '').trim();
  return cleaned === '' ? 'session' : cleaned.slice(0, 120);
}

export class SessionLogWriter implements SessionLogHandle {
  readonly rawPath: string;
  readonly indexPath: string;
  readonly textPath: string | null;

  private readonly rawStream: WriteStream;
  private readonly indexStream: WriteStream;
  private readonly textStream: WriteStream | null;
  private readonly now: () => Date;
  private offset = 0;
  private closed = false;

  constructor(options: SessionLogOptions) {
    const stamp = formatStamp((options.now ?? (() => new Date()))());
    const base = `${sanitizeFileName(options.name)}-${stamp}`;
    this.now = options.now ?? (() => new Date());

    mkdirSync(options.dir, { recursive: true });
    this.rawPath = join(options.dir, `${base}.raw`);
    this.indexPath = join(options.dir, `${base}.idx`);
    this.textPath = options.text ? join(options.dir, `${base}.log`) : null;

    this.rawStream = createWriteStream(this.rawPath, { flags: 'a' });
    this.indexStream = createWriteStream(this.indexPath, { flags: 'a' });
    this.textStream = this.textPath ? createWriteStream(this.textPath, { flags: 'a' }) : null;
  }

  get bytesWritten(): number {
    return this.offset;
  }

  write(chunk: Buffer): void {
    if (this.closed || chunk.length === 0) return;

    this.rawStream.write(chunk);
    this.indexStream.write(`${this.offset} ${this.now().toISOString()}\n`);
    this.offset += chunk.length;

    if (this.textStream) {
      this.textStream.write(stripAnsi(chunk.toString('utf8')));
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.all([
      endStream(this.rawStream),
      endStream(this.indexStream),
      this.textStream ? endStream(this.textStream) : Promise.resolve(),
    ]);
  }
}

function endStream(stream: WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.end((err?: Error | null) => (err ? reject(err) : resolve()));
  });
}

function formatStamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');
}