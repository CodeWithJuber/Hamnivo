import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { 'models/index': 'src/models/index.ts' },
  format: 'esm',
  dts: true,
  clean: true,
  platform: 'neutral',
});
