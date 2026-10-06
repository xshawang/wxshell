import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // SSH / PTY 集成测试会起真实 socket 与子进程，超时放宽
    testTimeout: 40000,
    hookTimeout: 40000,
    // node-pty 是原生模块，在线程池里加载不稳定，用进程池隔离
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: false },
    },
  },
});