import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { openForAudit, THEMES_AND_WIDTHS } from './support/audit.ts';
import { ROUTES } from './support/routes.ts';

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
