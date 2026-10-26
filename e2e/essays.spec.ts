import { expect, test } from '@playwright/test';

test('the scan essay links open the same trace under LRU and under LRU-2 (plan.md §25.4 H2)', async ({ page }) => {
  await page.goto('/docs/essays/scan-resistance');

  await page.getByRole('link', { name: 'LRU-2', exact: true }).click();
  await expect(page.getByLabel('Policy')).toHaveValue('lru-k');
  await expect(page.getByLabel(/^Reference string/)).toHaveValue(
    /^0 1 2 3 0 1 2 3 100 101 .* 139 0 1 2 3$/,
  );

  await page.goBack();
  await page.getByRole('link', { name: 'LRU', exact: true }).click();
  await expect(page.getByLabel('Policy')).toHaveValue('lru');
});

test('the REPEATABLE READ essay links open the run behind each cell (plan.md §25.4 H2)', async ({ page }) => {
  await page.goto('/docs/essays/repeatable-read');
  await page.getByRole('link', { name: 'Phantom', exact: true }).click();
  const run = page.getByRole('region', { name: 'The schedule behind the selected cell' });
  await expect(run).toContainText('PMP');
  await expect(run).toContainText('It happened.');
});

test('the write skew links run the same schedule under locks and under snapshots', async ({ page }) => {
  await page.goto('/docs/essays/repeatable-read');
  await page.getByRole('link', { name: 'Under snapshots at REPEATABLE READ' }).first().click();
  await expect(page.getByRole('radio', { name: 'Versions (MVCC)' })).toBeChecked();
});
