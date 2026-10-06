import { utils } from 'ssh2';

export interface GeneratedKeyPair {
  private: string;
  public: string;
}

/**
 * 生成一对 SSH 密钥，并保证它真的能被 ssh2 自己解析。
 *
 * 为什么要包一层：ssh2 1.17.0 的 `utils.generateKeyPairSync` 偶发产出连它自己的
 * `parseKey` 都判定为 `Malformed OpenSSH private key` 的私钥 —— 本机实测 ed25519
 * 约 2/300。生成它的 `new Server({ hostKeys })` 会直接抛错，表现为随机失败的测试。
 * 这是上游缺陷，我们这层做"生成后立即校验，不通过就重生成"。
 */
export function generateKeyPair(
  type: 'ed25519' | 'rsa' = 'ed25519',
  options?: { bits?: number },
  attempts = 25,
): GeneratedKeyPair {
  for (let i = 0; i < attempts; i += 1) {
    const pair = type === 'rsa'
      ? utils.generateKeyPairSync('rsa', { bits: options?.bits ?? 2048 })
      : utils.generateKeyPairSync('ed25519');
    if (!(utils.parseKey(pair.private) instanceof Error)) return pair;
  }
  throw new Error(`ssh2 连续 ${attempts} 次生成的 ${type} 密钥都无法解析`);
}