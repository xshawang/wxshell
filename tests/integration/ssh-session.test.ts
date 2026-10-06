import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionManager, type HostKeyDecision } from '../../src/core/session/SessionManager';
import { KnownHostsStore } from '../../src/core/store/KnownHostsStore';
import { AuditLog } from '../../src/core/store/AuditLog';
import { SessionStore } from '../../src/core/store/SessionStore';
import { AuthError } from '../../src/core/errors';
import type { SessionProfile } from '../../src/core/store/SessionStore';
import { startSshServer, type SshTestServer } from '../helpers/ssh-server';
import { generateKeyPair } from '../helpers/keys';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';

/**
 * SSH 会话端到端集成测试：真实 TCP + 真实 SSH 握手 + 真实加解密。
 * 服务端是进程内的 ssh2 Server（本机无 sshd，已验证）。
 *
 * 注意订阅时机：数据在 open() 期间就会流动（例如 shell 打开后远端立刻吐 banner），
 * 因此必须**先订阅再 open**。会话 id 由调用方通过 profile.id 指定，所以订阅时可预知。
 */

const PASSWORD = 'test-password';
const SESSION_ID = 'sess-1';

let dir: string;
let server: SshTestServer;
const managers: SessionManager[] = [];

interface Harness {
  manager: SessionManager;
  knownHosts: KnownHostsStore;
  audit: AuditLog;
  sessionStore: SessionStore;
  prompts: Array<{ fingerprint: string; verdict: string }>;
}

function sshProfile(overrides: Partial<SessionProfile> = {}): SessionProfile {
  return {
    id: SESSION_ID,
    name: 'test-ssh',
    kind: 'ssh',
    host: '127.0.0.1',
    port: server.port,
    parentId: null,
    ssh: { method: 'password', username: 'tester', secretRef: 'pw' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

let harnessSeq = 0;

function makeHarness(options: {
  secret?: (ref: string) => string | null;
  decision?: HostKeyDecision;
  knownHostsPath?: string;
  enableLog?: boolean;
  loadPrivateKey?: (path: string) => Buffer;
} = {}): Harness {
  const seq = (harnessSeq += 1);
  const knownHosts = new KnownHostsStore(options.knownHostsPath ?? join(dir, `known_hosts-${seq}.json`));
  const audit = new AuditLog(join(dir, `audit-${seq}.jsonl`));
  // 一个连接一个文件：这里给每个 harness 一个独立的配置目录，避免互相看到对方的会话
  const sessionStore = new SessionStore(join(dir, `config-${seq}`));
  const prompts: Array<{ fingerprint: string; verdict: string }> = [];

  const manager = new SessionManager({
    knownHosts,
    audit,
    resolveProfile: (id) => sessionStore.getSession(id),
    resolveSecret: options.secret ?? (() => PASSWORD),
    ...(options.enableLog ? { logDir: join(dir, 'logs') } : {}),
    ...(options.loadPrivateKey ? { loadPrivateKey: options.loadPrivateKey } : {}),
    hostKeyPrompt: async (info, verdict) => {
      prompts.push({ fingerprint: info.fingerprint, verdict });
      return options.decision ?? 'accept-and-save';
    },
  });
  managers.push(manager);
  return { manager, knownHosts, audit, sessionStore, prompts };
}

/** 必须在 open() 之前调用，否则会漏掉最早的输出 */
function collectOutput(manager: SessionManager, sessionId: string) {
  const chunks: Buffer[] = [];
  manager.on('data', (id, chunk) => {
    if (id === sessionId) chunks.push(chunk);
  });
  return {
    chunks,
    text: () => Buffer.concat(chunks).toString('utf8'),
    bytes: () => chunks.reduce((n, c) => n + c.length, 0),
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(25);
  }
  throw new Error('等待条件超时');
}

beforeEach(async () => {
  dir = makeTmpDir('ssh-it-');
  server = await startSshServer({ password: PASSWORD });
});

afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.closeAll().catch(() => undefined)));
  await server.close();
  removeTmpDir(dir);
});

