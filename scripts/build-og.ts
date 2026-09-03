/**
 * Regenerate `public/og.png`, the link-preview card (plan.md §19.3).
 *
 *   pnpm og
 *
 * Why this is a script and not a design file
 * ------------------------------------------
 * §14.1 established that the card *is* the landing page: distribution is a link
 * posted to HN, Reddit or a course page, and most people decide from the
 * preview before the page ever loads. §19.3 adds the obligation that keeps it
 * honest — **regenerate it from a real trace whenever the visual design
 * changes**, or it becomes a picture of an app that no longer exists, which
 * that section calls the most quietly embarrassing failure mode available.
 *
 * A hand-made image cannot honour that; it drifts the moment a token moves. So
 * the card is a screenshot of the real application, at a real step of a real
 * trace, driven through the app's own shareable-URL format (§15.2). Re-run this
 * after any visual change and commit the result.
 *
 * What it captures, and why that moment
 * -------------------------------------
 * The sequential scan over the seed table, stopped at the step where the buffer
 * pool evicts. That is the single most legible frame in the product: eight
 * frames, one lit red as it is evicted, the hit and miss counters disagreeing,
 * and the pipeline tracker showing how far through the query it is. It is also
 * the frame that answers "what is this?" without a caption.
 */

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from '@playwright/test';

// Open Graph's most widely honoured size, and the one index.html declares in
// og:image:width / og:image:height. Those three numbers have to agree.
const WIDTH = 1200;
const HEIGHT = 630;

const PORT = 4174;
const ORIGIN = `http://localhost:${String(PORT)}`;

/**
 * The trace, and the moment in it.
 *
 * `SELECT * FROM users WHERE age > 30` is §9's sequential-scan contrast: 131
 * events, and the only query in the v0 subset that reads enough pages to fill
 * an eight-frame pool and start evicting. Step 91 is the first eviction —
 * verified by `pnpm trace "SELECT * FROM users WHERE age > 30" | grep evict`,
 * and asserted below rather than trusted, because an engine change that moves
 * the eviction must fail this script rather than quietly produce a card of the
 * wrong thing.
 *
 * Parameter names come from `src/ui/urlState.ts`: q=sql, p=policy, x=predict,
 * s=step. Prediction is off, because a prompt card would cover the panel.
 */
const SQL = 'SELECT *\nFROM users\nWHERE age > 30;';
const EVICTION_STEP = 91;

function shareUrl(): string {
  const params = new URLSearchParams({
    q: SQL,
    p: 'lru',
    x: '0',
    s: String(EVICTION_STEP),
  });
  return `${ORIGIN}/?${params.toString()}`;
}

async function waitForServer(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Not up yet.
    }
    await sleep(250);
  }
  throw new Error(`preview server never came up at ${url}`);
}

async function main(): Promise<void> {
  // The built output, not the dev server: the card should show what visitors
  // will actually see, including the production CSS and the real font files.
  const server = spawn('pnpm', ['preview', '--port', String(PORT), '--strictPort'], {
    stdio: 'ignore',
    detached: false,
  });

  try {
    await waitForServer(ORIGIN);

    const browser = await chromium.launch();
    const page = await browser.newPage({
      viewport: { width: WIDTH, height: HEIGHT },
      // Render at 2× and downsample on the way out: the card is displayed at
      // wildly different sizes across platforms, and a 1× capture of 11px
      // labels falls apart in Slack's compact preview.
      deviceScaleFactor: 2,
      // The card is the dark design. `colorScheme` alone would leave
      // public/theme.js resolving the system preference, which on a CI runner
      // is whatever that runner happens to be set to — so pin it explicitly.
      colorScheme: 'dark',
    });

    await page.goto(shareUrl(), { waitUntil: 'networkidle' });

    // Fonts before pixels: `font-display: swap` means a capture taken too early
    // shows the fallback face, which is precisely the drift this script exists
    // to prevent.
    await page.evaluate(() => document.fonts.ready);

    // The moment is asserted, not assumed. If an engine change moves the first
    // eviction, this throws instead of shipping a card of an ordinary step.
    const evicted = page.getByText('evicted', { exact: true });
    await evicted.waitFor({ state: 'visible', timeout: 10_000 });

    await page.screenshot({
      path: 'public/og.png',
      // `css` downsamples the 2× render to the declared 1200×630 rather than
      // emitting a 2400×1260 file that disagrees with the meta tags.
      scale: 'css',
      animations: 'disabled',
    });

    await browser.close();
    console.log(`✓ public/og.png — ${String(WIDTH)}×${String(HEIGHT)}, step ${String(EVICTION_STEP)} of the sequential scan`);
    console.log('  Update the og:image:alt text in index.html if the framing changed.');
  } finally {
    server.kill();
  }
}

await main();
