import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    reporters: ['default'],
    maxWorkers: 4,
    testTimeout: 15_000,
  },
});
