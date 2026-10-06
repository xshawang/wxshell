import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Vault } from '../../src/core/vault/Vault';
import { InvalidPasswordError, VaultLockedError } from '../../src/core/errors';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';

let dir: string;
let path: string;

beforeEach(() => {
  dir = makeTmpDir('vault-');
  path = join(dir, 'vault.json');
});

afterEach(() => removeTmpDir(dir));

describe('Vault - 基本生命周期', () => {
  it('初始化后可写入读取并持久化', () => {
    const vault = new Vault(path);
    expect(vault.isInitialized).toBe(false);
    vault.initialize('master-pass');

    vault.setSecret('prod-web-01', 's3cr3t');
    expect(vault.getSecret('prod-web-01')).toBe('s3cr3t');

    // 重新加载
    const reopened = new Vault(path);
    expect(reopened.isInitialized).toBe(true);
    reopened.unlock('master-pass');
    expect(reopened.getSecret('prod-web-01')).toBe('s3cr3t');
  });

  it('未初始化的库不能解锁', () => {
    const vault = new Vault(path);
    expect(() => vault.unlock('x')).toThrow();
  });

  it('重复初始化被拒绝', () => {
    const vault = new Vault(path);
    vault.initialize('a');
    expect(() => vault.initialize('b')).toThrow(/已存在/);
  });

  it('主密码错误时抛 InvalidPasswordError', () => {
    const vault = new Vault(path);
    vault.initialize('right');
    const reopened = new Vault(path);
    expect(() => reopened.unlock('wrong')).toThrow(InvalidPasswordError);
  });

  it('锁定后读取被拒绝', () => {
    const vault = new Vault(path);
    vault.initialize('pw');
    vault.setSecret('a', '1');
    vault.lock();
    expect(vault.isUnlocked).toBe(false);
    expect(() => vault.getSecret('a')).toThrow(VaultLockedError);
    expect(() => vault.setSecret('b', '2')).toThrow(VaultLockedError);
  });

  it('未解锁时写入同样被拒绝', () => {
    const vault = new Vault(path);
    vault.initialize('pw');
    vault.lock();
    const reopened = new Vault(path);
    expect(() => reopened.setSecret('x', 'y')).toThrow(VaultLockedError);
  });
});

describe('Vault - 加密性质', () => {
  it('落盘文件中不含明文', () => {
    const vault = new Vault(path);
    vault.initialize('pw');
    vault.setSecret('token', 'PLAINTEXT-MARKER-12345');
    const raw = readFileSync(path, 'utf8');
    expect(raw).not.toContain('PLAINTEXT-MARKER-12345');
    expect(raw).not.toContain('pw');
  });

  it('同一明文两次写入产生不同密文（DEK 随机）', () => {
    const vault = new Vault(path);
    vault.initialize('pw');
    vault.setSecret('a', 'same');
    const first = readFileSync(path, 'utf8');
    vault.setSecret('b', 'same');
    const second = readFileSync(path, 'utf8');
    expect(first).not.toBe(second);

    const file = JSON.parse(second) as { items: Record<string, { value: { ct: string } }> };
    expect(file.items.a!.value.ct).not.toBe(file.items.b!.value.ct);
  });

  it('密文被篡改时解密失败（GCM 完整性）', () => {
    const vault = new Vault(path);
    vault.initialize('pw');
    vault.setSecret('a', 'value');

    const file = JSON.parse(readFileSync(path, 'utf8')) as {
      items: Record<string, { value: { ct: string; tag: string } }>;
    };
    const ct = Buffer.from(file.items.a!.value.ct, 'base64');
    ct[0] = ct[0]! ^ 0xff;
    file.items.a!.value.ct = ct.toString('base64');
    writeFileSync(path, JSON.stringify(file), 'utf8');

    const tampered = new Vault(path);
    tampered.unlock('pw');
    expect(() => tampered.getSecret('a')).toThrow();
  });

  it('认证标签被篡改时解密失败', () => {
    const vault = new Vault(path);
    vault.initialize('pw');
    vault.setSecret('a', 'value');

    const file = JSON.parse(readFileSync(path, 'utf8')) as {
      items: Record<string, { value: { tag: string } }>;
    };
    const tag = Buffer.from(file.items.a!.value.tag, 'base64');
    tag[0] = tag[0]! ^ 0xff;
    file.items.a!.value.tag = tag.toString('base64');
    writeFileSync(path, JSON.stringify(file), 'utf8');

    const tampered = new Vault(path);
    tampered.unlock('pw');
    expect(() => tampered.getSecret('a')).toThrow();
  });

  it('每次初始化的 salt 不同', () => {
    const v1 = new Vault(join(dir, 'a.json'));
    v1.initialize('pw');
    const v2 = new Vault(join(dir, 'b.json'));
    v2.initialize('pw');

    const salt1 = (JSON.parse(readFileSync(join(dir, 'a.json'), 'utf8')) as { kdf: { salt: string } }).kdf.salt;
    const salt2 = (JSON.parse(readFileSync(join(dir, 'b.json'), 'utf8')) as { kdf: { salt: string } }).kdf.salt;
    expect(salt1).not.toBe(salt2);
  });
});

describe('Vault - 条目管理', () => {
  it('列出与删除', () => {
    const vault = new Vault(path);
    vault.initialize('pw');
    vault.setSecret('b', '2');
    vault.setSecret('a', '1');
    expect(vault.secretNames).toEqual(['a', 'b']);
    expect(vault.has('a')).toBe(true);

    expect(vault.deleteSecret('a')).toBe(true);
    expect(vault.deleteSecret('a')).toBe(false);
    expect(vault.secretNames).toEqual(['b']);
  });

  it('读取不存在的条目返回 null', () => {
    const vault = new Vault(path);
    vault.initialize('pw');
    expect(vault.getSecret('nope')).toBeNull();
  });

  it('覆盖写入取到最新值', () => {
    const vault = new Vault(path);
    vault.initialize('pw');
    vault.setSecret('k', 'v1');
    vault.setSecret('k', 'v2');
    expect(vault.getSecret('k')).toBe('v2');
    expect(vault.secretNames).toEqual(['k']);
  });

  it('支持 unicode 与空字符串', () => {
    const vault = new Vault(path);
    vault.initialize('pw');
    vault.setSecret('cn', '密码🔐');
    vault.setSecret('empty', '');
    expect(vault.getSecret('cn')).toBe('密码🔐');
    expect(vault.getSecret('empty')).toBe('');
  });
});