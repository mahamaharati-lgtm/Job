import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 90_000,
    hookTimeout: 90_000,
    pool: 'forks',
    poolOptions: {
      forks: { execArgv: ['--disable-warning=ExperimentalWarning'] },
    },
    // Each test file gets its own temporary data directory (see tests/helpers.ts).
    fileParallelism: true,
  },
});
