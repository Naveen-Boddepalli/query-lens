import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { openForAudit } from './support/audit.ts';

/**
 * The route audit (`audit.spec.ts`) scans each page as it opens. Most of what a person sees is one click later: a
 * result after Run, a table in place of a chart, the other choice of a radio group. Two of this project's real
 * contrast failures lived only there (a solved challenge's banner, a toggled timeline), so this walks each page's
 * controls the way a person would and scans after every one of them:
 *
 *  1. press Run (or Run & check), and scan the result;
 *  2. press each "Show as table" toggle;
 *  3. choose each radio and tab in turn, one at a time.
 *
 * It does not know what any control means, which is the point — a control added next month is walked too.
 */

const ROUTES = [
  '/playground', '/compare', '/practice', '/challenges/exactly-one', '/challenges/read-the-unreal',
  '/challenges/ahead-of-its-log', '/challenges/one-merge-pass', '/challenges/one-page-deadlock',
  '/challenges/and-before-or', '/challenges/index-with-two-rules', '/challenges/win-despite-restarts',
  '/tools/buffer-pool', '/tools/parser', '/tools/planner', '/tools/btree', '/tools/page', '/tools/sort', '/tools/locks',
  '/tools/schedule', '/tools/isolation', '/tools/concurrency', '/tools/wal', '/tools/recovery', '/tools/grammar',
  '/tools/hash-join', '/tools/join-order', '/tools/histograms', '/tools/parallel', '/tools/partitioning', '/tools/2pc', '/tools/raft', '/tools/lsm', '/tools/hash-index', '/tools/columnar',
  '/tools/latch-crabbing', '/tools/vector-index', '/trace', '/progress', '/settings',
];

// One of each theme and each width: the two together cover what four runs of every state would.
const CONFIGS = [
  { theme: 'light', width: 1280 },
  { theme: 'dark', width: 360 },
] as const;

async function scan(page: Page, state: string): Promise<string[]> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  return results.violations.map(
    (v) => `${state}: ${v.id} (${String(v.nodes.length)} nodes) ${v.help} — ${v.nodes[0]?.target.join(' ') ?? ''}`,
  );
}

for (const route of ROUTES) {
  for (const { theme, width } of CONFIGS) {
    test(`${route} has no violations after its controls are used — ${theme}, ${String(width)} px`, async ({ page }) => {
      test.setTimeout(90_000);
      await openForAudit(page, route, theme, width);
      const found: string[] = [];

      const run = page.getByRole('button', { name: /^Run( & check)?$|^Run\b/ }).first();
      if ((await run.count()) > 0 && (await run.isEnabled())) {
        await run.click();
        await page.waitForTimeout(250);
        found.push(...(await scan(page, 'after Run')));
      }

      const toggles = page.getByRole('button', { name: /show as table/i });
      for (let i = 0; i < Math.min(await toggles.count(), 4); i++) {
        await toggles.nth(i).click();
        await page.waitForTimeout(150);
        found.push(...(await scan(page, `table toggle ${String(i + 1)}`)));
      }

      const choices = page.locator('[role=radio], [role=tab]');
      const n = Math.min(await choices.count(), 24);
      for (let i = 0; i < n; i++) {
        const choice = choices.nth(i);
        if (!(await choice.isVisible())) continue;
        const name = ((await choice.innerText()) || (await choice.getAttribute('aria-label')) || String(i)).trim();
        await choice.click();
        await page.waitForTimeout(150);
        found.push(...(await scan(page, `choice “${name.slice(0, 30)}”`)));
      }

      // The same finding in several states is one problem: say it once.
      expect([...new Set(found)]).toEqual([]);
    });
  }
}
