import { defineConfig, devices } from '@playwright/test';

// E2E_BASE_URL targets a running stack (e.g. https://localhost from docker compose);
// otherwise Playwright builds and serves the web app itself.
const baseURL = process.env.E2E_BASE_URL;

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? 'line' : 'list',
  use: {
    baseURL: baseURL ?? 'http://localhost:4173',
    ignoreHTTPSErrors: true,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  ...(baseURL
    ? {}
    : {
        webServer: {
          command: 'pnpm exec vite build && pnpm exec vite preview --port 4173 --strictPort',
          url: 'http://localhost:4173',
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
        },
      }),
});
