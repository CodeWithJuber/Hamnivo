import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { loader: 'src/loader.ts' },
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  minify: true,
  dts: false,
  clean: true,
  outputOptions: { entryFileNames: 'loader.js' },
});
