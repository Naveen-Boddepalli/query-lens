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

test('the two places the computed matrix differs from a published one are marked and explained', async ({ page }) => {
  await page.goto('/tools/isolation');
  const differing = cell(page, /differs from the published result/);
  await expect(differing).toHaveCount(2);
  const region = page.getByRole('region', { name: 'The schedule behind the selected cell' });
  await differing.first().click();
  await expect(region).toContainText('SQL Server marks every read-based anomaly');
  await differing.last().click();
  await expect(region).toContainText('MySQL’s page marks OTV as able to occur at READ UNCOMMITTED');
});

test('InnoDB lets a lost update through at REPEATABLE READ, where snapshots refuse it, and says where nothing was published', async ({
  page,
}) => {
  await page.goto('/tools/isolation');
  await expect(cell(page, /^P4 at REPEATABLE READ, InnoDB \(MySQL\): can occur$/)).toBeVisible();
  await expect(cell(page, /^P4 at REPEATABLE READ, Versions and snapshots: prevented$/)).toBeVisible();
  await expect(cell(page, /^P4 at SERIALIZABLE, InnoDB \(MySQL\): prevented$/)).toBeVisible();

  // MySQL's page did not run G0 at this level: the cell is computed, and carries no claim.
  const unpublished = cell(page, /^G0 at REPEATABLE READ, InnoDB \(MySQL\): prevented, no published result$/);
  await unpublished.click();
  await expect(page.getByRole('region', { name: 'The schedule behind the selected cell' })).toContainText(
    'Nothing was published for this cell',
  );
});
