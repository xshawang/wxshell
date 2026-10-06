import { describe, expect, it } from 'vitest';
import { utils } from 'ssh2';
import { parseSshKeyBlobAlgorithm, sshKeyBase64, sshKeyFingerprint } from '../../src/core/ssh/sshKeyBlob';
import { generateKeyPair } from '../helpers/keys';

describe('SSH 公钥块解析', () => {
  it('从真实密钥块中解析出算法名', () => {
    const { public: publicKey } = generateKeyPair('ed25519');
    const parsed = utils.parseKey(publicKey);
    expect(parsed).not.toBeInstanceOf(Error);

    const blob = (parsed as Exclude<typeof parsed, Error>).getPublicSSH();
    expect(parseSshKeyBlobAlgorithm(blob)).toBe('ssh-ed25519');
  });

  it('rsa 密钥同样可解析', () => {
    const { public: publicKey } = generateKeyPair('rsa', { bits: 2048 });
    const parsed = utils.parseKey(publicKey) as Exclude<ReturnType<typeof utils.parseKey>, Error>;
    expect(parseSshKeyBlobAlgorithm(parsed.getPublicSSH())).toBe('ssh-rsa');
  });

  it('长度字段越界的块返回 null 而不是抛错', () => {
    expect(parseSshKeyBlobAlgorithm(Buffer.from([0x00, 0x00, 0x00, 0x7f, 0x41]))).toBeNull();
  });

  it('过短的块返回 null', () => {
    expect(parseSshKeyBlobAlgorithm(Buffer.from([0x01, 0x02]))).toBeNull();
  });
});

describe('指纹格式', () => {
  it('符合 OpenSSH 的 SHA256:base64 形式且无 padding', () => {
    const blob = Buffer.from('some-key-material');
    const fp = sshKeyFingerprint(blob);
    expect(fp.startsWith('SHA256:')).toBe(true);
    expect(fp.endsWith('=')).toBe(false);
    expect(fp.slice(7)).toMatch(/^[A-Za-z0-9+/]+$/);
  });

  it('同一密钥指纹稳定，不同密钥不同', () => {
    const a = sshKeyFingerprint(Buffer.from('key-a'));
    const b = sshKeyFingerprint(Buffer.from('key-b'));
    expect(sshKeyFingerprint(Buffer.from('key-a'))).toBe(a);
    expect(a).not.toBe(b);
  });

  it('与 OpenSSH 官方算法一致（对已知输入比对）', () => {
    // echo -n "test" | openssl dgst -sha256 -binary | base64
    const fp = sshKeyFingerprint(Buffer.from('test'));
    expect(fp).toBe('SHA256:n4bQgYhMfWWaL+qgxVrQFaO/TxsrC4Is0V1sFbDwCgg');
  });

  it('base64 输出可被 known_hosts 直接使用', () => {
    const blob = Buffer.from([1, 2, 3, 4, 5]);
    expect(Buffer.from(sshKeyBase64(blob), 'base64')).toEqual(blob);
  });
});
