import { expect, test } from '@playwright/test';

// plan.md §25.4 E3: crash, then analysis, redo, undo.
const passes = (page: import('@playwright/test').Page) =>
  page.getByRole('region', { name: 'The three passes of recovery' });
const verdict = (page: import('@playwright/test').Page) =>
  page.getByRole('region', { name: 'Is the database right?' });

test('a committed change that never reached disk is redone', async ({ page }) => {
  await page.goto('/tools/recovery');
  await expect(passes(page)).toContainText('2. Redo');
  await expect(passes(page)).toContainText('redo');
  await expect(verdict(page)).toContainText('Yes: the pool over the disk holds exactly what the committed transactions left');
});

test('a change that reached disk and never committed is undone, with a compensation record', async ({ page }) => {
  await page.goto('/tools/recovery');
  await page.getByRole('button', { name: 'Undo: written, never committed' }).click();
  await expect(passes(page)).toContainText('Losers: T1');
  await expect(passes(page)).toContainText('a goes back from 99 to 10');
  await expect(passes(page)).toContainText('logged as LSN');
  await expect(verdict(page)).toContainText('Yes');
});

test('a crash during recovery is picked up where it stopped', async ({ page }) => {
  await page.goto('/tools/recovery');
  await page.getByRole('button', { name: 'Crash during recovery' }).click();
  // The last step is the second, complete recovery: it follows the compensation record already written.
  await expect(passes(page)).toContainText('already logged');
  await expect(verdict(page)).toContainText('Yes');
});

test('with the rule off, recovery cannot undo a change whose log record was lost', async ({ page }) => {
  await page.goto('/tools/recovery');
  await page.getByRole('button', { name: 'Break the rule' }).click();
  await expect(verdict(page)).toContainText('No:');
  await expect(verdict(page)).toContainText('nothing to undo it with');
});

test('the machine is down between a crash and its recovery', async ({ page }) => {
  await page.goto('/tools/recovery');
  await page.getByRole('button', { name: /^Step 5: crash/ }).click();
  await expect(page.getByRole('status').filter({ hasText: 'The machine is down' })).toBeVisible();
});

test('the script travels in the link', async ({ page }) => {
  await page.goto('/tools/recovery');
  await page.getByRole('button', { name: 'Both at once' }).click();
  await expect(page).toHaveURL(/[?&]s=/);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Both at once' })).toHaveAttribute('aria-pressed', 'true');
});

test('recovery is a trace in three stages, and a slider walks the passes in the order they ran', async ({ page }) => {
  await page.goto('/tools/recovery');
  await page.getByRole('button', { name: 'Both at once' }).click();
  const stages = page.getByRole('list', { name: 'The stages of recovery' });
  await expect(stages.getByRole('listitem')).toHaveCount(3);
  await expect(stages).toContainText('1. Analysis');
  await expect(stages).toContainText('3. Undo');

  // It rests at the end, with every stage done and the passes below as they have always been.
  const slider = page.getByLabel('Step through recovery');
  await expect(stages.getByRole('listitem').nth(2)).toContainText('(finished)');

  // Back to before the first step: nothing is examined, and no stage is current.
  await slider.press('Home');
  await expect(page.getByRole('status').filter({ hasText: 'Before the first step' })).toBeVisible();
  await expect(stages.locator('[aria-current="step"]')).toHaveCount(0);

  // One step in is analysis's first row; the stage it belongs to is the current one.
  await slider.press('ArrowRight');
  await expect(stages.locator('[aria-current="step"]')).toContainText('Analysis');
  await expect(page.getByRole('status').filter({ hasText: /^Analysis, LSN/ })).toBeVisible();

  // At the end again, the last thing narrated is an undo, and the row it names is marked in the panel.
  await slider.press('End');
  await expect(page.getByRole('status').filter({ hasText: /^Undo, LSN/ })).toBeVisible();
});

