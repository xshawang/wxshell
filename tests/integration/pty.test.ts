import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalPtySession } from '../../src/core/transport/LocalPtySession';
import { ConfigError } from '../../src/core/errors';

/**
 * 本地 Shell 集成测试 —— 走真 PTY（ConPTY），不是子进程管道。
 *
 * 本机实测决定了两处写法：
 *  1) node-pty 1.1.0 自带 win32-x64 预编译产物，直接可用，不需要 node-gyp 编译；
 *  2) `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` 在 ConPTY 下会被
 *     本机环境保护机制拦成一个交互式确认提示（"从不运行/不运行/运行一次/始终运行"），
 *     无法脚本化，所以这里固定用 cmd.exe。
 *     注意：同一个 powershell.exe 由普通子进程启动是正常的，问题只出现在 ConPTY 路径。
 */

const CMD = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\cmd.exe`;
const sessions: LocalPtySession[] = [];
let seq = 0;

function waitFor(predicate: () => boolean, timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return (async () => {
    while (Date.now() < deadline) {
      if (predicate()) return;
      await delay(50);
    }
    throw new Error('等待条件超时');
  })();
}

async function open(cols = 80, rows = 24): Promise<{ session: LocalPtySession; text: () => string; raw: () => Buffer }> {
  const session = new LocalPtySession(`pty-${seq++}`, {
    shell: CMD,
    args: [],
    cols,
    rows,
    cwd: process.cwd(),
  });
  sessions.push(session);
  const chunks: Buffer[] = [];
  session.on('data', (chunk: Buffer) => chunks.push(chunk));
  await session.connect();
  return {
    session,
    text: () => Buffer.concat(chunks).toString('utf8'),
    raw: () => Buffer.concat(chunks),
  };
}

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close().catch(() => undefined);
});

describe('本地 Shell（真 PTY）', () => {
  it('connect 后进入 ready，并解析出实际使用的 shell', async () => {
    const { session } = await open();
    expect(session.state).toBe('ready');
    expect(session.shellInfo?.path.toLowerCase()).toBe(CMD.toLowerCase());
    expect(session.shellInfo?.label).toBe('Command Prompt');
  });

  it('命令确实被 shell 执行（输出不是输入回显）', async () => {
    const { session, text } = await open();
    // 输入里是 "6*7"，回显里不会出现 "42"；只有真的执行了才会算出 42
    session.write('set /a 6*7\r\n');
    await waitFor(() => text().includes('42'));
    expect(text()).toContain('42');
  });

  it('中文输入输出经过 ConPTY 往返后不乱码', async () => {
    const { session, raw, text } = await open();
    session.write('echo 中文测试\r\n');
    await waitFor(() => text().includes('中文测试'));

    // 字节级校验：管线里出现的是 UTF-8 编码的 "中文测试"，没有被换成 GBK 或替换字符
    const utf8 = Buffer.from('中文测试', 'utf8');
    expect(utf8.toString('hex')).toBe('e4b8ade69687e6b58be8af95');
    expect(raw().includes(utf8)).toBe(true);
    expect(text()).not.toContain('\uFFFD');
  });

  it('resize 会改变 PTY 的实际窗口尺寸', async () => {
    const { session, text } = await open(80, 24);
    session.resize(120, 40);
    // cmd 的 mode con 直接读控制台尺寸，能反证 resize 真的传到了 ConPTY
    session.write('mode con\r\n');
    await waitFor(() => text().includes('120'));
    const after = text();
    expect(after).toContain('120');
    expect(after).toContain('40');
  });

  it('close 之后状态停在 closed，重复 close 是幂等的', async () => {
    const { session } = await open();
    await session.close();
    expect(session.state).toBe('closed');

    await expect(session.close()).resolves.toBeUndefined();
    expect(session.state).toBe('closed');
  });

  it('指定的 shell 不存在时立即报错，不会留下半开的进程', async () => {
    const session = new LocalPtySession('bad-shell', {
      shell: 'C:\\no\\such\\shell.exe',
      cols: 80,
      rows: 24,
    });
    sessions.push(session);

    await expect(session.connect()).rejects.toThrow(ConfigError);
    expect(session.state).not.toBe('ready');
  });
});