import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

const hostPort = Number(process.env.E2E_HOST_PORT ?? 5180);
// Use the preinstalled Chromium where the environment provides one.
const executablePath =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ??
  (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node e2e/stack.ts',
    url: `http://127.0.0.1:${hostPort}/health`,
    timeout: 180_000,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
