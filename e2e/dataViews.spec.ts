import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const pages: [string, RegExp][] = [
  ['/tools/columnar', /Each column's encoding/],
  ['/tools/hash-index', /Directory:/],
  ['/tools/lsm', /SSTables by level/],
  ['/tools/join-order', /Every subset of the tables/],
];

for (const [path, caption] of pages) {
  test(`${path} has a table view of its data that is clean under axe (plan.md §H6)`, async ({ page }) => {
    await page.goto(path);
    const toggle = page.getByRole('button', { name: 'Show as table' }).first();
    await expect(toggle).toBeVisible();
    await toggle.click();

    const table = page.getByRole('table');
    await expect(table).toBeVisible();
    await expect(table.getByRole('caption')).toContainText(caption);
    await expect(table.getByRole('columnheader').first()).toBeVisible();

    const results = await new AxeBuilder({ page })
      .include('table')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

    await page.getByRole('button', { name: 'Show as diagram' }).first().click();
    await expect(page.getByRole('table')).toHaveCount(0);
  });
}
