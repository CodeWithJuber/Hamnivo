import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

const port = 5190;
const baseURL = `http://127.0.0.1:${port}`;
// Use the preinstalled Chromium where the environment provides one.
const executablePath =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ??
  (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);

// The tests check the static build, the same files a web server would serve.
if (!existsSync(new URL('./dist/index.html', import.meta.url))) {
  throw new Error('No build found: run "pnpm --filter @hamnivo/site build" first.');
}

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  timeout: 60_000,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
    baseURL,
    trace: 'retain-on-failure',
  },
  webServer: {
    // --ignore-lock keeps the server in the foreground (Astro backgrounds it when an AI agent runs
    // the command) and leaves any developer's own preview server alone.
    command: `pnpm exec astro preview --port ${port} --host 127.0.0.1 --ignore-lock`,
    url: `${baseURL}/`,
    timeout: 60_000,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
