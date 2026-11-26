import { expect, test } from '@playwright/test';
import { findOverflows, unpinLayout } from './support/layout.ts';
import { ROUTES } from './support/routes.ts';

/**
 * Every tool fits, at a desktop width and at a phone's (docs/research/tool-layouts.md §5.1, phase 0): nothing
 * widens the page, nothing sticks out of its card, and nothing is cut off inside one. The tool-layout audit found
 * each of those by eye; this is the net that keeps them found while the tools move onto the shared workbench.
 *
 * `TOOL_SHOTS=1` also saves a full-page screenshot of every tool at both widths into the test output, the
 * before-and-after record for each migration. A failing test attaches one regardless.
 */
const TOOLS = ROUTES.filter((r) => r.startsWith('/tools/'));
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'phone', width: 375, height: 812 },
] as const;

test('the tool list is the tools', () => {
  expect(TOOLS.length).toBeGreaterThanOrEqual(25);
});

for (const vp of VIEWPORTS) {
  test.describe(`at ${vp.name} width (${String(vp.width)}px)`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    for (const tool of TOOLS) {
      test(`${tool} fits`, async ({ page }, testInfo) => {
        await page.goto(tool);
        // A cold preview server can take a while to serve a tool's lazy chunk the first time.
        await expect(page.locator('h2').first()).toBeVisible({ timeout: 15_000 });
        // Lazy diagrams and measured layouts settle after the first paint.
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(300);

        const overflows = await findOverflows(page);

        if (overflows.length > 0 || process.env.TOOL_SHOTS) {
          await unpinLayout(page);
          await testInfo.attach(`${tool.slice('/tools/'.length)}-${vp.name}.png`, {
            body: await page.screenshot({ fullPage: true }),
            contentType: 'image/png',
          });
        }

        expect(overflows, overflows.map((o) => `${o.kind} by ${String(o.by)}px: ${o.what}`).join('\n')).toEqual([]);
      });
    }
  });
}
