import { defineConfig } from 'vitest/config';

// Unit and component tests (screens rendered to HTML, no browser); the browser journeys in e2e/
// and production/ run with Playwright.
export default defineConfig({
  test: { include: ['test/**/*.test.{ts,tsx}'], setupFiles: ['./test/setup.ts'] },
});
