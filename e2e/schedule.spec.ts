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

// plan.md §25.4 D2: the same schedules under strict two-phase locking, enforced by the engine's lock table.
test('with page locks a read waits for the writer, then sees what it committed', async ({ page }) => {
  await page.goto('/tools/schedule');
  await page.getByRole('button', { name: 'Blocked reader' }).click();
  await expect(page.getByText('blocked on a lock')).toBeVisible();
  await expect(page.getByText('resumed', { exact: true })).toBeVisible();
  await expect(page.getByRole('note')).toHaveCount(0);
});

test('a row lock lets a neighbour through that a page lock held back', async ({ page }) => {
  await page.goto('/tools/schedule');
  await page.getByRole('button', { name: 'Page vs row' }).click();
  await expect(page.getByText('blocked on a lock')).toBeVisible();
  await page.getByRole('radio', { name: 'Row locks' }).click();
  await expect(page.getByText('blocked on a lock')).toHaveCount(0);
});

test('a deadlock rolls back the youngest transaction and the other finishes', async ({ page }) => {
  await page.goto('/tools/schedule');
  await page.getByRole('button', { name: 'Deadlock' }).click();
  await expect(page.getByText('deadlock victim')).toBeVisible();
  const end = page.getByRole('table', { name: 'accounts at the end' });
  await expect(end.getByRole('row').nth(1).getByRole('cell').nth(2)).toHaveText('1');
  await expect(end.getByRole('row').nth(2).getByRole('cell').nth(2)).toHaveText('3');
});

// plan.md §25.4 D3: isolation levels are lock durations, and each one lets a different anomaly through.
test('repeatable read lets a phantom in; serializable makes the insert wait', async ({ page }) => {
  await page.goto('/tools/schedule');
  await page.getByRole('button', { name: 'Phantom', exact: true }).click();
  await expect(page.getByRole('note').filter({ hasText: 'Phantom' })).toBeVisible();

  await page.getByRole('radio', { name: 'Serializable' }).click();
  await expect(page.getByRole('note')).toHaveCount(0);
  await expect(page.getByText('blocked on a lock')).toBeVisible();
});

test('read committed gives its read locks back, so a repeated read changes and an update is lost', async ({ page }) => {
  await page.goto('/tools/schedule');
  await page.getByRole('button', { name: 'Non-repeatable read' }).click();
  await expect(page.getByRole('note').filter({ hasText: 'Non-repeatable read' })).toBeVisible();

  await page.getByRole('button', { name: 'Lost update' }).click();
  await expect(page.getByRole('note').filter({ hasText: 'Lost update' })).toBeVisible();

  await page.getByRole('radio', { name: 'Repeatable read' }).click();
  await expect(page.getByRole('note')).toHaveCount(0);
});