describe('SSH - 口令认证', () => {
  it('凭据正确时建立连接并收到 banner', async () => {
    const h = makeHarness();
    const out = collectOutput(h.manager, SESSION_ID);
    const session = await h.manager.open({ kind: 'ssh', profile: sshProfile(), cols: 80, rows: 24 });

    await waitFor(() => out.text().includes('welcome to test sshd'));
    expect(session.state).toBe('ready');
    expect(session.capabilities.sftp).toBe(true);
    expect(session.capabilities.forward).toBe(true);
  });

  it('口令错误时抛出 AuthError', async () => {
    const h = makeHarness({ secret: () => 'wrong-password' });
    await expect(h.manager.open({ kind: 'ssh', profile: sshProfile(), cols: 80, rows: 24 })).rejects.toThrow(AuthError);
    expect(h.manager.list()).toHaveLength(0);
  });

  it('保险库中查不到凭据时给出明确错误（而不是静默重试）', async () => {
    const h = makeHarness({ secret: () => null });
    await expect(h.manager.open({ kind: 'ssh', profile: sshProfile(), cols: 80, rows: 24 })).rejects.toThrow(/保险库/);
  });

  it('用户名不匹配时认证失败', async () => {
    const h = makeHarness();
    const profile = sshProfile({ ssh: { method: 'password', username: 'someone-else', secretRef: 'pw' } });
    await expect(h.manager.open({ kind: 'ssh', profile, cols: 80, rows: 24 })).rejects.toThrow(AuthError);
  });

  it('认证失败时发出 sessionError 事件（不叫 error，避免 EventEmitter 特殊语义）', async () => {
    const h = makeHarness({ secret: () => 'wrong-password' });
    const errors: Error[] = [];
    h.manager.on('sessionError', (_id, err) => errors.push(err));

    await expect(h.manager.open({ kind: 'ssh', profile: sshProfile(), cols: 80, rows: 24 })).rejects.toThrow();
    await waitFor(() => errors.length > 0);
    expect(errors[0]).toBeInstanceOf(AuthError);
  });
});

describe('SSH - 公钥认证', () => {
  it('使用未加密私钥可登录（服务端做真实签名校验）', async () => {
    const { private: privateKey, public: publicKey } = generateKeyPair('ed25519');
    await server.close();
    server = await startSshServer({ publicKey });

    const h = makeHarness({ secret: () => null, loadPrivateKey: () => Buffer.from(privateKey) });
    const profile = sshProfile({ ssh: { method: 'publickey', username: 'tester', privateKeyPath: '<injected>' } });
    const session = await h.manager.open({ kind: 'ssh', profile, cols: 80, rows: 24 });
    expect(session.state).toBe('ready');
  });

  it('私钥与服务器记录的公钥不匹配时认证失败', async () => {
    const serverPair = generateKeyPair('ed25519');
    const otherPair = generateKeyPair('ed25519');
    await server.close();
    server = await startSshServer({ publicKey: serverPair.public });

    const h = makeHarness({ secret: () => null, loadPrivateKey: () => Buffer.from(otherPair.private) });
    const profile = sshProfile({ ssh: { method: 'publickey', username: 'tester', privateKeyPath: '<injected>' } });
    await expect(h.manager.open({ kind: 'ssh', profile, cols: 80, rows: 24 })).rejects.toThrow(AuthError);
  });
});

