import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 每个测试用独立临时目录，避免用例之间互相污染。 */
export function makeTmpDir(prefix = 'node-xshell-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function removeTmpDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
}