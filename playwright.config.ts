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
  // In CI a failure is retried once, which records a trace of the retry (`trace` below) — and a test that then
  // passes is *flaky*, which fails the build rather than going green unnoticed. A flake here has been a real race
  // more than once: the tour's hand-off ignored a click about one run in twenty-five, hidden by this very retry.
  retries: process.env.CI ? 1 : 0,
  failOnFlakyTests: !!process.env.CI,
  // `github` annotates the PR; `html` writes `playwright-report/`, the folder CI uploads on failure, traces included.
  // `shards.ts` reports nothing: it deals the tests out when CI runs `--shard=i/3` (it says why).
  reporter: [
    ['./e2e/support/shards.ts'],
    ...(process.env.CI ? [['github'], ['html', { open: 'never' }]] as const : [['list']] as const),
  ],

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
