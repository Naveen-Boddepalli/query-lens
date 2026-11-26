import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const pages: [string, RegExp][] = [
  ['/tools/columnar', /Each column's encoding/],
  ['/tools/hash-index', /Directory:/],
  ['/tools/lsm', /SSTables by level/],
  ['/tools/join-order', /Every subset of the tables/],
];

for (const [path, caption] of pages) {
  test(`${path} has a table view of its data that is clean under axe (plan.md §H6)`, async ({ page }) => {
    await page.goto(path);
    // A page still on DataView has a 'Show as table' button; one on the tool workbench has a Diagram | Table
    // switch in its stage header.
    const toggle = page
      .getByRole('button', { name: 'Show as table' })
      .or(page.getByRole('radio', { name: 'Table', exact: true }))
      .first();
    await expect(toggle).toBeVisible();
    await toggle.click();

    // The view's own table: a page may have others that are always tables (the join-order page's growth table).
    const table = page.getByRole('table').filter({ has: page.getByRole('caption').filter({ hasText: caption }) });
    await expect(table).toBeVisible();
    await expect(table.getByRole('columnheader').first()).toBeVisible();

    const results = await new AxeBuilder({ page })
      .include('table')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

    await page
      .getByRole('button', { name: 'Show as diagram' })
      .or(page.getByRole('radio', { name: 'Diagram', exact: true }))
      .first()
      .click();
    await expect(table).toHaveCount(0);
  });
}

// plan.md §H6: every panel has a data-table view. The transaction and durability tools' diagrams as real tables.
const toggle = (page: import('@playwright/test').Page, index = 0) =>
  page.getByRole('button', { name: 'Show as table' }).nth(index);

test('the schedule tool shows its lanes as a table, one row for each thing that happened', async ({ page }) => {
  await page.goto('/tools/schedule');
  await toggle(page).click();
  const table = page.getByRole('table', { name: /The schedule as it ran/ });
  await expect(table).toBeVisible();
  await expect(table.getByRole('columnheader')).toHaveText([
    'Step',
    'Session',
    'Statement',
    'What happened',
    'Result',
    'Flagged',
  ]);
  // The default example: B reads what A has not committed, and the table says so.
  await expect(table).toContainText('dirty-read');
  await page.getByRole('button', { name: 'Show as diagram' }).click();
  await expect(table).toHaveCount(0);
});

test('the isolation matrix is one row for each of its hundred and twenty cells', async ({ page }) => {
  await page.goto('/tools/isolation');
  await toggle(page).click();
  const table = page.getByRole('table', { name: /Every anomaly at every isolation level/ });
  await expect(table.getByRole('row')).toHaveCount(121);
  await expect(table.getByRole('row', { name: /G2-item Write skew REPEATABLE READ Versions and snapshots/ })).toContainText(
    'happens',
  );
});

test('the concurrency compare’s run is a table of what happened under that protocol', async ({ page }) => {
  await page.goto('/tools/concurrency');
  await page.getByRole('button', { name: 'Show as table' }).click();
  const table = page.getByRole('table', { name: /The run under Two-phase locking/ });
  await expect(table).toBeVisible();
  await expect(table).toContainText('Deadlock');
});

test('a write-ahead-log step’s effects are a table of kind, page and LSN', async ({ page }) => {
  await page.goto('/tools/wal');
  await toggle(page).click();
  const table = page.getByRole('table', { name: /What the step did, effect by effect/ });
  await expect(table.getByRole('columnheader')).toHaveText(['#', 'What', 'Page', 'LSN', 'Detail']);
  await expect(table).toContainText('log forced');
});

test('a recovery’s three passes are one table, in the order they ran', async ({ page }) => {
  await page.goto('/tools/recovery');
  await page.getByRole('button', { name: 'Show as table' }).last().click();
  const table = page.getByRole('table', { name: /The three passes of recovery/ });
  await expect(table.getByRole('columnheader')).toHaveText(['Pass', 'LSN', 'Subject', 'Action', 'Why']);
  const passes = await table.getByRole('row').evaluateAll((rows) =>
    rows.slice(1).map((r) => (r.querySelector('td')?.textContent ?? '').trim()),
  );
  // Analysis first, then redo, then undo: a restart never goes back.
  expect(passes[0]).toBe('Analysis');
  expect([...passes].sort((a, b) => ['Analysis', 'Redo', 'Undo'].indexOf(a) - ['Analysis', 'Redo', 'Undo'].indexOf(b))).toEqual(
    passes,
  );
});

test('every table view is free of detectable WCAG A/AA violations', async ({ page }) => {
  for (const [path, clicks] of [
    ['/tools/schedule', 1],
    ['/tools/isolation', 2],
    ['/tools/concurrency', 1],
    ['/tools/wal', 1],
    ['/tools/recovery', 2],
  ] as const) {
    await page.goto(path);
    for (let i = 0; i < clicks; i += 1) await page.getByRole('button', { name: 'Show as table' }).first().click();
    await expect(page.getByRole('table').first()).toBeVisible();
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(results.violations.map((v) => `${path}: ${v.id}`)).toEqual([]);
  }
});
