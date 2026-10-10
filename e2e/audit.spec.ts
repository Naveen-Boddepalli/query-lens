import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

/**
 * plan.md §H6: an automated WCAG 2.2 AA pass over every route. It is a regression net and a part of the audit a
 * conformance statement needs, not the statement itself: automated tooling finds a share of WCAG failures, and the
 * manual screen-reader pass is still the other part (§8).
 */
const ROUTES = [
  '/', '/playground', '/stages', '/stages/parse', '/learn', '/learn/one-row', '/challenges',
  '/challenges/exactly-one', '/tools', '/tools/buffer-pool', '/tools/parser', '/tools/planner', '/tools/btree',
  '/tools/page', '/tools/sort', '/tools/locks', '/tools/schedule', '/tools/isolation', '/tools/concurrency', '/tools/wal', '/tools/recovery', '/tools/grammar', '/tools/hash-join', '/tools/join-order',
  '/tools/lsm', '/tools/hash-index', '/tools/columnar', '/tools/latch-crabbing', '/tools/vector-index', '/gallery',
  '/examples', '/trace', '/compare', '/progress', '/practice', '/settings', '/assignments/new', '/study', '/docs',
  '/docs/getting-started', '/docs/faq', '/docs/architecture', '/docs/concepts/btree', '/docs/concepts/buffer-pool',
  '/docs/manual/eviction', '/docs/manual/btree-split', '/docs/essays/index-write-tax',
  '/docs/essays/scan-resistance', '/docs/essays/repeatable-read', '/docs/study/course-map', '/docs/study/interview-roadmap',
  '/docs/reference/sql', '/docs/reference/url-parameters', '/docs/reference/shortcuts', '/docs/reference/limits',
  '/docs/reference/answers', '/docs/accessibility', '/nothing-here',
];

for (const route of ROUTES) {
  test(`${route} has no detectable WCAG 2.2 A/AA violations (plan.md §H6)`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(route);
    await expect(page.locator('main, [role="main"], #root > *').first()).toBeVisible();
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(results.violations.map((v) => `${v.id} (${String(v.nodes.length)} nodes): ${v.help}`)).toEqual([]);
  });
}
