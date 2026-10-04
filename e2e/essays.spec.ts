import { expect, test } from '@playwright/test';

test('the scan essay links open the same trace under LRU and under LRU-2 (plan.md §25.4 H2)', async ({ page }) => {
  await page.goto('/docs/essays/scan-resistance');

  await page.getByRole('link', { name: 'LRU-2', exact: true }).click();
  await expect(page.getByLabel('Policy')).toHaveValue('lru-k');
  await expect(page.getByLabel('Reference string (page numbers, space or comma separated)')).toHaveValue(
    /^0 1 2 3 0 1 2 3 100 101 .* 139 0 1 2 3$/,
  );

  await page.goBack();
  await page.getByRole('link', { name: 'LRU', exact: true }).click();
  await expect(page.getByLabel('Policy')).toHaveValue('lru');
});
