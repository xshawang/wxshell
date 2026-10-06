import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KnownHostsStore, parseHostToken } from '../../src/core/store/KnownHostsStore';
import { sshKeyFingerprint } from '../../src/core/ssh/sshKeyBlob';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';

let dir: string;
let path: string;
const KEY_A = Buffer.from('host-key-a').toString('base64');
const KEY_B = Buffer.from('host-key-b').toString('base64');

beforeEach(() => {
  dir = makeTmpDir('knownhosts-');
  path = join(dir, 'known_hosts.json');
});
afterEach(() => removeTmpDir(dir));

describe('KnownHostsStore - 校验判定', () => {
  it('未记录的host返回 unknown', () => {
    const store = new KnownHostsStore(path);
    const r = store.check('10.0.0.1', 22, 'ssh-ed25519', KEY_A);
    expect(r.verdict).toBe('unknown');
    expect(r.fingerprint).toBe(sshKeyFingerprint(Buffer.from(KEY_A, 'base64')));
  });

  it('显式信任后返回 match', () => {
    const store = new KnownHostsStore(path);
    store.trust('10.0.0.1', 22, 'ssh-ed25519', KEY_A);
    expect(store.check('10.0.0.1', 22, 'ssh-ed25519', KEY_A).verdict).toBe('match');
  });

  it('密钥变化返回 mismatch 并带出原记录', () => {
    const store = new KnownHostsStore(path);
    store.trust('10.0.0.1', 22, 'ssh-ed25519', KEY_A);
    const r = store.check('10.0.0.1', 22, 'ssh-ed25519', KEY_B);
    expect(r.verdict).toBe('mismatch');
    expect(r.existing?.key).toBe(KEY_A);
  });

  it('不同端口 / 不同算法分别记录', () => {
    const store = new KnownHostsStore(path);
    store.trust('h', 22, 'ssh-ed25519', KEY_A);
    expect(store.check('h', 2222, 'ssh-ed25519', KEY_A).verdict).toBe('unknown');
    expect(store.check('h', 22, 'ssh-rsa', KEY_A).verdict).toBe('unknown');
  });

  it('端口 0 归一化为 22', () => {
    const store = new KnownHostsStore(path);
    store.trust('h', 0, 'ssh-ed25519', KEY_A);
    expect(store.check('h', 22, 'ssh-ed25519', KEY_A).verdict).toBe('match');
  });
});

describe('KnownHostsStore - 持久化与修改', () => {
  it('trust 后重新加载仍然 match 且保留首次添加时间', () => {
    const store = new KnownHostsStore(path);
    const added = store.trust('h', 22, 'ssh-ed25519', KEY_A, new Date('2026-01-01T00:00:00Z'));

    const reloaded = new KnownHostsStore(path);
    expect(reloaded.check('h', 22, 'ssh-ed25519', KEY_A).verdict).toBe('match');

    const updated = reloaded.trust('h', 22, 'ssh-ed25519', KEY_B);
    expect(updated.addedAt).toBe(added.addedAt);
    expect(reloaded.check('h', 22, 'ssh-ed25519', KEY_B).verdict).toBe('match');
  });

  it('replace 只替换目标条目', () => {
    const store = new KnownHostsStore(path);
    store.trust('h1', 22, 'ssh-ed25519', KEY_A);
    store.trust('h2', 22, 'ssh-ed25519', KEY_A);
    store.replace('h1', 22, 'ssh-ed25519', KEY_B);

    expect(store.check('h1', 22, 'ssh-ed25519', KEY_B).verdict).toBe('match');
    expect(store.check('h2', 22, 'ssh-ed25519', KEY_A).verdict).toBe('match');
    expect(store.list()).toHaveLength(2);
  });

  it('remove 支持按算法精确删除', () => {
    const store = new KnownHostsStore(path);
    store.trust('h', 22, 'ssh-ed25519', KEY_A);
    store.trust('h', 22, 'ssh-rsa', KEY_A);
    expect(store.remove('h', 22, 'ssh-ed25519')).toBe(1);
    expect(store.check('h', 22, 'ssh-ed25519', KEY_A).verdict).toBe('unknown');
    expect(store.check('h', 22, 'ssh-rsa', KEY_A).verdict).toBe('match');
    expect(store.remove('h', 22)).toBe(1);
    expect(store.list()).toHaveLength(0);
  });

  it('无路径实例不落盘（内存态）', () => {
    const store = new KnownHostsStore(null);
    store.trust('h', 22, 'ssh-ed25519', KEY_A);
    expect(store.check('h', 22, 'ssh-ed25519', KEY_A).verdict).toBe('match');
  });
});

describe('KnownHostsStore - 导入 OpenSSH known_hosts', () => {
  it('解析普通行与 [host]:port 行', () => {
    const store = new KnownHostsStore(path);
    const text = [
      '# 注释行',
      '',
      `github.com ssh-ed25519 ${KEY_A}`,
      `[10.0.0.5]:2222 ssh-rsa ${KEY_B}`,
    ].join('\n');

    const result = store.importOpenSsh(text);
    expect(result.imported).toBe(2);
    expect(store.check('github.com', 22, 'ssh-ed25519', KEY_A).verdict).toBe('match');
    expect(store.check('10.0.0.5', 2222, 'ssh-rsa', KEY_B).verdict).toBe('match');
  });

  it('跳过哈希主机名与标记行并计数', () => {
    const store = new KnownHostsStore(path);
    const text = [
      `|1|abcd|efgh ssh-ed25519 ${KEY_A}`,
      `@revoked bad.example ssh-rsa ${KEY_B}`,
      `@cert-authority ca.example ssh-ed25519 ${KEY_A}`,
      'not-enough-fields',
    ].join('\n');

    const result = store.importOpenSsh(text);
    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(4);
  });

  it('逗号分隔的多主机名逐个导入', () => {
    const store = new KnownHostsStore(path);
    const result = store.importOpenSsh(`a.example,b.example ssh-ed25519 ${KEY_A}`);
    expect(result.imported).toBe(2);
    expect(store.check('a.example', 22, 'ssh-ed25519', KEY_A).verdict).toBe('match');
    expect(store.check('b.example', 22, 'ssh-ed25519', KEY_A).verdict).toBe('match');
  });

  it('重复导入相同条目计为 skipped', () => {
    const store = new KnownHostsStore(path);
    store.importOpenSsh(`a.example ssh-ed25519 ${KEY_A}`);
    const second = store.importOpenSsh(`a.example ssh-ed25519 ${KEY_A}`);
    expect(second.imported).toBe(0);
    expect(second.skipped).toBe(1);
  });

  it('导入结果落盘', () => {
    const store = new KnownHostsStore(path);
    store.importOpenSsh(`a.example ssh-ed25519 ${KEY_A}`);
    const reloaded = new KnownHostsStore(path);
    expect(reloaded.check('a.example', 22, 'ssh-ed25519', KEY_A).verdict).toBe('match');
  });
});

describe('parseHostToken', () => {
  it('普通主机名默认端口 22', () => {
    expect(parseHostToken('example.com')).toEqual({ host: 'example.com', port: 22 });
  });
  it('方括号形式带端口', () => {
    expect(parseHostToken('[example.com]:2200')).toEqual({ host: 'example.com', port: 2200 });
  });
  it('IPv6 方括号形式', () => {
    expect(parseHostToken('[::1]:22')).toEqual({ host: '::1', port: 22 });
  });
  it('空串返回 null', () => {
    expect(parseHostToken('')).toBeNull();
  });
});