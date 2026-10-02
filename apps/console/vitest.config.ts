import { defineConfig } from 'vitest/config';

// Unit tests only; the browser journeys in e2e/ and production/ run with Playwright.
export default defineConfig({
  test: { include: ['test/**/*.test.ts'] },
});
