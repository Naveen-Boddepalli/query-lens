import { expect, test } from '@playwright/test';

// plan.md §25.4 D1: two sessions, one database, no concurrency control — and the schedule is the URL.
test('B reads what A has not committed, it is named, and the schedule survives a reload', async ({ page }) => {
  await page.goto('/tools/schedule');
  await page.getByRole('button', { name: 'Clear' }).click();

  await page.getByRole('button', { name: 'BEGIN' }).click();
  const statement = page.getByLabel('Statement');
  await statement.fill('UPDATE accounts SET balance = 0 WHERE id = 1');
  await statement.press('Enter');
  await page.getByRole('radio', { name: 'B', exact: true }).click();
  await statement.fill('SELECT balance FROM accounts WHERE id = 1');
  await statement.press('Enter');

  const dirty = page.getByRole('note').filter({ hasText: 'Dirty read' });
  await expect(dirty).toBeVisible();
  await expect.poll(() => page.url()).toContain('s=');

  await page.reload();
  await expect(dirty).toBeVisible();

  // A is still the default session after a reload. Rolling back puts the balance back.
  await page.getByRole('button', { name: 'ROLLBACK' }).click();
  const end = page.getByRole('table', { name: 'accounts at the end' });
  await expect(end.getByRole('row').nth(1).getByRole('cell').nth(2)).toHaveText('100');
});

test('a write over another session’s uncommitted change is a dirty write, and the rollback cannot undo it', async ({ page }) => {
  await page.goto('/tools/schedule');
  await page.getByRole('button', { name: 'Dirty write' }).click();
  await expect(page.getByRole('note').filter({ hasText: 'Dirty write' })).toBeVisible();
  await expect(page.getByText('could not be put back')).toBeVisible();
  const end = page.getByRole('table', { name: 'accounts at the end' });
  await expect(end.getByRole('row').nth(1).getByRole('cell').nth(2)).toHaveText('50');
});