describe('SSH - 主机密钥校验（TOFU）', () => {
  it('未知主机密钥时发起询问，确认后记录', async () => {
    const h = makeHarness({ decision: 'accept-and-save' });
    const session = await h.manager.open({ kind: 'ssh', profile: sshProfile(), cols: 80, rows: 24 });

    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0]!.verdict).toBe('unknown');
    expect(h.prompts[0]!.fingerprint.startsWith('SHA256:')).toBe(true);

    const stored = h.knownHosts.list();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.keyType).toBe('ssh-ed25519');
    expect(h.audit.read().some((e) => e.type === 'hostkey.trust')).toBe(true);
    expect(session.state).toBe('ready');
  });

  it('已记录的密钥再次连接不再询问', async () => {
    const knownHostsPath = join(dir, 'shared-known-hosts.json');
    const first = makeHarness({ knownHostsPath, decision: 'accept-and-save' });
    await first.manager.open({ kind: 'ssh', profile: sshProfile(), cols: 80, rows: 24 });
    expect(first.prompts).toHaveLength(1);

    const second = makeHarness({ knownHostsPath, decision: 'accept-and-save' });
    await second.manager.open({ kind: 'ssh', profile: sshProfile(), cols: 80, rows: 24 });
    expect(second.prompts).toHaveLength(0);
  });

  it('用户拒绝时连接被阻断', async () => {
    const h = makeHarness({ decision: 'reject' });
    await expect(h.manager.open({ kind: 'ssh', profile: sshProfile(), cols: 80, rows: 24 })).rejects.toThrow();
    expect(h.knownHosts.list()).toHaveLength(0);
  });

  it('accept-once 只放行本次，不写入信任库', async () => {
    const knownHostsPath = join(dir, 'once-known-hosts.json');
    const first = makeHarness({ knownHostsPath, decision: 'accept-once' });
    const session = await first.manager.open({ kind: 'ssh', profile: sshProfile(), cols: 80, rows: 24 });
    expect(session.state).toBe('ready');
    expect(first.knownHosts.list()).toHaveLength(0);

    const second = makeHarness({ knownHostsPath, decision: 'accept-once' });
    await second.manager.open({ kind: 'ssh', profile: sshProfile(), cols: 80, rows: 24 });
    expect(second.prompts).toHaveLength(1);
  });

  it('指纹与记录不一致时判定为 mismatch 并写入审计', async () => {
    const knownHostsPath = join(dir, 'mismatch-known-hosts.json');
    const store = new KnownHostsStore(knownHostsPath);
    // 预置一个"错误"的密钥，模拟服务器换过密钥或中间人
    store.trust('127.0.0.1', server.port, 'ssh-ed25519', Buffer.from('not-the-real-host-key').toString('base64'));

    const h = makeHarness({ knownHostsPath, decision: 'reject' });
    await expect(h.manager.open({ kind: 'ssh', profile: sshProfile(), cols: 80, rows: 24 })).rejects.toThrow();

    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0]!.verdict).toBe('mismatch');
    expect(h.audit.read().some((e) => e.type === 'hostkey.mismatch')).toBe(true);
  });

  it('mismatch 时用户显式选择替换才放行，且旧记录被覆盖', async () => {
    const knownHostsPath = join(dir, 'replace-known-hosts.json');
    const staleKey = Buffer.from('stale-key').toString('base64');
    const store = new KnownHostsStore(knownHostsPath);
    store.trust('127.0.0.1', server.port, 'ssh-ed25519', staleKey);

    const h = makeHarness({ knownHostsPath, decision: 'replace-and-save' });
    const session = await h.manager.open({ kind: 'ssh', profile: sshProfile(), cols: 80, rows: 24 });

    expect(session.state).toBe('ready');
    expect(h.knownHosts.check('127.0.0.1', server.port, 'ssh-ed25519', staleKey).verdict).toBe('mismatch');
    expect(h.knownHosts.list()).toHaveLength(1);
  });

  it('未提供询问回调时未知主机默认拒绝（安全默认值）', async () => {
    const manager = new SessionManager({
      knownHosts: new KnownHostsStore(join(dir, 'no-prompt.json')),
      resolveSecret: () => PASSWORD,
    });
    managers.push(manager);
    await expect(manager.open({ kind: 'ssh', profile: sshProfile(), cols: 80, rows: 24 })).rejects.toThrow();
  });
});

