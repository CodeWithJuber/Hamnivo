import { defineConfig } from 'vitest/config';

// Unit tests only; the browser journeys in e2e/ run with Playwright.
export default defineConfig({
  test: { include: ['test/**/*.test.ts'] },
});
