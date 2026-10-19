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
  await expect(page.getByText('rolled back', { exact: true })).toBeVisible();
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

// plan.md §25.4 D4: versions and snapshots instead of read locks.
test('under MVCC a reader never waits, and a snapshot repeats its read', async ({ page }) => {
  await page.goto('/tools/schedule');
  await page.getByRole('button', { name: 'Snapshot read' }).click();
  await expect(page.getByText('blocked on a lock')).toHaveCount(0);
  await expect(page.getByRole('note')).toHaveCount(0);
  await expect(page.getByRole('table', { name: 'Row versions at the end' })).toBeVisible();

  await page.getByRole('radio', { name: 'Read committed' }).click();
  await expect(page.getByRole('note').filter({ hasText: 'Non-repeatable read' })).toBeVisible();
});

test('first committer wins, and write skew needs serializable to be stopped', async ({ page }) => {
  await page.goto('/tools/schedule');
  await page.getByRole('button', { name: 'First committer wins' }).click();
  await expect(page.getByText('rolled back', { exact: true })).toBeVisible();
  await expect(page.getByText('Could not serialize access due to a concurrent update')).toBeVisible();

  await page.getByRole('button', { name: 'Write skew' }).click();
  await expect(page.getByText('rolled back', { exact: true })).toHaveCount(0);
  const end = page.getByRole('table', { name: 'accounts at the end' });
  await expect(end.getByRole('row').nth(1).getByRole('cell').nth(2)).toHaveText('0');
  await expect(end.getByRole('row').nth(2).getByRole('cell').nth(2)).toHaveText('0');

  await page.getByRole('radio', { name: 'Serializable' }).click();
  await expect(page.getByText('Could not serialize access: ')).toBeVisible();
  await expect(end.getByRole('row').nth(2).getByRole('cell').nth(2)).toHaveText('100');
});

test('dead versions pile up and VACUUM reclaims them', async ({ page }) => {
  await page.goto('/tools/schedule');
  await page.getByRole('button', { name: 'Dead tuples' }).click();
  await expect(page.getByText(/4 dead versions no snapshot can see again/)).toBeVisible();
  await page.getByRole('button', { name: 'VACUUM' }).click();
  await expect(page.getByText(/No dead versions/)).toBeVisible();
});

test('a visibility question is answered against the session’s snapshot, and revealed', async ({ page }) => {
  await page.goto('/tools/schedule');
  await page.getByRole('button', { name: 'Snapshot read' }).click();
  // Leave A's transaction open, so its snapshot is still the one taken before B's update committed.
  await page.getByRole('button', { name: 'Remove step 5' }).click();
  const quiz = page.getByRole('region', { name: 'Visibility question' });
  await expect(quiz).toBeVisible();
  await quiz.getByLabel('Session').selectOption('A');
  // The first version listed is the one B replaced: A's snapshot has not seen that replacement.
  await quiz.getByLabel('Version').selectOption({ index: 0 });
  await quiz.getByRole('button', { name: 'Yes, it sees it' }).click();
  await expect(quiz.getByRole('status')).toContainText('Right.');
  await expect(quiz.getByRole('status')).toContainText('still there');

  // B, running as its own autocommit statement, has seen it, and the same question is answered the other way.
  await quiz.getByLabel('Session').selectOption('B');
  await quiz.getByRole('button', { name: 'Yes, it sees it' }).click();
  await expect(quiz.getByRole('status')).toContainText('Not quite.');
});

test('dead versions can push a heap past the pool, and a VACUUM brings it back', async ({ page }) => {
  await page.goto('/tools/schedule');
  await page.getByRole('button', { name: 'Dead tuples' }).click();
  const cost = page.getByRole('region', { name: 'What the dead versions cost' });
  await expect(cost.getByRole('status')).toContainText('read 18 pages from disk as it is (6 pages), and 5 after a VACUUM (5 pages)');
});

// plan.md §27.5 T1: the run as a precedence graph, its cycle named, beside the replay check.
test('a lost update draws a cycle in the precedence graph, and the replay check agrees', async ({ page }) => {
  await page.goto('/tools/schedule');
  await page.getByRole('button', { name: 'Lost update' }).click();
  const panel = page.getByRole('region', { name: 'Precedence graph' });
  await expect(panel.getByRole('status')).toContainText(/^Cycle: (A → B → A|B → A → B)\./);
  await expect(panel.getByRole('img', { name: /^Precedence graph:/ })).toBeVisible();
  await expect(panel.getByText('The replay check agrees')).toBeVisible();
  await expect(panel.getByRole('cell', { name: 'rw — read it, then the other overwrote it' })).toBeVisible();
});
