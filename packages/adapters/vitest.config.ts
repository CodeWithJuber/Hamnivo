import { configDefaults, defineConfig } from 'vitest/config';

// Live tests call real providers with real keys: only `pnpm test:live` runs them (opt-in).
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '**/*.live.test.ts'],
  },
});
