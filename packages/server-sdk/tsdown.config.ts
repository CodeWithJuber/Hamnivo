import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  dts: true,
  clean: true,
  // Web Crypto and jose only, no Node built-ins.
  platform: 'neutral',
});
