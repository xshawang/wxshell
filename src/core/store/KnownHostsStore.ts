import { readJsonFileSync, writeJsonAtomicSync } from './JsonFile';
import { sshKeyFingerprint } from '../ssh/sshKeyBlob';

/**
 * 主机密钥信任库（known_hosts）。
 *
 * 安全立场：指纹**变更默认阻断连接**，只在用户显式操作后放行。
 * 不做"首次自动信任"以外的任何自动决策，也不提供"永不检查"的静默开关 ——
 * MITM 防护的意义全在这里。
 */

export type HostKeyVerdict = 'match' | 'unknown' | 'mismatch';

export interface KnownHostEntry {
  host: string;
  port: number;
  keyType: string;
  key: string;
  addedAt: string;
}

interface KnownHostsFile {
  version: number;
  entries: KnownHostEntry[];
}

const FILE_VERSION = 1;
const DEFAULT_SSH_PORT = 22;

export interface HostKeyCheckResult {
  verdict: HostKeyVerdict;
  existing?: KnownHostEntry;
  fingerprint: string;
}

export class KnownHostsStore {
  private entries: KnownHostEntry[];

  constructor(private readonly path: string | null = null) {
    const file = path ? readJsonFileSync<KnownHostsFile | null>(path, null) : null;
    this.entries = file?.entries ?? [];
  }

  list(): KnownHostEntry[] {
    return [...this.entries];
  }

  find(host: string, port: number, keyType: string): KnownHostEntry | undefined {
    const p = port || DEFAULT_SSH_PORT;
    return this.entries.find(
      (e) => e.host === host && e.port === p && e.keyType === keyType,
    );
  }

  check(host: string, port: number, keyType: string, keyBase64: string): HostKeyCheckResult {
    const fingerprint = `SHA256:${sshKeyFingerprint(Buffer.from(keyBase64, 'base64')).replace('SHA256:', '')}`;
    const existing = this.find(host, port, keyType);

    if (!existing) return { verdict: 'unknown', fingerprint };
    if (existing.key === keyBase64) return { verdict: 'match', existing, fingerprint };
    return { verdict: 'mismatch', existing, fingerprint };
  }

  /** 仅在用户显式确认后调用 */
  trust(host: string, port: number, keyType: string, keyBase64: string, now = new Date()): KnownHostEntry {
    const p = port || DEFAULT_SSH_PORT;
    const idx = this.entries.findIndex((e) => e.host === host && e.port === p && e.keyType === keyType);
    const entry: KnownHostEntry = {
      host,
      port: p,
      keyType,
      key: keyBase64,
      addedAt: now.toISOString(),
    };
    if (idx >= 0) {
      // 保留首次记录时间；返回值必须是真正落库的那个对象
      const stored: KnownHostEntry = { ...entry, addedAt: this.entries[idx]!.addedAt };
      this.entries[idx] = stored;
      this.save();
      return stored;
    }
    this.entries.push(entry);
    this.save();
    return entry;
  }

  /** 指纹变更后按用户要求替换记录 */
  replace(host: string, port: number, keyType: string, keyBase64: string, now = new Date()): KnownHostEntry {
    const p = port || DEFAULT_SSH_PORT;
    this.entries = this.entries.filter((e) => !(e.host === host && e.port === p && e.keyType === keyType));
    return this.trust(host, p, keyType, keyBase64, now);
  }

  remove(host: string, port: number, keyType?: string): number {
    const p = port || DEFAULT_SSH_PORT;
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => {
      if (e.host !== host || e.port !== p) return true;
      if (keyType && e.keyType !== keyType) return true;
      return false;
    });
    const removed = before - this.entries.length;
    if (removed > 0) this.save();
    return removed;
  }

  /**
   * 导入 OpenSSH known_hosts 文本。
   * 哈希主机名（|1|...）无法反推，标记为 skipped；@cert-authority / @revoked 一行也不导入。
   */
  importOpenSsh(text: string): { imported: number; skipped: number } {
    let imported = 0;
    let skipped = 0;

    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line === '' || line.startsWith('#')) continue;

      const parts = line.split(/\s+/);
      if (parts.length < 3) {
        skipped += 1;
        continue;
      }

      const [hostField, keyType, key] = parts as [string, string, string];
      if (hostField.startsWith('|') || hostField.startsWith('@')) {
        skipped += 1;
        continue;
      }

      for (const hostToken of hostField.split(',')) {
        const parsed = parseHostToken(hostToken);
        if (!parsed) {
          skipped += 1;
          continue;
        }
        const existing = this.find(parsed.host, parsed.port, keyType);
        if (existing && existing.key === key) {
          skipped += 1;
          continue;
        }
        this.upsertRaw({
          host: parsed.host,
          port: parsed.port,
          keyType,
          key,
          addedAt: new Date().toISOString(),
        });
        imported += 1;
      }
    }

    if (imported > 0) this.save();
    return { imported, skipped };
  }

  save(): void {
    if (!this.path) return;
    const file: KnownHostsFile = { version: FILE_VERSION, entries: this.entries };
    writeJsonAtomicSync(this.path, file);
  }

  private upsertRaw(entry: KnownHostEntry): void {
    const idx = this.entries.findIndex(
      (e) => e.host === entry.host && e.port === entry.port && e.keyType === entry.keyType,
    );
    if (idx >= 0) {
      this.entries[idx] = entry;
    } else {
      this.entries.push(entry);
    }
  }
}

/** 支持 `host` 与 `[host]:port` 两种写法 */
export function parseHostToken(token: string): { host: string; port: number } | null {
  const bracket = /^\[(.+)\]:(\d+)$/.exec(token);
  if (bracket) {
    const host = bracket[1];
    const port = Number(bracket[2]);
    if (!host || !Number.isInteger(port)) return null;
    return { host, port };
  }
  if (token === '') return null;
  return { host: token, port: DEFAULT_SSH_PORT };
}