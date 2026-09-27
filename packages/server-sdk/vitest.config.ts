import { defineConfig } from 'vitest/config';

// RSA key generation is slow on small machines.
export default defineConfig({ test: { include: ['test/**/*.test.ts'], testTimeout: 30_000 } });
