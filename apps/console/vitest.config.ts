import { defineConfig } from 'vitest/config';

// Unit and component tests (screens rendered to HTML, no browser); the browser journeys in e2e/
// and production/ run with Playwright.
export default defineConfig({
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
    setupFiles: ['./test/setup.ts'],
    // The set-up walkthroughs (email, WhatsApp, forms, appearance) click through several steps.
    // Alone each takes ~1-2 s; while turbo tests every package at once they passed 5 s and timed
    // out (2026-11-05). The budget is for CPU contention; assertions are unchanged.
    testTimeout: 15_000,
  },
});
