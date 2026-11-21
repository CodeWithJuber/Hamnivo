import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  dts: true,
  clean: true,
  platform: 'neutral',
  // One module per source file, so an app's bundler keeps only the schemas it imports: the chat
  // widget uses a handful, and a single bundled file put all of them (and their zod) in its first
  // open (63 kB gzip, 2026-11-21). `sideEffects: false` in package.json lets it drop the rest.
  unbundle: true,
});
