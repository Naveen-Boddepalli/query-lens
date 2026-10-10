import { expect, test } from '@playwright/test';

// plan.md §25.4 D6: one schedule, five protocols, each really run; the table is read off the runs.
const row = (page: import('@playwright/test').Page, name: string) =>
  page.getByRole('row').filter({ has: page.getByRole('button', { name, exact: true }) });

test('a lost update is resolved five ways, and each pays differently', async ({ page }) => {
  await page.goto('/tools/concurrency');
  // Optimistic validation never waits and throws the second transaction away at commit.
  const optimistic = row(page, 'Optimistic validation').getByRole('cell');
  await expect(optimistic.nth(0)).toHaveText('1'); // committed
  await expect(optimistic.nth(1)).toHaveText('1'); // aborted
  await expect(optimistic.nth(2)).toHaveText('0'); // waits
  await expect(row(page, 'Optimistic validation').getByRole('cell').last()).toHaveText('Yes');
});

test('write skew is let through by snapshots and the check says no', async ({ page }) => {
  await page.goto('/tools/concurrency');
  await page.getByRole('button', { name: 'Write skew' }).click();
  await expect(row(page, 'Snapshots').getByRole('cell').last()).toHaveText('No');
  await expect(row(page, 'Serializable snapshots').getByRole('cell').last()).toHaveText('Yes');
  await row(page, 'Snapshots').getByRole('button').click();
  const run = page.getByRole('region', { name: 'The run under Snapshots' });
  await expect(run).toContainText('No order of the 2 committed transactions explains this run');
});

test('a reader beside a writer is serializable under snapshots, by an order that is not the commit order', async ({ page }) => {
  await page.goto('/tools/concurrency');
  await page.getByRole('button', { name: 'Reader and writer' }).click();
  await expect(row(page, 'Snapshots').getByRole('cell').last()).toHaveText('Yes');
  await row(page, 'Snapshots').getByRole('button').click();
  await expect(page.getByRole('region', { name: 'The run under Snapshots' })).toContainText('A, then B explains it');
});

test('timestamp ordering is shown building on a rollback', async ({ page }) => {
  await page.goto('/tools/concurrency');
  await page.getByRole('button', { name: 'Built on a rollback' }).click();
  await expect(row(page, 'Timestamp ordering').getByRole('cell').last()).toHaveText('No');
  await expect(row(page, 'Two-phase locking').getByRole('cell').last()).toHaveText('Yes');
});

test('the schedule travels in the link', async ({ page }) => {
  await page.goto('/tools/concurrency');
  await page.getByRole('button', { name: 'Deadlock' }).click();
  await expect(page).toHaveURL(/[?&]s=/);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Deadlock', exact: true })).toHaveAttribute('aria-pressed', 'true');
});
