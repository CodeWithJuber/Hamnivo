import { defineConfig } from 'vitest/config';

/** Contract suite against a real Chatwoot (CHATWOOT_URL + CHATWOOT_PLATFORM_TOKEN). */
export default defineConfig({
  test: {
    include: ['test/**/*.int.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
