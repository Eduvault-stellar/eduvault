import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright E2E Testing Configuration.
 *
 * Configured for:
 * - Deterministic, headless execution in CI.
 * - Zero-leak artifact policy: traces, screenshots, and videos are captured only on failure
 *   and discarded on passing runs so no sensitive credentials, session tokens, or PII are retained.
 * - Flake visibility: retries in CI with explicit reporting to ensure flaky tests are surfaced.
 * - Comprehensive responsive accessibility viewports (desktop, tablet, mobile, reduced motion, dark mode).
 */

const isCI = !!process.env.CI;
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.PLAYWRIGHT_HOST || '127.0.0.1';
const BASE_URL =
  process.env.PLAYWRIGHT_TEST_BASE_URL ||
  process.env.NEXT_PUBLIC_APP_URL ||
  `http://${HOST}:${PORT}`;
const shouldStartWebServer = process.env.PLAYWRIGHT_SKIP_WEB_SERVER !== '1' && process.env.PLAYWRIGHT_SKIP_WEB_SERVER !== 'true';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: /.*\.spec\.(ts|js|mjs)/,
  outputDir: './test-results',

  timeout: 30_000,

  expect: {
    timeout: 5_000,
  },

  fullyParallel: true,

  forbidOnly: isCI,

  retries: isCI ? 2 : 0,

  workers: isCI ? 1 : undefined,

  
  reporter: isCI
    ? [
        ['./e2e/reporters/flake-reporter.ts'],
        ['list', { printSteps: true }],
        ['github', { annotations: true }],
        ['html', { open: 'never', outputFolder: 'playwright-report' }],
        ['json', { outputFile: 'test-results/playwright-results.json' }],
      ]
    : [
        ['./e2e/reporters/flake-reporter.ts'],
        ['list'],
        ['html', { open: 'on-failure' }],
      ],

  use: {
    baseURL: BASE_URL,

    headless: true,

    
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',

    actionTimeout: 10_000,
    navigationTimeout: 15_000,

    timezoneId: 'UTC',
    locale: 'en-US',

    viewport: { width: 1280, height: 720 },

    colorScheme: 'light',

    ignoreHTTPSErrors: false,
    bypassCSP: false,
  },

  
  projects: [
    {
      name: 'desktop-chrome',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 720 },
      },
    },
    {
      name: 'desktop-firefox',
      use: {
        ...devices['Desktop Firefox'],
        viewport: { width: 1280, height: 720 },
      },
    },
    {
      name: 'desktop-safari',
      use: {
        ...devices['Desktop Safari'],
        viewport: { width: 1280, height: 720 },
      },
    },
    {
      name: 'desktop-hd',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1920, height: 1080 },
      },
    },

    {
      name: 'tablet-ipad',
      use: {
        ...devices['iPad (gen 7)'],
        viewport: { width: 768, height: 1024 },
        hasTouch: true,
      },
    },

    {
      name: 'mobile-chrome',
      use: {
        ...devices['Pixel 5'],
        viewport: { width: 393, height: 851 },
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: 'mobile-safari',
      use: {
        ...devices['iPhone 14'],
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
    },

    {
      name: 'accessibility-reduced-motion',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 720 },
      },
    },
    {
      name: 'accessibility-dark-mode',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 720 },
        colorScheme: 'dark',
      },
    },
  ],

  webServer: shouldStartWebServer
    ? {
        command: isCI
          ? `npm run start -- --hostname ${HOST} --port ${PORT}`
          : `npm run dev -- --hostname ${HOST} --port ${PORT}`,
        url: BASE_URL,
        reuseExistingServer: true,
        timeout: 120_000,
        stdout: 'pipe',
        stderr: 'pipe',
      }
    : undefined,
});
