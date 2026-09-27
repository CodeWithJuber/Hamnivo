import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'fake/index': 'src/fake/index.ts',
  },
  format: 'esm',
  dts: true,
  clean: true,
  platform: 'node',
  fixedExtension: false,
});
