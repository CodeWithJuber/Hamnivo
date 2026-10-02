import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'commerce/index': 'src/commerce/index.ts',
    'actions/index': 'src/actions/index.ts',
  },
  format: 'esm',
  dts: true,
  clean: true,
  platform: 'neutral',
});
