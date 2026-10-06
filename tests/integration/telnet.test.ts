import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { TelnetSession } from '../../src/core/transport/TelnetSession';
import { DO, IAC, SB, SE, OPT, TTYPE_IS, WILL } from '../../src/core/telnet/IacParser';
import { startTelnetServer, type TelnetTestServer } from '../helpers/telnet-server';

/**
 * Telnet 集成测试。
 *
 * 夹具（tests/helpers/telnet-server.ts）在连接建立后主动发一轮协商
 * （WILL ECHO / DO NAWS / DO TERMINAL-TYPE / SB TERMINAL-TYPE SEND），
 * 并把收到的任何字节原样回声回来。这个回声很关键：客户端的协商回复会被
 * 服务端原样送回，等于用真实字节流检验"收到的协商也能被正确解析且不会
 * 触发协商死循环"。
 */

const servers: TelnetTestServer[] = [];
const sessions: TelnetSession[] = [];
let counter = 0;

function waitFor(predicate: () => boolean, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return (async () => {
    while (Date.now() < deadline) {
      if (predicate()) return;
      await delay(20);
    }
    throw new Error('等待条件超时');
  })();
}

function collect(session: TelnetSession) {
  const chunks: Buffer[] = [];
  session.on('data', (chunk: Buffer) => chunks.push(chunk));
  return {
    bytes: () => Buffer.concat(chunks),
    text: () => Buffer.concat(chunks).toString('utf8'),
  };
}

async function open(server: TelnetTestServer, cols = 120, rows = 30) {
  const session = new TelnetSession(`telnet-${counter++}`, {
    host: '127.0.0.1',
    port: server.port,
    cols,
    rows,
  });
  sessions.push(session);
  const out = collect(session);
  await session.connect();
  return { session, out };
}

/** 客户端发给服务端的全部字节 */
function clientBytes(server: TelnetTestServer): Buffer {
  return Buffer.concat(server.received);
}

function seq(...bytes: number[]): Buffer {
  return Buffer.from(bytes);
}

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close().catch(() => undefined);
  for (const server of servers.splice(0)) await server.close();
});

describe('Telnet 会话', () => {
  it('剥离 IAC 协商，只把纯数据交给终端', async () => {
    const server = await startTelnetServer();
    servers.push(server);

    const { out } = await open(server);
    await waitFor(() => out.text().includes('login: '));

    expect(out.text()).toBe('login: ');
    // 终端输出里不允许出现任何 0xFF —— 出现即说明协商字节漏进了数据流
    expect(out.bytes().includes(IAC)).toBe(false);
  });

  it('按 RFC 语义应答服务端协商（WILL ECHO→DO，DO NAWS→WILL+NAWS 尺寸）', async () => {
    const server = await startTelnetServer();
    servers.push(server);

    const { session } = await open(server, 120, 30);
    expect(session.state).toBe('ready');

    await waitFor(() => clientBytes(server).includes(seq(IAC, DO, OPT.ECHO)));
    await waitFor(() => clientBytes(server).includes(seq(IAC, WILL, OPT.NAWS)));

    // 同意 NAWS 后必须立刻上报当前窗口尺寸
    await waitFor(() =>
      clientBytes(server).includes(seq(IAC, SB, OPT.NAWS, 0, 120, 0, 30, IAC, SE)),
    );
  });

  it('应答 TERMINAL-TYPE 子协商并回送终端名', async () => {
    const server = await startTelnetServer();
    servers.push(server);

    await open(server);

    const expected = Buffer.concat([
      seq(IAC, SB, OPT.TERMINAL_TYPE, TTYPE_IS),
      Buffer.from('xterm-256color', 'ascii'),
      seq(IAC, SE),
    ]);
    await waitFor(() => clientBytes(server).includes(expected));
  });

  it('resize 会重新上报 NAWS 尺寸', async () => {
    const server = await startTelnetServer();
    servers.push(server);

    const { session } = await open(server, 120, 30);
    session.resize(100, 40);

    await waitFor(() =>
      clientBytes(server).includes(seq(IAC, SB, OPT.NAWS, 0, 100, 0, 40, IAC, SE)),
    );
  });

  it('数据双向透传', async () => {
    const server = await startTelnetServer();
    servers.push(server);

    const { session, out } = await open(server);
    session.write('admin\r\n');

    await waitFor(() => out.text().includes('admin\r\n'));
    expect(out.text()).toContain('admin\r\n');
  });

  it('IAC IAC 转义还原为单个 0xFF 数据字节', async () => {
    const server = await startTelnetServer();
    servers.push(server);

    const { out } = await open(server);
    // 客户端 connect 完成不等于服务端已经登记连接，先等服务端看到连接再发送
    await waitFor(() => server.clients > 0);
    server.send(Buffer.from([IAC, IAC, 0x41]));

    await waitFor(() => out.bytes().includes(0x41));
    expect(out.bytes().subarray(-2).equals(Buffer.from([0xff, 0x41]))).toBe(true);
  });

  it('close 幂等，重复关闭不会挂起', async () => {
    const server = await startTelnetServer();
    servers.push(server);

    const { session } = await open(server);
    await session.close();
    expect(session.state).toBe('closed');

    const started = Date.now();
    await session.close();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(session.state).toBe('closed');
  });

  it('目标端口不可达时 connect 直接失败', async () => {
    const probe = await startTelnetServer();
    const port = probe.port;
    await probe.close();

    const session = new TelnetSession('telnet-refused', {
      host: '127.0.0.1',
      port,
      cols: 80,
      rows: 24,
      connectTimeoutMs: 5000,
    });
    sessions.push(session);

    await expect(session.connect()).rejects.toThrow();
  });
});
