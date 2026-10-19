import { expect, test } from '@playwright/test';

/**
 * Lessons for the sort, the hash join, the join order and the storage structures: the groups on the index, each
 * lesson's links landing in a tool that runs, and a link that carries its experiment (the tool opens on the numbers
 * the lesson quotes).
 */

const LESSON_IDS = [
  'external-sort',
  'hash-join',
  'join-order',
  'histograms',
  'parallel',
  'exchange',
  'partitioning',
  'slotted-page',
  'hash-index',
  'lsm-tree',
  'row-vs-column',
  'latch-crabbing',
  'vector-index',
] as const;

test('the learn track groups the pipeline, the storage structures and the transactions', async ({ page }) => {
  await page.goto('/learn');
  const names = ['The query pipeline', 'Storage engines and access methods', 'Transactions and durability', 'Distributed databases'];
  for (const name of names) await expect(page.getByRole('heading', { name, level: 2 })).toBeVisible();

  // The sort, the hash join, the join order, the histograms, parallel execution and exchange sit with the pipeline; the six structures have their own group.
  const pipeline = page.getByRole('region', { name: 'The query pipeline' });
  await expect(pipeline.getByRole('link', { name: /Sort more than fits in memory/ })).toBeVisible();
  await expect(pipeline.getByRole('listitem')).toHaveCount(23);
  const storage = page.getByRole('region', { name: 'Storage engines and access methods' });
  await expect(storage.getByRole('listitem')).toHaveCount(6);
  await expect(storage.getByRole('link', { name: /Write fast, pay later/ })).toBeVisible();
  await expect(page.getByText(/^0 of 38 complete$/)).toBeVisible();
});

for (const id of LESSON_IDS) {
  test(`lesson ${id}: every tool link opens a tool that runs, with no error`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`/learn/${id}`);
    const links = page.getByRole('link', { name: /→$/ });
    await expect(links.first()).toBeVisible();
    // The step links, not the "Next lesson" one at the foot of the page.
    const hrefs = (await links.evaluateAll((els) => els.map((el) => el.getAttribute('href') ?? ''))).filter((h) =>
      h.startsWith('/tools/'),
    );
    expect(hrefs.length).toBeGreaterThanOrEqual(3);
    for (const href of hrefs) {
      await page.goto(href);
      await expect(page.getByRole('heading', { level: 2 }).first()).toBeVisible();
      await expect(page.getByText(/hit a bug/)).toHaveCount(0);
    }
    expect(errors).toEqual([]);
  });
}

test('the tiered step opens the LSM tree on the numbers the lesson quotes', async ({ page }) => {
  await page.goto('/learn/lsm-tree');
  await page.getByRole('link', { name: /Open it tiered/ }).click();
  await expect(page).toHaveURL(/\/tools\/lsm\?.*strategy=tiered/);
  await expect(page.getByText('2.28')).toBeVisible();
  await expect(page.getByText('1.45')).toBeVisible();
});

test('the page step opens the inspector with the free space the lesson quotes', async ({ page }) => {
  await page.goto('/learn/slotted-page');
  await page.getByRole('link', { name: /Open this page/ }).click();
  await expect(page).toHaveURL(/\/tools\/page\?/);
  await expect(page.getByText('3,894 B').first()).toBeVisible();
});

test('the sort step opens the merge sort on the sixteen pages the lesson counts', async ({ page }) => {
  await page.goto('/learn/external-sort');
  await page.getByRole('link', { name: /Open this sort/ }).first().click();
  await expect(page).toHaveURL(/\/tools\/sort\?.*mem=3/);
  await expect(page.getByText('128').first()).toBeVisible();
});

test('the optimistic step opens the latch tool on its timeline, with the restarts it counted and why', async ({ page }) => {
  await page.goto('/learn/latch-crabbing');
  await page.getByRole('link', { name: /Open the optimistic timeline/ }).click();
  await expect(page).toHaveURL(/\/tools\/latch-crabbing\?.*timeline=optimistic/);
  await expect(page.getByRole('radio', { name: 'Optimistic timeline' })).toHaveAttribute('aria-checked', 'true');

  // Eight of the twenty-four inserts restarted, and the table says what it was that sent each back to the root.
  const restarted = page.getByText('inserts restarted', { exact: true });
  await expect(restarted.locator('..').getByText('8', { exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: /restart — the page was held/ }).first()).toBeVisible();

  // The other two timelines are one click away, and the choice rides in the address.
  await page.getByRole('radio', { name: 'Naive timeline' }).click();
  await expect(page).toHaveURL(/timeline=naive/);
});
