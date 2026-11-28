import { expect, test } from '@playwright/test';

// plan.md §28.5 I2 (on §25.4 E4's dialog): writes logged on the engine's own pool, committed, crashed and recovered.
async function run(page: import('@playwright/test').Page, sql: string) {
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText(sql);
  await page.getByRole('button', { name: /^Run/ }).click();
}

async function logOn(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: /^Durability/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Durability' });
  await dialog.getByRole('button', { name: 'Turn the log on' }).click();
  await dialog.getByRole('button', { name: 'Close' }).click();
}

test('the log is off until it is turned on, and a write run before that is not logged', async ({ page }) => {
  await page.goto('/playground');
  await run(page, 'UPDATE users SET age = 99 WHERE id = 5');
  await expect(page.getByRole('button', { name: 'Durability', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Durability', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Durability' }).getByRole('region', { name: 'Turn the log on' })).toContainText('The log is off');
});

test('an UPDATE run with the log on is kept as a transaction that can be committed, lost, or recovered', async ({ page }) => {
  await page.goto('/playground');
  await logOn(page);
  await run(page, 'UPDATE users SET age = 99 WHERE id = 5');
  await run(page, 'DELETE FROM users WHERE id = 6');
  await page.getByRole('button', { name: /^Durability \(2\)/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Durability' });
  await expect(dialog).toContainText('UPDATE users SET age = 99 WHERE id = 5');
  await dialog.getByRole('button', { name: 'Commit Q1' }).click();
  await dialog.getByRole('button', { name: 'Crash', exact: true }).click();
  await expect(dialog).toContainText('The machine is down');
  await dialog.getByRole('button', { name: 'Recover', exact: true }).click();
  // Q1 committed and is kept; Q2, never committed, is rolled back and its row is back.
  const statements = dialog.getByRole('region', { name: 'The statements' });
  await expect(statements.getByRole('row', { name: /^Q1 UPDATE/ })).toContainText('committed');
  await expect(statements.getByRole('row', { name: /^Q2 DELETE/ })).toContainText('rolled back');
  await expect(dialog.getByRole('region', { name: 'The three passes of recovery' })).toBeVisible();
});

test('a crash leaves the Playground what the disk holds, and recovery gives it back what committed', async ({ page }) => {
  await page.goto('/playground');
  await logOn(page);
  const edit = page.getByRole('button', { name: /^Edit data/ });
  const rows = Number((await edit.innerText()).match(/\((\d+)\)/)![1]);
  await run(page, 'DELETE FROM users WHERE id = 6');
  await expect(edit).toContainText(`(${String(rows - 1)})`);
  await page.getByRole('button', { name: /^Durability/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Durability' });
  await dialog.getByRole('button', { name: 'Crash', exact: true }).click();
  // The delete never reached the disk: what the disk holds still has the row.
  await expect(edit).toContainText(`(${String(rows)})`);
  await dialog.getByRole('button', { name: 'Recover', exact: true }).click();
  await expect(edit).toContainText(`(${String(rows)})`);
});

test('a database changed some other way makes the log say it is stale', async ({ page }) => {
  await page.goto('/playground');
  await logOn(page);
  await run(page, 'UPDATE users SET age = 1 WHERE id = 1');
  await page.getByRole('button', { name: 'orders' }).click();
  await page.getByRole('button', { name: /^Durability/ }).click();
  await expect(page.getByRole('dialog', { name: 'Durability' }).getByRole('alert')).toContainText('not the one this log holds');
});

test('the recovery in the Durability dialog can be read as a table, as on the recovery page (plan.md §H6)', async ({ page }) => {
  await page.goto('/playground');
  await logOn(page);
  await run(page, 'DELETE FROM users WHERE id = 6');
  await page.getByRole('button', { name: /^Durability/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Durability' });
  // Without a flush the statement's log record is still in the buffer and dies with the machine: nothing to recover.
  await dialog.getByRole('button', { name: 'Flush log' }).click();
  await dialog.getByRole('button', { name: 'Crash', exact: true }).click();
  await dialog.getByRole('button', { name: 'Recover', exact: true }).click();
  await dialog.getByRole('button', { name: 'Show as table' }).last().click();
  const table = dialog.getByRole('table', { name: /The three passes of recovery/ });
  await expect(table).toContainText('loser');
  await expect(table).toContainText('undone');
});

test('a logged write says what it logged, and the pool’s dirty pages wait for the log', async ({ page }) => {
  await page.goto('/playground');
  await logOn(page);
  await run(page, 'UPDATE users SET age = age + 1');
  // The result step, the trace's last, says what the statement logged.
  await page.getByLabel('Scrub to step').press('End');
  await expect(page.getByText(/Logged as Q1: \d+ records/).first()).toBeVisible();
  await page.getByRole('button', { name: /^Durability \(1\)/ }).click();
  await expect(page.getByRole('dialog', { name: 'Durability' })).toContainText('UPDATE users SET age = age + 1');
});

// plan.md §28.5 I3: BEGIN, COMMIT and ROLLBACK in the SQL box, on that log.
test('BEGIN with the log off says where it runs', async ({ page }) => {
  await page.goto('/playground');
  await run(page, 'BEGIN');
  await expect(page.getByText('run on the write-ahead log, and none is on for this database').first()).toBeVisible();
});

test('a ROLLBACK typed in the SQL box undoes the transaction’s writes, newest first, in its trace', async ({ page }) => {
  await page.goto('/playground');
  await logOn(page);
  const edit = page.getByRole('button', { name: /^Edit data/ });
  const rows = Number((await edit.innerText()).match(/\((\d+)\)/)![1]);
  await run(page, 'BEGIN');
  await expect(page.getByRole('button', { name: /^Durability/ })).toContainText('T1 open');
  await run(page, 'DELETE FROM users WHERE id = 6');
  await run(page, 'UPDATE users SET age = 99 WHERE id = 5');
  await expect(edit).toContainText(`(${String(rows - 1)})`);
  await run(page, 'ROLLBACK');
  await expect(edit).toContainText(`(${String(rows)})`);
  await expect(page.getByRole('button', { name: /^Durability/ })).not.toContainText('open');
  await page.getByLabel('Scrub to step').press('End');
  await expect(page.getByText(/ROLLBACK: T1 rolls back: its abort record is LSN 3\./).first()).toBeVisible();
  // One step back is the oldest change's undo: the DELETE's, LSN 1.
  await page.getByLabel('Scrub to step').press('ArrowLeft');
  await expect(page.getByText(/Undo LSN 1: T1's change to slot \d+ of/).first()).toBeVisible();
  await page.getByRole('button', { name: /^Durability/ }).click();
  const statements = page.getByRole('dialog', { name: 'Durability' }).getByRole('region', { name: 'The statements' });
  await expect(statements.getByRole('row', { name: /^T1 DELETE/ })).toContainText('rolled back');
  await expect(statements.getByRole('row', { name: /^T1 UPDATE/ })).toContainText('rolled back');
});

test('a crash in the middle of a BEGIN makes its transaction a loser, and recovery undoes it', async ({ page }) => {
  await page.goto('/playground');
  await logOn(page);
  const edit = page.getByRole('button', { name: /^Edit data/ });
  const rows = Number((await edit.innerText()).match(/\((\d+)\)/)![1]);
  await run(page, 'BEGIN');
  await run(page, 'DELETE FROM users WHERE id = 6');
  await page.getByRole('button', { name: /^Durability/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Durability' });
  const statements = dialog.getByRole('region', { name: 'The statements' });
  await expect(statements.getByRole('row', { name: /^T1 DELETE/ })).toContainText('open, after BEGIN');
  await dialog.getByRole('button', { name: 'Flush log' }).click();
  await dialog.getByRole('button', { name: 'Crash', exact: true }).click();
  await dialog.getByRole('button', { name: 'Recover', exact: true }).click();
  await expect(statements.getByRole('row', { name: /^T1 DELETE/ })).toContainText('rolled back');
  await expect(dialog.getByRole('region', { name: 'The three passes of recovery' })).toContainText('T1');
  await expect(edit).toContainText(`(${String(rows)})`);
  await dialog.getByRole('button', { name: 'Close' }).click();
  await run(page, 'COMMIT');
  await expect(page.getByText('No transaction is open, so there is nothing to commit.').first()).toBeVisible();
});
