import { describe, expect, it, vi } from 'vitest';
import { JumpChain, JumpChainPool, type JumpChainHandle, type JumpHop } from '../../src/core/tunnel/JumpChain';

/**
 * 跳板链复用池的测试。
 * JumpChain 本身依赖真实 SSH 连接，这里用替身验证池化逻辑：
 * 引用计数、幂等释放、空闲 TTL 回收。
 */

function makeStubChain() {
  const disposeSpies: Array<ReturnType<typeof vi.fn>> = [];
  const open = vi.fn(
    async (): Promise<JumpChainHandle> => {
      const dispose = vi.fn();
      disposeSpies.push(dispose);
      return { sock: null, connections: [], dispose };
    },
  );
  return { chain: { open } as unknown as JumpChain, open, disposeSpies };
}

const hops: JumpHop[] = [
  {
    host: 'jump1',
    port: 22,
    auth: { username: 'u', method: 'password', password: 'p' },
    hostKeyVerifier: { verify: async () => true },
  },
];

const target = { host: '10.0.0.9', port: 22 };

describe('JumpChainPool - 引用计数', () => {
  it('相同链路复用，只建立一次连接', async () => {
    const { chain, open } = makeStubChain();
    const pool = new JumpChainPool(chain);

    const a = await pool.acquireWith(hops, target);
    const b = await pool.acquireWith(hops, target);

    expect(open).toHaveBeenCalledTimes(1);
    expect(a.reuseKey).toBe(b.reuseKey);
    expect(pool.size).toBe(1);
  });

  it('不同目标不复用', async () => {
    const { chain, open } = makeStubChain();
    const pool = new JumpChainPool(chain);

    await pool.acquireWith(hops, target);
    await pool.acquireWith(hops, { host: '10.0.0.10', port: 22 });

    expect(open).toHaveBeenCalledTimes(2);
    expect(pool.size).toBe(2);
  });

  it('全部释放后进入空闲，TTL 到期才回收', async () => {
    const { chain, open } = makeStubChain();
    const timers: Array<() => void> = [];
    const pool = new JumpChainPool(chain, {
      idleTtlMs: 1000,
      setTimer: ((fn: () => void) => {
        timers.push(fn);
        return 0 as unknown as NodeJS.Timeout;
      }) as unknown as typeof setTimeout,
      clearTimer: () => {},
    });

    const lease = await pool.acquireWith(hops, target);
    const handle = (await pool.acquireWith(hops, target));
    lease.release();
    handle.release();

    // 还没到期：连接仍在，可以复用
    expect(pool.size).toBe(1);
    expect(timers).toHaveLength(1);

    timers[0]!();
    expect(pool.size).toBe(0);
  });

  it('TTL 未到前重新 acquire 会取消回收并复用', async () => {
    const { chain, open } = makeStubChain();
    const timers: Array<() => void> = [];
    const cleared: number[] = [];
    const pool = new JumpChainPool(chain, {
      idleTtlMs: 1000,
      setTimer: ((fn: () => void) => {
        timers.push(fn);
        return timers.length - 1 as unknown as NodeJS.Timeout;
      }) as unknown as typeof setTimeout,
      clearTimer: ((t: unknown) => cleared.push(t as number)) as unknown as typeof clearTimeout,
    });

    const first = await pool.acquireWith(hops, target);
    first.release();
    expect(timers).toHaveLength(1);

    await pool.acquireWith(hops, target);
    expect(cleared).toContain(0);
    expect(open).toHaveBeenCalledTimes(1);

    // 定时器即使被触发也不应误回收（引用计数已回到 1）
    timers[0]!();
    expect(pool.size).toBe(1);
  });

  it('重复 release 幂等，不会把引用计数打成负数', async () => {
    const { chain } = makeStubChain();
    const timers: Array<() => void> = [];
    const pool = new JumpChainPool(chain, {
      setTimer: ((fn: () => void) => {
        timers.push(fn);
        return 0 as unknown as NodeJS.Timeout;
      }) as unknown as typeof setTimeout,
      clearTimer: () => {},
    });

    const lease = await pool.acquireWith(hops, target);
    lease.release();
    lease.release();
    lease.release();

    // 若计数被减成负数，这里就不会再安排回收
    expect(timers).toHaveLength(1);
  });

  it('仍有引用时不安排回收', async () => {
    const { chain } = makeStubChain();
    const timers: Array<() => void> = [];
    const pool = new JumpChainPool(chain, {
      setTimer: ((fn: () => void) => {
        timers.push(fn);
        return 0 as unknown as NodeJS.Timeout;
      }) as unknown as typeof setTimeout,
      clearTimer: () => {},
    });

    const a = await pool.acquireWith(hops, target);
    await pool.acquireWith(hops, target);
    a.release();
    expect(timers).toHaveLength(0);
  });

  it('disposeAll 释放全部连接', async () => {
    const { chain, disposeSpies } = makeStubChain();
    const pool = new JumpChainPool(chain);
    const lease = await pool.acquireWith(hops, target);

    pool.disposeAll();
    expect(pool.size).toBe(0);
    expect(disposeSpies).toHaveLength(1);
    expect(disposeSpies[0]).toHaveBeenCalledTimes(1);

    // 池已清空，此时 release 不应再触发回收（也不能报错）
    lease.release();
    expect(pool.size).toBe(0);
  });

  it('委托建立失败时把错误向上抛', async () => {
    const failing = { open: vi.fn(async () => { throw new Error('跳板不可达'); }) } as unknown as JumpChain;
    const pool = new JumpChainPool(failing);
    await expect(pool.acquireWith(hops, target)).rejects.toThrow('跳板不可达');
    expect(pool.size).toBe(0);
  });
});

describe('JumpChainPool.keyOf', () => {
  it('用户名/主机/端口不同则键不同', () => {
    const k1 = JumpChainPool.keyOf(hops, target);
    const other: JumpHop[] = [{ ...hops[0]!, auth: { ...hops[0]!.auth, username: 'other' } }];
    expect(JumpChainPool.keyOf(other, target)).not.toBe(k1);
  });

  it('相同定义产生相同键', () => {
    expect(JumpChainPool.keyOf(hops, target)).toBe(JumpChainPool.keyOf(hops, target));
  });
});