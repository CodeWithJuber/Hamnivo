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
    // The tests type with `userEvent.setup({ delay: null })`: the default waits for a timer after
    // every key, and on a busy CI server those waits pushed 18 walkthroughs past 15 s in the
    // image's checks stage (2026-11-24). Without them the same walkthroughs take about half the time.
    testTimeout: 15_000,
  },
});
