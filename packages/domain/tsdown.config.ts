import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'commerce/index': 'src/commerce/index.ts',
    'billing/index': 'src/billing/index.ts',
    'analytics/index': 'src/analytics/index.ts',
    'actions/index': 'src/actions/index.ts',
    'automations/index': 'src/automations/index.ts',
  },
  format: 'esm',
  dts: true,
  clean: true,
  platform: 'neutral',
});
