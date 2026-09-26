import { defineConfig } from 'vitest/config';

/** Integration tests against a real PostgreSQL (see docs/self-hosting.md or `pnpm ci:local`). */
export default defineConfig({
  test: {
    include: ['test/**/*.int.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
