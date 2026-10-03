import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/client.ts'],
  format: 'esm',
  dts: true,
  clean: true,
  platform: 'browser',
  // Next.js reads this line to know that the component and the hooks run in the browser, so a
  // server component can import them.
  banner: '"use client";',
});
