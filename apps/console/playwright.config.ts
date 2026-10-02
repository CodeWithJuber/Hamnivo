import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

const consolePort = Number(process.env.E2E_STUDIO_PORT ?? 5186);
// Use the preinstalled Chromium where the environment provides one.
const executablePath =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ??
  (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);

// The tests use the static build, the same files a web server would serve.
if (!existsSync(new URL('./dist/index.html', import.meta.url))) {
  throw new Error('No build found: run "pnpm --filter @hamnivo/console build" first.');
}

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
    // A host name, not an IP address: passkeys (WebAuthn) refuse IP addresses.
    baseURL: `http://localhost:${consolePort}`,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node e2e/stack.ts',
    url: `http://127.0.0.1:${consolePort}/health`,
    timeout: 180_000,
    // E2E_REUSE_STACK=1 runs against a stack already started with `node e2e/stack.ts`.
    reuseExistingServer: process.env.E2E_REUSE_STACK === '1',
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
