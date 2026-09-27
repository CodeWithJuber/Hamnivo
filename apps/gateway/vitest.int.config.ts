import { defineConfig } from 'vitest/config';
import { swcPlugin } from './vitest.config.js';

/** Gateway integration tests: real PostgreSQL and Valkey (see docs/self-hosting.md). */
export default defineConfig({
  plugins: [swcPlugin],
  oxc: false,
  test: {
    include: ['test/**/*.int.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
