import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { openForAudit, THEMES_AND_WIDTHS } from './support/audit.ts';

/**
 * plan.md §H6: an automated WCAG 2.2 AA pass over every route. It is a regression net and a part of the audit a
 * conformance statement needs, not the statement itself: automated tooling finds a share of WCAG failures, and the
 * manual screen-reader pass is still the other part (§8).
 *
 * Two things this has to get right, both learned by having it wrong:
 *  - **Wait for the page, not the shell.** Every route is a lazy chunk, and `#root > *` is satisfied by the shell
 *    before the page's own content has rendered, so a scan that waited for it was sometimes scanning a loading
 *    screen — passing for the wrong reason, and failing on the runs where the chunk was quick. The scan waits for
 *    the network to settle and for the page's first heading.
 *  - **Both themes and a phone width.** A palette has its own contrasts, and a column that is wide enough on a laptop
 *    scrolls at 360 px — which is what `scrollable-region-focusable` is about.
 */
const ROUTES = [
  '/', '/playground', '/stages', '/stages/parse', '/learn', '/learn/one-row', '/learn/dirty-read', '/challenges',
  '/challenges/exactly-one', '/challenges/read-the-unreal', '/challenges/ahead-of-its-log',
  '/challenges/one-merge-pass', '/challenges/bigger-pool-more-misses', '/challenges/index-with-two-rules',
  '/challenges/one-page-deadlock', '/challenges/and-before-or', '/learn/lock-table', '/tools', '/tools/buffer-pool', '/tools/parser', '/tools/planner', '/tools/btree',
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
  for (const { theme, width } of THEMES_AND_WIDTHS) {
    test(`${route} has no detectable WCAG 2.2 A/AA violations — ${theme}, ${String(width)} px (plan.md §H6)`, async ({ page }) => {
      await openForAudit(page, route, theme, width);
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(
        results.violations.map(
          (v) => `${v.id} (${String(v.nodes.length)} nodes): ${v.help} — ${v.nodes[0]?.target.join(' ') ?? ''}`,
        ),
      ).toEqual([]);
    });
  }
}
