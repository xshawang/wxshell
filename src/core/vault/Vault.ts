import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { InvalidPasswordError, VaultLockedError } from '../errors';
import { readJsonFileSync, writeJsonAtomicSync } from '../store/JsonFile';

/**
 * 凭据保险库。
 *
 * 密钥层次（两层，避免直接用主密码加密每条密文）：
 *   主密码 --scrypt--> KEK
 *   每条密文独立随机 DEK，DEK 由 KEK 用 AES-256-GCM 包裹
 * 这样改主密码只需重新包裹 DEK，不必重加密全部数据；也避免同一密钥加密大量数据。
 *
 * 明文的凭据只经过主进程内存，任何持久化形态都是密文。
 */

export interface KdfParams {
  N: number;
  r: number;
  p: number;
  keylen: number;
}

export const DEFAULT_KDF_PARAMS: KdfParams = { N: 32768, r: 8, p: 1, keylen: 32 };

export interface SealedBox {
  iv: string;
  ct: string;
  tag: string;
}

interface VaultFile {
  version: number;
  kdf: KdfParams & { name: 'scrypt'; salt: string };
  check: SealedBox;
  items: Record<string, { dek: SealedBox; value: SealedBox }>;
}

const VAULT_VERSION = 1;
const VERIFIER_PLAINTEXT = 'node-xshell/vault/v1';

export function deriveKek(password: string, salt: Buffer, params: KdfParams = DEFAULT_KDF_PARAMS): Buffer {
  // scrypt 的内存占用约为 128*N*r，Node 默认 maxmem 只有 32 MiB，
  // N=32768/r=8 时恰好触及上限并抛错，必须显式放宽。
  const required = 128 * params.N * params.r;
  return scryptSync(password, salt, params.keylen, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: required * 2 + 1024 * 1024,
  });
}

export function seal(key: Buffer, plaintext: Buffer): SealedBox {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    iv: iv.toString('base64'),
    ct: ct.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

export function open(key: Buffer, box: SealedBox): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(box.ct, 'base64')), decipher.final()]);
}

export class Vault {
  private kek: Buffer | null = null;
  private file: VaultFile | null = null;

  constructor(
    private readonly path: string,
    private readonly params: KdfParams = DEFAULT_KDF_PARAMS,
  ) {
    this.file = readJsonFileSync<VaultFile | null>(path, null);
  }

  get isInitialized(): boolean {
    return this.file !== null;
  }

  get isUnlocked(): boolean {
    return this.kek !== null;
  }

  get secretNames(): string[] {
    return Object.keys(this.file?.items ?? {}).sort();
  }

  initialize(masterPassword: string): void {
    if (this.isInitialized) throw new Error('保险库已存在，不能重复初始化');
    const salt = randomBytes(16);
    const kek = deriveKek(masterPassword, salt, this.params);
    this.file = {
      version: VAULT_VERSION,
      kdf: { name: 'scrypt', ...this.params, salt: salt.toString('base64') },
      check: seal(kek, Buffer.from(VERIFIER_PLAINTEXT, 'utf8')),
      items: {},
    };
    this.kek = kek;
    this.save();
  }

  unlock(masterPassword: string): void {
    if (!this.file) throw new Error('保险库尚未初始化');
    const salt = Buffer.from(this.file.kdf.salt, 'base64');
    const kek = deriveKek(masterPassword, salt, this.file.kdf);

    let ok = false;
    try {
      const plain = open(kek, this.file.check);
      const expected = Buffer.from(VERIFIER_PLAINTEXT, 'utf8');
      ok = plain.length === expected.length && timingSafeEqual(plain, expected);
    } catch {
      ok = false;
    }

    if (!ok) {
      kek.fill(0);
      throw new InvalidPasswordError();
    }
    this.kek = kek;
  }

  lock(): void {
    if (this.kek) this.kek.fill(0);
    this.kek = null;
  }

  setSecret(name: string, value: string): void {
    const kek = this.requireKek();
    const file = this.requireFile();
    const dek = randomBytes(32);
    try {
      file.items[name] = {
        dek: seal(kek, dek),
        value: seal(dek, Buffer.from(value, 'utf8')),
      };
    } finally {
      dek.fill(0);
    }
    this.save();
  }

  getSecret(name: string): string | null {
    const kek = this.requireKek();
    const file = this.requireFile();
    const item = file.items[name];
    if (!item) return null;

    const dek = open(kek, item.dek);
    try {
      return open(dek, item.value).toString('utf8');
    } finally {
      dek.fill(0);
    }
  }

  deleteSecret(name: string): boolean {
    const file = this.requireFile();
    this.requireKek();
    if (!file.items[name]) return false;
    delete file.items[name];
    this.save();
    return true;
  }

  has(name: string): boolean {
    return Boolean(this.file?.items[name]);
  }

  save(): void {
    const file = this.requireFile();
    writeJsonAtomicSync(this.path, file);
  }

  private requireKek(): Buffer {
    if (!this.kek) throw new VaultLockedError();
    return this.kek;
  }

  private requireFile(): VaultFile {
    if (!this.file) throw new Error('保险库尚未初始化');
    return this.file;
  }
}

export function vaultExists(path: string): boolean {
  return existsSync(path);
}