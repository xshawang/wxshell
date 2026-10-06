import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { RawTcpSession } from '../../src/core/transport/RawTcpSession';
import { startTcpEcho, type TcpEchoServer } from '../helpers/tcp';

const sessions: RawTcpSession[] = [];
const echoes: TcpEchoServer[] = [];
let counter = 0;

function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return (async () => {
    while (Date.now() < deadline) {
      if (predicate()) return;
      await delay(20);
    }
    throw new Error('等待条件超时');
  })();
}

function collect(session: RawTcpSession) {
  const chunks: Buffer[] = [];
  session.on('data', (chunk: Buffer) => chunks.push(chunk));
  return {
    bytes: () => Buffer.concat(chunks),
    text: () => Buffer.concat(chunks).toString('utf8'),
  };
}

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close().catch(() => undefined);
  for (const echo of echoes.splice(0)) await echo.close();
});

describe('裸 TCP 会话', () => {
  it('双向透传字节，且不做任何协议改写', async () => {
    const echo = await startTcpEcho();
    echoes.push(echo);

    const session = new RawTcpSession(`raw-${counter++}`, { host: '127.0.0.1', port: echo.port });
    sessions.push(session);
    const out = collect(session);
    await session.connect();
    expect(session.state).toBe('ready');

    const payload = Buffer.from([0x00, 0xff, 0x10, 0x0d, 0x0a, 0x7f]);
    session.write(payload);
    await waitFor(() => out.bytes().length >= payload.length);

    expect(out.bytes().equals(payload)).toBe(true);
    expect(Buffer.concat(echo.received).equals(payload)).toBe(true);
  });

  it('远端断开时进入 closed，原因是 remote', async () => {
    const echo = await startTcpEcho();
    echoes.push(echo);

    const session = new RawTcpSession(`raw-${counter++}`, { host: '127.0.0.1', port: echo.port });
    sessions.push(session);
    const out = collect(session);
    await session.connect();

    session.write('bye');
    await waitFor(() => out.text().includes('bye'));

    const closed = new Promise<string | undefined>((resolve) =>
      session.on('close', (info) => resolve(info.reason)),
    );
    await echo.close();

    expect(await closed).toBe('remote');
    expect(session.state).toBe('closed');
  });

  it('目标端口不可达时 connect 直接失败', async () => {
    const probe = await startTcpEcho();
    const port = probe.port;
    await probe.close();

    const session = new RawTcpSession(`raw-${counter++}`, { host: '127.0.0.1', port, connectTimeoutMs: 5000 });
    sessions.push(session);

    await expect(session.connect()).rejects.toThrow();
  });

  it('裸 TCP 不声明 resize/forward 能力，resize 是空操作', async () => {
    const echo = await startTcpEcho();
    echoes.push(echo);

    const session = new RawTcpSession(`raw-${counter++}`, { host: '127.0.0.1', port: echo.port });
    sessions.push(session);
    await session.connect();

    expect(session.capabilities.resize).toBe(false);
    expect(session.capabilities.forward).toBe(false);
    expect(() => session.resize()).not.toThrow();

    session.write('still-alive');
    await waitFor(() => Buffer.concat(echo.received).toString().includes('still-alive'));
  });

  it('close 幂等：重复关闭立即返回，不会挂起', async () => {
    const echo = await startTcpEcho();
    echoes.push(echo);

    const session = new RawTcpSession(`raw-${counter++}`, { host: '127.0.0.1', port: echo.port });
    sessions.push(session);
    await session.connect();

    await session.close();
    expect(session.state).toBe('closed');

    const started = Date.now();
    await session.close();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(session.state).toBe('closed');
  });
});
