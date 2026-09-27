import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    'models/index': 'src/models/index.ts',
    'jev/index': 'src/jev/index.ts',
    'commerce/index': 'src/commerce/index.ts',
    'commerce/testing': 'src/commerce/testing.ts',
  },
  format: 'esm',
  dts: true,
  clean: true,
  platform: 'neutral',
  // The commerce mock and the fake Stripe server run in Node only (tests and the worker).
  external: [/^node:/],
});
