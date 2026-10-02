import { defineConfig } from 'vitest/config';
import { swcPlugin } from './vitest.config.js';

/**
 * Live verification against real providers through the gateway (opt-in, never part of `pnpm test`
 * or `test:int`): real PostgreSQL and Valkey as for `test:int`, plus the provider's own service.
 *
 *   TYPESAFE_API_KEY=… pnpm --filter @hamnivo/gateway test:live
 *
 * Each file skips itself when its key is not in the environment. Keys are read from the
 * environment only and are never printed or written.
 */
export default defineConfig({
  plugins: [swcPlugin],
  oxc: false,
  test: {
    include: ['test/**/*.live.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
