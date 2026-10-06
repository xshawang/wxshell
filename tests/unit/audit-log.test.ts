import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../../src/core/store/AuditLog';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';

let dir: string;
let path: string;

beforeEach(() => {
  dir = makeTmpDir('audit-');
  path = join(dir, 'audit.jsonl');
});
afterEach(() => removeTmpDir(dir));

describe('AuditLog', () => {
  it('追加并读回', () => {
    const log = new AuditLog(path);
    log.append('session.open', { sessionId: 's1', detail: { host: 'h' } });
    log.append('auth.ok', { sessionId: 's1' });

    const events = log.read();
    expect(events).toHaveLength(2);
    expect(events[0]!.type).toBe('session.open');
    expect(events[0]!.sessionId).toBe('s1');
    expect(events[1]!.type).toBe('auth.ok');
    expect(events[0]!.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('文件不存在时读回空数组', () => {
    const log = new AuditLog(join(dir, 'none.jsonl'));
    expect(log.read()).toEqual([]);
  });

  it('JSONL 每行一条且可逐行解析', () => {
    const log = new AuditLog(path);
    log.append('session.open', { sessionId: 'a' });
    log.append('session.close', { sessionId: 'a' });

    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });

  it('超过上限时轮转为 .1', () => {
    const log = new AuditLog(path, { maxBytes: 200 });
    for (let i = 0; i < 20; i += 1) log.append('exec', { sessionId: `s${i}` });

    expect(existsSync(`${path}.1`)).toBe(true);
    // 轮转后原文件重新开始
    const current = readFileSync(path, 'utf8').trim().split('\n').length;
    expect(current).toBeLessThan(20);
  });

  it('不做明文脱敏以外的事：只记录传入内容', () => {
    const log = new AuditLog(path);
    log.append('secret.set', { detail: { name: 'web-01' } });
    const raw = readFileSync(path, 'utf8');
    expect(raw).toContain('web-01');
    expect(raw).not.toContain('password');
  });

  it('已存在的文件继续追加而不截断', () => {
    writeFileSync(path, `${JSON.stringify({ ts: 'x', type: 'session.open' })}\n`);
    const log = new AuditLog(path);
    log.append('auth.ok');
    expect(log.read()).toHaveLength(2);
  });
});