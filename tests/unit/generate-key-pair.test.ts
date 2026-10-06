import { Server, utils } from 'ssh2';
import { describe, expect, it } from 'vitest';
import { generateKeyPair } from '../helpers/keys';

/**
 * 回归用例：ssh2 1.17.0 的 `utils.generateKeyPairSync` 偶发产出连它自己的 `parseKey`
 * 都判定为 "Malformed OpenSSH private key" 的私钥（本机实测 ed25519 约 2/300）。
 * 夹具层的 generateKeyPair 会在生成后立即校验并重试，这里守住这个契约，
 * 否则集成测试会以"随机失败"的形式回退。
 */
describe('测试夹具 - 主机密钥生成', () => {
  it('生成的私钥始终能被 ssh2 解析', () => {
    for (let i = 0; i < 30; i += 1) {
      const pair = generateKeyPair('ed25519');
      expect(utils.parseKey(pair.private)).not.toBeInstanceOf(Error);
      expect(utils.parseKey(pair.public)).not.toBeInstanceOf(Error);
    }
  });

  it('生成的私钥可以直接交给 ssh2 Server（构造时也会解析一次）', () => {
    const pair = generateKeyPair('ed25519');
    expect(() => new Server({ hostKeys: [pair.private] }, () => undefined)).not.toThrow();
  });

  it('rsa 同样可用', () => {
    const pair = generateKeyPair('rsa', { bits: 2048 });
    expect(utils.parseKey(pair.private)).not.toBeInstanceOf(Error);
    expect(() => new Server({ hostKeys: [pair.private] }, () => undefined)).not.toThrow();
  });
});