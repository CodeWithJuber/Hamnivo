import { defineConfig } from 'vitest/config';

// Unit tests only (pure rules, and screens rendered to HTML in Node); the browser journeys in e2e/
// run with Playwright.
export default defineConfig({
  test: { include: ['test/**/*.test.{ts,tsx}'] },
});
