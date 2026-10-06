import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigError } from '../errors';
import type { SessionKind } from '../types';
import { readJsonFileSync, writeJsonAtomicSync } from './JsonFile';

export type AuthMethod = 'password' | 'publickey' | 'agent' | 'keyboard-interactive';

export interface SshAuthConfig {
  method: AuthMethod;
  username: string;
  /**
   * 口令在会话文件 `secrets` 段里的键。取确定值（见 sessionSecretRef），
   * 重连/重启后仍然指向同一条记录；口令明文与配置在同一个文件里。
   */
  secretRef?: string;
  privateKeyPath?: string;
  passphraseRef?: string;
}

export interface SessionProfile {
  id: string;
  name: string;
  kind: SessionKind;
  host?: string;
  port?: number;
  parentId: string | null;
  ssh?: SshAuthConfig;
  terminal?: { type?: string; cols?: number; rows?: number; encoding?: string };
  keepalive?: { intervalMs?: number; countMax?: number };
  reconnect?: { auto?: boolean; maxAttempts?: number; backoffMs?: number };
  /** 跳板会话 id 列表，按顺序串接 */
  jumpChain?: string[];
  log?: { enabled?: boolean; dir?: string };
  createdAt: string;
  updatedAt: string;
}

export interface SessionFolder {
  id: string;
  name: string;
  parentId: string | null;
}

export interface SessionTree {
  folders: SessionFolder[];
  sessions: SessionProfile[];
}

/** 一个连接一个配置文件：<configDir>/sessions/<id>.json */
interface SessionFile {
  version: number;
  profile: SessionProfile;
  /** secretRef -> 口令明文。与配置同文件，整份拷走即可带走连接 */
  secrets?: Record<string, string>;
}

interface FoldersFile {
  version: number;
  folders: SessionFolder[];
}

const FILE_VERSION = 1;
const SESSIONS_DIR = 'sessions';
const FOLDERS_FILE = 'folders.json';
const DEFAULT_PORTS: Partial<Record<SessionKind, number>> = { ssh: 22, telnet: 23 };

/** 会话口令的 secretRef 由 id 推导，保证跨启动稳定。 */
export function sessionSecretRef(id: string): string {
  return `session:${id}:ssh-password`;
}

export type SessionProfileInput = Partial<Omit<SessionProfile, 'createdAt' | 'updatedAt'>> & {
  /** 传入已有 id 表示更新，省略表示新建 */
  id?: string;
  name: string;
  kind: SessionKind;
  /**
   * SSH 口令明文，只用来写入本会话文件（落到 `secrets` 段），不进入 SessionProfile。
   * 不传表示保持文件里已有的口令不动；传空串表示清掉。
   */
  password?: string;
};

/**
 * 会话配置存储。
 *
 * 磁盘布局（一个连接一个文件，便于单独拷走/单独版本管理）：
 *   <configDir>/folders.json        目录树
 *   <configDir>/sessions/<id>.json  每个连接一份配置 + 口令
 */
export class SessionStore {
  private folders: SessionFolder[];
  private readonly sessions = new Map<string, SessionProfile>();
  private readonly secrets = new Map<string, string>();

  constructor(private readonly configDir: string) {
    const foldersFile = readJsonFileSync<FoldersFile | null>(join(configDir, FOLDERS_FILE), null);
    this.folders = foldersFile?.folders ?? [];
    this.loadSessions();
  }

  listSessions(): SessionProfile[] {
    return [...this.sessions.values()];
  }

  listFolders(): SessionFolder[] {
    return [...this.folders];
  }

  getSession(id: string): SessionProfile | null {
    return this.sessions.get(id) ?? null;
  }

  getFolder(id: string): SessionFolder | null {
    return this.folders.find((f) => f.id === id) ?? null;
  }

  /** 读取随会话文件一起保存的口令 */
  getSecret(ref: string): string | null {
    return this.secrets.get(ref) ?? null;
  }

  upsertSession(input: SessionProfileInput): SessionProfile {
    const now = new Date().toISOString();
    const existing = input.id ? this.getSession(input.id) : null;
    const id = input.id ?? randomUUID();

    const { password, ...fields } = input;
    const merged: SessionProfile = {
      parentId: null,
      ...existing,
      ...fields,
      id,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    } as SessionProfile;

    if (merged.port === undefined) {
      const fallback = DEFAULT_PORTS[merged.kind];
      if (fallback !== undefined) merged.port = fallback;
    }
    if (merged.ssh && (merged.ssh.method === 'password' || merged.ssh.method === 'keyboard-interactive')) {
      merged.ssh = { ...merged.ssh, secretRef: sessionSecretRef(id) };
    }
    this.validate(merged);

    const secretRef = merged.ssh?.secretRef;
    if (password !== undefined && secretRef) this.secrets.set(secretRef, password);

    const persisted: Record<string, string> = {};
    const value = secretRef ? this.secrets.get(secretRef) : undefined;
    if (secretRef && value !== undefined) persisted[secretRef] = value;

    this.sessions.set(id, merged);
    this.writeSessionFile(merged, persisted);
    return merged;
  }

  deleteSession(id: string): boolean {
    const profile = this.sessions.get(id);
    if (!profile) return false;
    this.sessions.delete(id);
    const secretRef = profile.ssh?.secretRef;
    if (secretRef) this.secrets.delete(secretRef);
    rmSync(this.sessionFile(id), { force: true });
    return true;
  }

