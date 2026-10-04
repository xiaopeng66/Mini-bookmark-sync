import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,        // 允许 describe/test/expect 全局使用
    environment: 'node',  // 这些是纯逻辑单测，不需要 DOM
    include: ['test/**/*.test.js'],
  },
});
