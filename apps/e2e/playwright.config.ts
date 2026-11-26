import { defineConfig } from '@playwright/test';

/**
 * Playwright config for ruidong-console E2E.
 *
 * Target: billing API (http://localhost:3010). In CI the pipeline boots the
 * billing API before Playwright runs; locally run `pnpm dev` in another shell.
 */

const BASE_API = process.env.E2E_API_URL ?? 'http://localhost:3010';

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false, // E2E touches shared DB state; serialize to avoid flakes
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ...(process.env.CI ? ([['github', {}]] as const) : []),
  ],
  use: {
    baseURL: BASE_API,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
    extraHTTPHeaders: {
      'x-e2e-test': '1',
    },
  },
  projects: [
    {
      name: 'api',
      testMatch: /.*\.api\.spec\.ts$/,
      use: { baseURL: BASE_API },
    },
  ],
  outputDir: 'test-results',
});