  createFolder(name: string, parentId: string | null = null): SessionFolder {
    if (parentId && !this.getFolder(parentId)) throw new ConfigError(`父目录不存在: ${parentId}`);
    const folder: SessionFolder = { id: randomUUID(), name, parentId };
    this.folders.push(folder);
    this.saveFolders();
    return folder;
  }

  deleteFolder(id: string): boolean {
    const folder = this.getFolder(id);
    if (!folder) return false;
    // 子项上移到被删目录的父级，避免出现孤儿节点
    const moved: SessionProfile[] = [];
    for (const f of this.folders) {
      if (f.parentId === id) f.parentId = folder.parentId;
    }
    for (const s of this.sessions.values()) {
      if (s.parentId === id) {
        s.parentId = folder.parentId;
        moved.push(s);
      }
    }
    this.folders = this.folders.filter((f) => f.id !== id);
    this.saveFolders();
    for (const profile of moved) this.writeSessionFile(profile, this.persistedSecrets(profile));
    return true;
  }

  moveSession(id: string, parentId: string | null): boolean {
    const session = this.getSession(id);
    if (!session) return false;
    if (parentId && !this.getFolder(parentId)) throw new ConfigError(`目标目录不存在: ${parentId}`);
    session.parentId = parentId;
    session.updatedAt = new Date().toISOString();
    this.writeSessionFile(session, this.persistedSecrets(session));
    return true;
  }

  /** 按 parentId 组装成层级结构；parentId 指向不存在节点的项归到根，避免数据丢失 */
  tree(): SessionTree {
    const folderIds = new Set(this.folders.map((f) => f.id));
    const folders = this.folders.map((f) => ({
      ...f,
      parentId: f.parentId && folderIds.has(f.parentId) ? f.parentId : null,
    }));
    const sessions = [...this.sessions.values()].map((s) => ({
      ...s,
      parentId: s.parentId && folderIds.has(s.parentId) ? s.parentId : null,
    }));
    return { folders, sessions };
  }

  /** 检测目录环（A→B→A），导入外部配置时用 */
  findFolderCycle(): string[] | null {
    for (const start of this.folders) {
      const seen = new Set<string>([start.id]);
      let current = start;
      for (;;) {
        const parentId = current.parentId;
        if (!parentId) break;
        if (seen.has(parentId)) return [...seen, parentId];
        seen.add(parentId);
        const parent = this.getFolder(parentId);
        if (!parent) break;
        current = parent;
      }
    }
    return null;
  }

  private sessionFile(id: string): string {
    return join(this.configDir, SESSIONS_DIR, `${id}.json`);
  }

  private loadSessions(): void {
    const dir = join(this.configDir, SESSIONS_DIR);
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith('.json')) continue;
      const path = join(dir, entry);
      let file: SessionFile | null;
      try {
        file = readJsonFileSync<SessionFile | null>(path, null);
      } catch (err) {
        // 一个连接一个文件的意义就在这里：单个文件坏掉只丢这一条，
        // 绝不能让它把整个应用卡在启动阶段。
        console.warn(`[sessions] 跳过无法解析的会话文件 ${path}: ${(err as Error).message}`);
        continue;
      }
      if (!file?.profile?.id) continue;
      this.sessions.set(file.profile.id, file.profile);
      for (const [ref, value] of Object.entries(file.secrets ?? {})) {
        if (typeof value === 'string') this.secrets.set(ref, value);
      }
    }
  }

  private persistedSecrets(profile: SessionProfile): Record<string, string> {
    const ref = profile.ssh?.secretRef;
    if (!ref) return {};
    const value = this.secrets.get(ref);
    return value === undefined ? {} : { [ref]: value };
  }

  private writeSessionFile(profile: SessionProfile, secrets: Record<string, string>): void {
    const file: SessionFile = { version: FILE_VERSION, profile, secrets };
    writeJsonAtomicSync(this.sessionFile(profile.id), file);
  }

  private saveFolders(): void {
    const file: FoldersFile = { version: FILE_VERSION, folders: this.folders };
    writeJsonAtomicSync(join(this.configDir, FOLDERS_FILE), file);
  }

  private validate(profile: SessionProfile): void {
    if (!profile.name || profile.name.trim() === '') {
      throw new ConfigError('会话名称不能为空');
    }
    if (profile.parentId && !this.getFolder(profile.parentId)) {
      throw new ConfigError(`父目录不存在: ${profile.parentId}`);
    }
    if (profile.kind === 'ssh') {
      if (!profile.host) throw new ConfigError('SSH 会话必须指定 host');
      if (!profile.ssh?.username) throw new ConfigError('SSH 会话必须指定用户名');
      if (profile.ssh.method === 'publickey' && !profile.ssh.privateKeyPath) {
        throw new ConfigError('公钥认证必须指定私钥路径');
      }
    }
    if ((profile.kind === 'telnet' || profile.kind === 'rawtcp') && !profile.host) {
      throw new ConfigError(`${profile.kind} 会话必须指定 host`);
    }
    if (profile.jumpChain?.includes(profile.id)) {
      throw new ConfigError('会话不能把自己作为跳板');
    }
  }
}
