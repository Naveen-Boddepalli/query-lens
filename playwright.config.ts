import { defineConfig, devices } from '@playwright/test';

/**
 * plan.md §14.2: one smoke test against the **built output**, because it is the
 * only test that catches "the deploy is broken". Vitest exercises the engine
 * and the components; nothing else here ever loads `dist/` in a real browser,
 * which is where a bad chunk split, a broken base path or a CSP that blocks the
 * bundle would show up — and every one of those fails silently in CI otherwise.
 *
 * `pnpm preview` serves exactly what `pnpm build` produced. Note that it does
 * not apply `public/_headers`; those are Cloudflare's to serve, and the CSP is
 * verified separately (§14.3).
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',

  use: {
    baseURL: 'http://localhost:4173',
    trace: 'on-first-retry',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  webServer: {
    command: 'pnpm preview --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
