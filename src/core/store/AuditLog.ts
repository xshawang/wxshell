import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * 审计日志：append-only JSONL。
 *
 * 用 JSONL 而不是数据库表：审计的本质是"只追加、不改写、可外部核查"，
 * 追加写没有锁竞争，崩溃时最多丢最后一行，且可以直接 grep / 交给 SIEM。
 * 敏感字段只记录引用名（如保险库条目名），不记录明文。
 */

export type AuditEventType =
  | 'session.open'
  | 'session.close'
  | 'auth.ok'
  | 'auth.fail'
  | 'hostkey.unknown'
  | 'hostkey.mismatch'
  | 'hostkey.trust'
  | 'exec'
  | 'sftp.get'
  | 'sftp.put'
  | 'tunnel.open'
  | 'tunnel.close'
  | 'secret.set'
  | 'secret.delete';

export interface AuditEvent {
  ts: string;
  type: AuditEventType;
  sessionId?: string;
  detail?: Record<string, unknown>;
}

export interface AuditLogOptions {
  /** 单文件上限，超出后轮转为 .1 */
  maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

export class AuditLog {
  private readonly maxBytes: number;

  constructor(
    private readonly path: string,
    options: AuditLogOptions = {},
  ) {
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  append(type: AuditEventType, event: Omit<AuditEvent, 'ts' | 'type'> = {}, now = new Date()): AuditEvent {
    const record: AuditEvent = { ts: now.toISOString(), type, ...event };
    mkdirSync(dirname(this.path), { recursive: true });
    this.rotateIfNeeded();
    appendFileSync(this.path, `${JSON.stringify(record)}\n`, 'utf8');
    return record;
  }

  read(): AuditEvent[] {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as AuditEvent);
  }

  private rotateIfNeeded(): void {
    if (!existsSync(this.path)) return;
    const size = statSync(this.path).size;
    if (size < this.maxBytes) return;
    const rotated = `${this.path}.1`;
    renameSync(this.path, rotated);
  }
}