import { expect, test } from '@playwright/test';

// plan.md §25.4 E1: a log, a pool and a disk, and the rule between them.
const stepRegion = (page: import('@playwright/test').Page) =>
  page.getByRole('region', { name: 'What the selected step did' });

test('a commit forces the log and writes no data page', async ({ page }) => {
  await page.goto('/tools/wal');
  await expect(stepRegion(page)).toContainText('commit T1');
  await expect(stepRegion(page)).toContainText('The log is forced through LSN 3');
  await expect(stepRegion(page)).not.toContainText('written to disk');
});

test('a page written to disk has the log flushed through its LSN first', async ({ page }) => {
  await page.goto('/tools/wal');
  await page.getByRole('button', { name: 'The page needs its log first' }).click();
  await expect(stepRegion(page)).toContainText('the log goes first');
  await expect(stepRegion(page)).toContainText('flushed through LSN 2');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('with the rule off the page goes out ahead of its log, and the page says so', async ({ page }) => {
  await page.goto('/tools/wal');
  await page.getByRole('button', { name: 'Break the rule' }).click();
  await expect(page.getByRole('radio', { name: 'Off' })).toBeChecked();
  await expect(page.getByRole('alert')).toContainText('Page 1 on disk carries a change from LSN 1');
});

test('a step can be chosen to see the state after it', async ({ page }) => {
  await page.goto('/tools/wal');
  await page.getByRole('button', { name: /^Step 2:/ }).click();
  await expect(stepRegion(page)).toContainText('begins');
});

test('the script travels in the link', async ({ page }) => {
  await page.goto('/tools/wal');
  await page.getByRole('button', { name: 'Rollback is logged too' }).click();
  await expect(page).toHaveURL(/[?&]s=/);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Rollback is logged too' })).toHaveAttribute('aria-pressed', 'true');
});

// plan.md §25.4 E2: steal and force, and what a crash would find.
const crashRegion = (page: import('@playwright/test').Page) =>
  page.getByRole('region', { name: 'If the machine stopped here' });

test('steal puts an uncommitted change on disk, and the page says what recovery would owe', async ({ page }) => {
  await page.goto('/tools/wal');
  await page.getByRole('button', { name: 'Steal: uncommitted on disk' }).click();
  await expect(crashRegion(page)).toContainText('a value nobody committed');
  await expect(crashRegion(page)).toContainText('undo');
});

test('no-steal refuses the step that would need an uncommitted page’s frame', async ({ page }) => {
  await page.goto('/tools/wal');
  await page.getByRole('button', { name: 'No-steal: nowhere to put it' }).click();
  await expect(page.getByRole('region', { name: 'What the selected step did' })).toContainText(
    'every frame holds an uncommitted change',
  );
});

test('no-force owes pages after a commit and force does not', async ({ page }) => {
  await page.goto('/tools/wal');
  await page.getByRole('button', { name: 'No-force: the commit owes pages' }).click();
  await expect(crashRegion(page)).toContainText('3 committed changes have not reached the disk');
  await page.getByRole('button', { name: 'Force: the commit pays' }).click();
  await expect(crashRegion(page)).not.toContainText('have not reached the disk');
});

test('the four policies are compared on the same script', async ({ page }) => {
  await page.goto('/tools/wal');
  await page.getByRole('button', { name: 'Force: the commit pays' }).click();
  const row = page.getByRole('row').filter({ has: page.getByRole('button', { name: 'Steal, force' }) });
  await expect(row.getByRole('cell').first()).toHaveText('3');
});
