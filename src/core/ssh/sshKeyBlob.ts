import { createHash } from 'node:crypto';

/**
 * SSH 公钥二进制块（RFC 4253 §6.6）的第一段就是算法名。
 * known_hosts 里存的是这个块的 base64；ssh2 的 hostVerifier 只给原始块，
 * 不告诉算法名，所以需要自己解析出来才能构造 known_hosts 的主键。
 */
export function parseSshKeyBlobAlgorithm(blob: Buffer): string | null {
  if (blob.length < 4) return null;
  const len = blob.readUInt32BE(0);
  if (len <= 0 || 4 + len > blob.length) return null;
  return blob.subarray(4, 4 + len).toString('ascii');
}

/** OpenSSH 风格的指纹：SHA256: + 无填充 base64 */
export function sshKeyFingerprint(blob: Buffer): string {
  const digest = createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');
  return `SHA256:${digest}`;
}

/** known_hosts 中存储的密钥字段 */
export function sshKeyBase64(blob: Buffer): string {
  return blob.toString('base64');
}