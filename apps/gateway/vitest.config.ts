import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/** SWC compiles NestJS decorators with metadata (the default transformer does not emit it). */
export const swcPlugin = swc.vite({
  jsc: {
    parser: { syntax: 'typescript', decorators: true },
    transform: { legacyDecorator: true, decoratorMetadata: true },
    target: 'es2023',
  },
});

export default defineConfig({
  plugins: [swcPlugin],
  oxc: false,
  test: {
    include: ['test/**/*.test.ts'],
    // Integration tests need PostgreSQL and Valkey; live tests call real providers (opt-in).
    exclude: ['test/**/*.int.test.ts', 'test/**/*.live.test.ts'],
  },
});
