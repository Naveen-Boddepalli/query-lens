import { expect, test } from '@playwright/test';

// plan.md §25.4 D5: the matrix is computed, every cell opens its run, and the engines differ where isolation levels do.
const cell = (page: import('@playwright/test').Page, name: RegExp) => page.getByRole('button', { name });

test('write skew is allowed by a snapshot and stopped by serializable, on the versions engine', async ({ page }) => {
  await page.goto('/tools/isolation');
  await expect(
    cell(page, /^G2-item at REPEATABLE READ, Versions and snapshots: can occur/),
  ).toBeVisible();
  await expect(
    cell(page, /^G2-item at SERIALIZABLE, Versions and snapshots: prevented/),
  ).toBeVisible();
});

test('a dirty read is allowed by read uncommitted and not by read committed, with locks', async ({ page }) => {
  await page.goto('/tools/isolation');
  await expect(cell(page, /^G1a at READ UNCOMMITTED, Two-phase locking: can occur/)).toBeVisible();
  await expect(cell(page, /^G1a at READ COMMITTED, Two-phase locking: prevented/)).toBeVisible();
});

test('a cell opens the schedule that produced it', async ({ page }) => {
  await page.goto('/tools/isolation');
  await cell(page, /^G2 at SERIALIZABLE, Two-phase locking: prevented/).click();
  const run = page.getByRole('region', { name: 'The schedule behind the selected cell' });
  await expect(run).toContainText('Anti-dependency cycles');
  await expect(run).toContainText('It did not happen.');
  await expect(run).toContainText('Deadlock');
});

test('the one place the computed matrix differs from the published one is marked and explained', async ({ page }) => {
  await page.goto('/tools/isolation');
  const differing = cell(page, /differs from the published result/);
  await expect(differing).toHaveCount(1);
  await differing.click();
  await expect(page.getByRole('region', { name: 'The schedule behind the selected cell' })).toContainText(
    'SQL Server marks every read-based anomaly',
  );
});
