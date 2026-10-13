import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * The challenges for the sort, the hash join, the join order, the slotted page, hash indexes, the LSM tree, columnar
 * layouts, latch crabbing and the vector index: set a few numbers, run, and read the verdict against what is needed.
 */

const IDS = [
  'one-merge-pass',
  'more-memory-more-io',
  'cheapest-order',
  'tightest-page',
  'split-the-other-bucket',
  'cheap-writes-cheap-reads',
  'write-amp-below-one',
  'column-store-saving',
  'crabbing-saves-a-fifth',
  'recall-for-a-quarter',
] as const;

const run = (page: Page) => page.getByRole('button', { name: 'Run & check' }).click();

test('the challenge index has a storage and execution group, counted with the rest', async ({ page }) => {
  await page.goto('/challenges');
  const group = page.getByRole('region', { name: 'Storage and execution' });
  await expect(group).toBeVisible();
  await expect(group.getByRole('listitem')).toHaveCount(IDS.length);
  await expect(page.getByText(/^0 of \d+ solved$/)).toBeVisible();
  await group.getByRole('link', { name: /Sort in a single merge pass/ }).click();
  await expect(page).toHaveURL(/\/challenges\/one-merge-pass$/);
});

for (const id of IDS) {
  test(`challenge ${id}: the starter runs and does not pass, and the page has no error`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`/challenges/${id}`);
    await expect(page.getByRole('button', { name: 'Run & check' })).toBeVisible();
    await run(page);
    await expect(page.getByText(/Not there yet/)).toBeVisible();
    await expect(page.getByText(/Needed:/).first()).toBeVisible();
    await expect(page.getByRole('link', { name: /Open this run in its tool/ })).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test('a settings challenge is solved by the numbers, remembered, and its link opens the tool on them', async ({ page }) => {
  await page.goto('/challenges/one-merge-pass');
  await page.getByLabel('Records', { exact: true }).fill('48');
  await page.getByLabel('Records per page', { exact: true }).fill('4');
  await page.getByLabel('Buffer pages', { exact: true }).fill('4');
  await run(page);
  await expect(page.getByText('✓ Solved.')).toBeVisible();
  await expect(page.getByText('merge passes')).toBeVisible();
  await expect(page.getByText(/The belief this checks/)).toBeVisible();

  // The solved result passes axe.
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

  const open = page.getByRole('link', { name: /Open this run in its tool/ });
  await expect(open).toHaveAttribute('href', /\/tools\/sort\?.*n=48.*page=4.*mem=4/);
  await open.click();
  await expect(page).toHaveURL(/\/tools\/sort\?/);
  await expect(page.getByRole('heading', { name: /merge sort/i })).toBeVisible();

  await page.goto('/challenges');
  await expect(page.getByText(/^1 of \d+ solved$/)).toBeVisible();
  await page.getByRole('button', { name: 'Reset progress' }).click();
  await expect(page.getByText(/^0 of \d+ solved$/)).toBeVisible();
});

test('a choice from a list can be what decides it', async ({ page }) => {
  await page.goto('/challenges/column-store-saving');
  await page.getByLabel('Rows', { exact: true }).fill('500');
  await page.getByLabel('Page size in bytes', { exact: true }).fill('256');
  await page.getByLabel('Layout', { exact: true }).selectOption('DSM');
  await run(page);
  await expect(page.getByText(/Not there yet/)).toBeVisible();
  await expect(page.getByText('regions to rebuild a row')).toBeVisible();

  await page.getByLabel('Layout', { exact: true }).selectOption('PAX');
  await run(page);
  await expect(page.getByText('✓ Solved.')).toBeVisible();
});

test('a number the tool would not accept is said in words and nothing runs', async ({ page }) => {
  await page.goto('/challenges/one-merge-pass');
  await page.getByLabel('Buffer pages', { exact: true }).fill('2');
  await run(page);
  await expect(page.getByRole('alert')).toContainText('Buffer pages must be a whole number from 3 to 6');
  await expect(page.getByText('✓ Solved.')).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Open this run in its tool/ })).toHaveCount(0);
});

test('the join order wants each table once', async ({ page }) => {
  await page.goto('/challenges/cheapest-order');
  await page.getByLabel('Second', { exact: true }).selectOption('departments');
  await run(page);
  await expect(page.getByRole('alert')).toContainText(/each of the four tables exactly once/i);

  await page.getByLabel('First', { exact: true }).selectOption('departments');
  await page.getByLabel('Second', { exact: true }).selectOption('employees');
  await page.getByLabel('Third', { exact: true }).selectOption('timesheets');
  await page.getByLabel('Fourth', { exact: true }).selectOption('projects');
  await run(page);
  await expect(page.getByText('✓ Solved.')).toBeVisible();
  await expect(page.getByText('against the cheapest')).toBeVisible();
});

test('the hash join shows the two costs one buffer page apart', async ({ page }) => {
  await page.goto('/challenges/more-memory-more-io');
  await page.getByLabel(/^Buffer pages/).fill('3');
  await run(page);
  await expect(page.getByText('✓ Solved.')).toBeVisible();
  await expect(page.getByRole('table', { name: /one buffer page apart/ })).toBeVisible();
});
