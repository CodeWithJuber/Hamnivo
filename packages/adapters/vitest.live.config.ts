import { defineConfig } from 'vitest/config';

/**
 * Live verification against real providers (opt-in, never part of `pnpm test`):
 *
 *   TYPESAFE_API_KEY=… pnpm --filter @hamnivo/adapters test:live
 *
 * Each file skips itself when its key is not in the environment. Keys are read from the
 * environment only and are never printed or written.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.live.test.ts'],
    testTimeout: 30_000,
    // One file at a time, so the calls stay well under the provider's rate limits.
    fileParallelism: false,
  },
});
