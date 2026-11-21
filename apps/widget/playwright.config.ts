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
    trace: 'retain-on-failure',
    // The journeys run as a visitor who asked for less motion: new messages and cards then
    // appear at once, so the accessibility audits measure them as they stay, never half faded
    // in. The motion itself is checked by the layout audit's browser checks (CHECK=live, sites).
    reducedMotion: 'reduce',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        ...(executablePath ? { launchOptions: { executablePath } } : {}),
      },
    },
    // Safari's engine, which no browser test reached before (production-ready plan, P0): the
    // visitor's journeys and the composer, whose input methods behave differently in Safari. The
    // other suites stay on Chromium; with one worker, each extra engine doubles their time.
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
      testMatch: ['journey.spec.ts', 'composer.spec.ts'],
    },
    // Phones, emulated: a touch screen, a phone's viewport and its user agent, where the chat
    // fills the screen. Most visitors come on a phone; emulation is not a real device, so the plan
    // still asks for one real iPhone and one Android phone before launch.
    {
      name: 'android',
      use: {
        ...devices['Pixel 7'],
        ...(executablePath ? { launchOptions: { executablePath } } : {}),
      },
      testMatch: ['journey.spec.ts'],
    },
    {
      name: 'iphone',
      use: { ...devices['iPhone 15'] },
      testMatch: ['journey.spec.ts'],
    },
  ],
  webServer: {
    command: 'node e2e/stack.ts',
    url: `http://127.0.0.1:${hostPort}/health`,
    timeout: 180_000,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
