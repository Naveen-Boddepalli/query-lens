import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * Lessons and challenges for the oldest sandboxes — the buffer pool, the parser, the grammar, the planner and the lock
 * table, with the B+Tree and the isolation matrix: each lesson's links landing in a tool that holds the experiment it
 * names, and the challenges that open those tools on what was set.
 */

const LESSON_IDS = ['tokens-and-trees', 'grammar-diagram', 'planner-rules', 'buffer-pool', 'lock-table'] as const;

const SETTINGS_IDS = [
  'bigger-pool-more-misses',
  'clock-is-not-lru',
  'scan-keeps-the-hot-set',
  'index-with-two-rules',
  'third-level',
  'same-level-different-promise',
] as const;

const run = (page: Page) => page.getByRole('button', { name: 'Run & check' }).click();
const script = (page: Page) => page.getByLabel(/one step to a line/);

async function noAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

test('the learn track lists the sandbox lessons with the pipeline, and the lock table first among the transactions', async ({
  page,
}) => {
  await page.goto('/learn');
  const pipeline = page.getByRole('region', { name: 'The query pipeline' });
  for (const title of [
    /From text to tokens to a tree/,
    /Read the grammar diagram/,
    /Rewrite rules need each other/,
    /Replay a page-reference string/,
  ]) {
    await expect(pipeline.getByRole('link', { name: title })).toBeVisible();
  }
  const transactions = page.getByRole('region', { name: 'Transactions and durability' });
  await expect(transactions.getByRole('listitem').first()).toContainText('The lock table');
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

test('the buffer-pool lesson’s link opens the pool on the loop and its numbers', async ({ page }) => {
  await page.goto('/learn/buffer-pool');
  await page.getByRole('link', { name: /Open the loop under LRU/ }).click();
  await expect(page).toHaveURL(/\/tools\/buffer-pool\?.*frames=4/);
  await expect(page).toHaveURL(/policy=lru/);
  await expect(page.getByRole('heading', { name: /buffer pool/i }).first()).toBeVisible();
});

test('the parser lesson’s link opens the parser on the query it names, and the tree puts the OR at the root', async ({
  page,
}) => {
  await page.goto('/learn/tokens-and-trees');
  await page.getByRole('link', { name: /Open it without parentheses/ }).click();
  await expect(page).toHaveURL(/\/tools\/parser\?src=/);
  await expect(page.getByText('id = 1 OR id = 2 AND age = 3').first()).toBeVisible();
});

test('the lock sandbox keeps what was done in its address, and a script in the address is replayed', async ({ page }) => {
  await page.goto('/learn/lock-table');
  await page.getByRole('link', { name: /Open the deadlock/ }).click();
  await expect(page).toHaveURL(/\/tools\/locks\?s=/);
  await expect(page.getByText(/Deadlock: T2 → T1 → T2/).first()).toBeVisible();
  await expect(page.getByText('aborted', { exact: true })).toBeVisible();

  // Reloading the address replays the same script into the same state.
  await page.reload();
  await expect(page.getByText(/Deadlock: T2 → T1 → T2/).first()).toBeVisible();

  // Further steps are added to the address, so the page can be sent as it stands.
  const before = page.url();
  await page.getByRole('button', { name: 'Reset' }).click();
  await expect(page.getByText(/Deadlock: T/)).toHaveCount(0);
  expect(page.url()).not.toBe(before);
});

test('the lock sandbox takes a script that is not one as no script at all', async ({ page }) => {
  await page.goto('/tools/locks?s=' + encodeURIComponent('not json'));
  await expect(page.getByRole('heading', { name: 'T1' })).toBeVisible();
  await expect(page.getByText('Place a request to begin, or load a scenario such as the deadlock.')).toBeVisible();
});

for (const id of SETTINGS_IDS) {
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

test('a policy chosen from a list can be what decides it, and the link opens the pool on it', async ({ page }) => {
  await page.goto('/challenges/bigger-pool-more-misses');
  await page.getByLabel('Policy').selectOption('fifo');
  await run(page);
  await expect(page.getByText('✓ Solved.')).toBeVisible();
  await noAxeViolations(page);
  const open = page.getByRole('link', { name: /Open this run in its tool/ });
  await expect(open).toHaveAttribute('href', /\/tools\/buffer-pool\?.*policy=fifo/);
  await open.click();
  await expect(page).toHaveURL(/\/tools\/buffer-pool\?/);
});

test('a string of page numbers is a setting, and an empty one is refused in words', async ({ page }) => {
  await page.goto('/challenges/clock-is-not-lru');
  await page.getByLabel('Page-reference string').fill('0 1 2 0 3 0 4 2 3 0 3 2');
  await page.getByLabel('Frames', { exact: true }).fill('3');
  await run(page);
  await expect(page.getByText('✓ Solved.')).toBeVisible();

  await page.getByLabel('Page-reference string').fill('');
  await run(page);
  await expect(page.getByRole('alert')).toContainText('Page-reference string cannot be empty.');
});

test('rules are checkboxes, and two of them are enough for the lookup', async ({ page }) => {
  await page.goto('/challenges/index-with-two-rules');
  const rules = page.getByRole('group', { name: 'Rules that are on' });
  await expect(rules.getByRole('checkbox')).toHaveCount(8);
  for (const rule of [
    'constant-folding',
    'product-to-join',
    'join-predicate-pushdown',
    'join-algorithm-selection',
    'range-index-selection',
    'index-only-scan',
  ]) {
    await rules.getByLabel(rule, { exact: true }).uncheck();
  }
  await run(page);
  await expect(page.getByText('✓ Solved.')).toBeVisible();
  await expect(page.getByRole('link', { name: /Open this run in its tool/ })).toHaveAttribute(
    'href',
    /\/tools\/planner\?.*rules=/,
  );
});

test('the tree gets its third level from fewer keys than it seems to need', async ({ page }) => {
  await page.goto('/challenges/third-level');
  await page.getByLabel('Fan-out (keys a page holds)').fill('3');
  await page.getByLabel('Keys, inserted in order').fill('10');
  await run(page);
  await expect(page.getByText('✓ Solved.')).toBeVisible();
  await expect(page.getByRole('link', { name: /Open this run in its tool/ })).toHaveAttribute(
    'href',
    /\/tools\/btree\?.*fanout=3/,
  );
});

test('the isolation matrix challenge is listed with the transactions, and its link opens the matrix on the level', async ({
  page,
}) => {
  await page.goto('/challenges');
  const group = page.getByRole('region', { name: 'Transactions and durability' });
  await expect(group.getByRole('link', { name: /One level, two promises/ })).toBeVisible();
  await page.goto('/challenges/same-level-different-promise');
  await page.getByLabel('Anomaly').selectOption('PMP');
  await run(page);
  await expect(page.getByText('✓ Solved.')).toBeVisible();
  const open = page.getByRole('link', { name: /Open this run in its tool/ });
  await expect(open).toHaveAttribute('href', /\/tools\/isolation\?/);
  await open.click();
  await expect(page).toHaveURL(/\/tools\/isolation\?/);
});

test('a lock script is run, line by line, and the solved one links to the sandbox holding it', async ({ page }) => {
  await page.goto('/challenges/one-page-deadlock');
  await expect(page.getByText(/four\s+pages, 0 to 3/)).toBeVisible();
  await run(page);
  await expect(page.getByText(/Not there yet/)).toBeVisible();
  await expect(page.getByText('deadlocks')).toBeVisible();

  await script(page).fill('T1 shared 0\nT2 shared 0\nT1 exclusive 0\nT2 exclusive 0');
  await run(page);
  await expect(page.getByText('✓ Solved.')).toBeVisible();
  await expect(page.getByRole('table')).toBeVisible();
  await noAxeViolations(page);

  await page.getByRole('link', { name: /Open this run in its tool/ }).click();
  await expect(page).toHaveURL(/\/tools\/locks\?s=/);
  await expect(page.getByText(/Deadlock: T2 → T1 → T2/).first()).toBeVisible();
});

test('a lock script that is not one says which line, and runs nothing', async ({ page }) => {
  await page.goto('/challenges/same-order-no-deadlock');
  await script(page).fill('T1 exclusive 0\nT3 exclusive 0');
  await run(page);
  await expect(page.getByRole('alert')).toContainText('Line 2');
  await expect(page.getByRole('table')).toHaveCount(0);
});

test('the same order, one transaction waiting, no one aborted', async ({ page }) => {
  await page.goto('/challenges/same-order-no-deadlock');
  await script(page).fill(
    [
      'T1 exclusive 0',
      'T1 exclusive 1',
      'T2 exclusive 0',
      'T1 release exclusive 0',
      'T1 release exclusive 1',
      'T2 exclusive 1',
    ].join('\n'),
  );
  await run(page);
  await expect(page.getByText('✓ Solved.')).toBeVisible();
});

test('a query challenge about how a query is read opens the parser on what was written', async ({ page }) => {
  await page.goto('/challenges/and-before-or');
  // The starter runs and does not pass; the link to the Parser is there either way.
  await page.getByRole('button', { name: 'Run & check' }).click();
  await expect(page.getByText(/Not there yet/)).toBeVisible();
  await expect(page.getByRole('link', { name: /Read this query’s tree in the Parser/ })).toBeVisible();

  const editor = page.locator('.cm-content');
  await editor.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('SELECT * FROM users WHERE (id = 1 OR id = 3 OR id = 4) AND age > 30;');
  await page.getByRole('button', { name: 'Run & check' }).click();
  await expect(page.getByText('✓ Solved.')).toBeVisible();
  await page.getByRole('link', { name: /Read this query’s tree in the Parser/ }).click();
  await expect(page).toHaveURL(/\/tools\/parser\?src=/);
  await expect(page.getByText(/\(id = 1 OR id = 3 OR id = 4\) AND age > 30/).first()).toBeVisible();
});

test('the every-clause challenge links to the select rule of the grammar', async ({ page }) => {
  await page.goto('/challenges/every-clause');
  await page.getByRole('button', { name: 'Run & check' }).click();
  await expect(page.getByText(/Not there yet/)).toBeVisible();
  await page.getByRole('link', { name: /See the select rule in the Grammar/ }).click();
  await expect(page).toHaveURL(/\/tools\/grammar#rule-select$/);
  await expect(page.locator('#rule-select')).toBeAttached();
});