describe('SSH - 双向数据与编码', () => {
  it('写入的字节到达服务端并被回显', async () => {
    const h = makeHarness();
    const out = collectOutput(h.manager, SESSION_ID);
    const session = await h.manager.open({ kind: 'ssh', profile: sshProfile(), cols: 80, rows: 24 });

    session.write('whoami\n');
    await waitFor(() => out.text().includes('IN:whoami'));
    expect(server.shellInput.map((b) => b.toString()).join('')).toContain('whoami');
  });

  it('中文与 emoji 往返不乱码（验证字节链路不做字符串拼接）', async () => {
    const h = makeHarness();
    const out = collectOutput(h.manager, SESSION_ID);
    const session = await h.manager.open({ kind: 'ssh', profile: sshProfile(), cols: 80, rows: 24 });

    session.write('中文测试🔐\n');
    await waitFor(() => out.text().includes('中文测试🔐'));
  });

  it('resize 不抛错，非法尺寸被忽略', async () => {
    const h = makeHarness();
    const session = await h.manager.open({ kind: 'ssh', profile: sshProfile(), cols: 80, rows: 24 });
    expect(() => session.resize(132, 43)).not.toThrow();
    expect(() => session.resize(0, 0)).not.toThrow();
  });
});

describe('SSH - 背压（真实行为验证）', () => {
  it('不确认时上游被真正暂停，确认后恢复传输', async () => {
    // 服务端在 shell 打开后立即吐 4 MiB，远超 1 MiB 高水位
    await server.close();
    server = await startSshServer({ password: PASSWORD, shellPayload: Buffer.alloc(4 * 1024 * 1024, 0x41) });

    const h = makeHarness();
    let received = 0;
    h.manager.on('data', (id, chunk) => {
      if (id === SESSION_ID) received += chunk.length;
    });
    const session = await h.manager.open({ kind: 'ssh', profile: sshProfile(), cols: 80, rows: 24 });

    // 只接收不确认，模拟渲染进程处理不过来
    await waitFor(() => received > 1024 * 1024, 20000);

    const mark = received;
    await delay(500);
    const stalled = received - mark;
    // 上游被暂停后这段时间的增量必须很小（背压失效的话会继续灌满几十 MiB）
    expect(stalled).toBeLessThan(512 * 1024);

    // 确认已消费字节 -> 回落到低水位以下 -> 恢复
    h.manager.ack(session.id, h.manager.pendingBytes.get(session.id) ?? 0);
    expect(h.manager.pendingBytes.get(session.id)).toBe(0);

    await waitFor(() => received > mark + 512 * 1024, 20000);
  });
});

describe('SSH - 审计与日志', () => {
  it('会话开闭写入审计日志，且不含明文口令', async () => {
    const h = makeHarness();
    const session = await h.manager.open({ kind: 'ssh', profile: sshProfile(), cols: 80, rows: 24 });
    await h.manager.close(session.id);

    const types = h.audit.read().map((e) => e.type);
    expect(types).toContain('session.open');
    expect(types).toContain('session.close');

    const open = h.audit.read().find((e) => e.type === 'session.open')!;
    expect(open.detail).toMatchObject({ host: '127.0.0.1', port: server.port, user: 'tester', method: 'password' });
    expect(JSON.stringify(open)).not.toContain(PASSWORD);
  });

  it('启用日志时会话输出落盘', async () => {
    const h = makeHarness({ enableLog: true });
    const out = collectOutput(h.manager, SESSION_ID);
    const session = await h.manager.open({ kind: 'ssh', profile: sshProfile(), cols: 80, rows: 24 });
    await waitFor(() => out.text().includes('welcome'));
    await h.manager.close(session.id);
    await delay(300);

    const files = readdirSync(join(dir, 'logs'));
    expect(files.some((f) => f.endsWith('.raw'))).toBe(true);
    expect(files.some((f) => f.endsWith('.idx'))).toBe(true);
    expect(files.some((f) => f.endsWith('.log'))).toBe(true);
  });
});

describe('SSH - 关闭', () => {
  it('关闭后从管理器中移除并触发 close', async () => {
    const h = makeHarness();
    const session = await h.manager.open({ kind: 'ssh', profile: sshProfile(), cols: 80, rows: 24 });

    let closed = false;
    session.on('close', () => {
      closed = true;
    });

    await h.manager.close(session.id);
    await waitFor(() => closed);
    expect(h.manager.get(session.id)).toBeNull();
    expect(h.manager.list()).toHaveLength(0);
  });
});
