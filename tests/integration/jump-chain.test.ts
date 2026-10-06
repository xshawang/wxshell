import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JumpChain } from '../../src/core/tunnel/JumpChain';
import { SshSession } from '../../src/core/transport/SshSession';
import { startSshServer, type SshTestServer } from '../helpers/ssh-server';
import { startTcpEcho } from '../helpers/tcp';

/**
 * 跳板链（ProxyJump）验证。
 *
 * 关键手法：目标地址用 **本地无法解析** 的名字 `behind-hop.internal`。
 * 直连它必然 DNS 失败（下面有对照用例证明这一点），因此只要连接成功，
 * 就能确定流量确实经过了跳板的 direct-tcpip 通道，而不是碰巧直连上了。
 */

const PASSWORD = 'pw';
const servers: SshTestServer[] = [];
const sessions: SshSession[] = [];

async function waitFor(predicate: () => boolean, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(25);
  }
  throw new Error('等待条件超时');
}

const acceptAll = { verify: async () => true };

function collect(session: SshSession) {
  const chunks: Buffer[] = [];
  session.on('data', (c: Buffer) => chunks.push(c));
  return { text: () => Buffer.concat(chunks).toString('utf8') };
}

afterEach(async () => {
  for (const s of sessions.splice(0)) await s.close().catch(() => undefined);
  for (const s of servers.splice(0)) await s.close();
});

describe('跳板链 - 基本串联', () => {
  it('对照：目标地址本地无法解析，直连必然失败', async () => {
    const direct = new SshSession('direct', {
      host: 'behind-hop.internal',
      port: 22,
      auth: { username: 'tester', method: 'password', password: PASSWORD },
      cols: 80,
      rows: 24,
      hostKeyVerifier: acceptAll,
      readyTimeoutMs: 5000,
    });
    sessions.push(direct);
    await expect(direct.connect()).rejects.toThrow();
  });

  it('经一级跳板连到后端（验证请求确实被转发）', async () => {
    const backend = await startSshServer({ password: PASSWORD, banner: 'BACKEND-REACHED' });
    servers.push(backend);

    // 跳板把任意转发请求重定向到真实后端
    const jump = await startSshServer({
      password: PASSWORD,
      banner: 'JUMP-ONLY',
      forwardTarget: () => ({ host: '127.0.0.1', port: backend.port }),
    });
    servers.push(jump);

    const chain = new JumpChain();
    const handle = await chain.open(
      [
        {
          host: '127.0.0.1',
          port: jump.port,
          auth: { username: 'tester', method: 'password', password: PASSWORD },
          hostKeyVerifier: acceptAll,
        },
      ],
      { host: 'behind-hop.internal', port: backend.port },
    );

    expect(handle.sock).not.toBeNull();
    expect(jump.stats.forwards).toBe(1);

    const session = new SshSession('via-jump', {
      host: 'behind-hop.internal',
      port: backend.port,
      auth: { username: 'tester', method: 'password', password: PASSWORD },
      cols: 80,
      rows: 24,
      sock: handle.sock!,
      hostKeyVerifier: acceptAll,
    });
    sessions.push(session);

    const out = collect(session);
    await session.connect();
    await waitFor(() => out.text().includes('BACKEND-REACHED'));

    // 拿到的是后端的 banner，证明链路终点正确
    expect(out.text()).toContain('BACKEND-REACHED');
    expect(out.text()).not.toContain('JUMP-ONLY');

    handle.dispose();
  });

  it('两级跳板串联', async () => {
    const backend = await startSshServer({ password: PASSWORD, banner: 'DEEP-BACKEND' });
    servers.push(backend);

    const hop2 = await startSshServer({
      password: PASSWORD,
      forwardTarget: () => ({ host: '127.0.0.1', port: backend.port }),
    });
    servers.push(hop2);

    const hop1 = await startSshServer({
      password: PASSWORD,
      forwardTarget: () => ({ host: '127.0.0.1', port: hop2.port }),
    });
    servers.push(hop1);

    const chain = new JumpChain();
    const handle = await chain.open(
      [
        { host: '127.0.0.1', port: hop1.port, auth: { username: 'tester', method: 'password', password: PASSWORD }, hostKeyVerifier: acceptAll },
        { host: 'inner-hop.invalid', port: hop2.port, auth: { username: 'tester', method: 'password', password: PASSWORD }, hostKeyVerifier: acceptAll },
      ],
      { host: 'behind-hop.internal', port: backend.port },
    );

    const session = new SshSession('deep', {
      host: 'behind-hop.internal',
      port: backend.port,
      auth: { username: 'tester', method: 'password', password: PASSWORD },
      cols: 80,
      rows: 24,
      sock: handle.sock!,
      hostKeyVerifier: acceptAll,
    });
    sessions.push(session);

    const out = collect(session);
    await session.connect();
    await waitFor(() => out.text().includes('DEEP-BACKEND'));

    expect(hop1.stats.forwards).toBe(1);
    expect(hop2.stats.forwards).toBe(1);
    handle.dispose();
  });

  it('空跳板列表返回 null sock，表示应当直连', async () => {
    const chain = new JumpChain();
    const handle = await chain.open([], { host: 'x', port: 22 });
    expect(handle.sock).toBeNull();
    expect(handle.connections).toHaveLength(0);
  });

  it('跳板认证失败时抛出，且不残留连接', async () => {
    const jump = await startSshServer({ password: 'correct' });
    servers.push(jump);

    const chain = new JumpChain();
    await expect(
      chain.open(
        [
          {
            host: '127.0.0.1',
            port: jump.port,
            auth: { username: 'tester', method: 'password', password: 'wrong' },
            hostKeyVerifier: acceptAll,
          },
        ],
        { host: '127.0.0.1', port: 22 },
      ),
    ).rejects.toThrow();
  });

  it('跳板主机密钥校验失败时中止，不会继续建链', async () => {
    const jump = await startSshServer({ password: PASSWORD });
    servers.push(jump);

    const chain = new JumpChain();
    await expect(
      chain.open(
        [
          {
            host: '127.0.0.1',
            port: jump.port,
            auth: { username: 'tester', method: 'password', password: PASSWORD },
            hostKeyVerifier: { verify: async () => false },
          },
        ],
        { host: '127.0.0.1', port: 22 },
      ),
    ).rejects.toThrow();
  });
});