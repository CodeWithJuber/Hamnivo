import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

// Use the preinstalled Chromium where the environment provides one.
const executablePath =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ??
  (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);

/**
 * Studio on a running production stack (deploy/production), through its HTTPS edge. Started by
 * scripts/ci/production-smoke.sh, which passes the stack's origins in SMOKE_* variables. That
 * stack uses Caddy's internal CA, which this browser does not know, so certificate errors are
 * ignored; everything else (CSP, CORS, secure cookies) applies as it would in production.
 */
export default defineConfig({
  testDir: 'production',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 240_000,
  expect: { timeout: 20_000 },
  reporter: [['list']],
  outputDir: 'test-results/production',
  use: {
    ...devices['Desktop Chrome'],
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
  },
});
