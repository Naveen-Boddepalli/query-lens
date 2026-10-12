import { expect, test } from '@playwright/test';

// plan.md §25.4 E4: statements run in the Playground, crashed, recovered, and compared with what committed.
async function run(page: import('@playwright/test').Page, sql: string) {
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText(sql);
  await page.getByRole('button', { name: /^Run/ }).click();
}

test('an UPDATE run in the Playground is kept as a transaction that can be committed, lost, or recovered', async ({ page }) => {
  await page.goto('/playground');
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
  const statements = dialog.getByRole('region', { name: 'The statements run in the Playground' });
  await expect(statements.getByRole('row', { name: /^Q1 UPDATE/ })).toContainText('committed');
  await expect(statements.getByRole('row', { name: /^Q2 DELETE/ })).toContainText('rolled back');
  await expect(dialog.getByRole('region', { name: 'The three passes of recovery' })).toBeVisible();
});

test('the recovered database can replace the Playground’s', async ({ page }) => {
  await page.goto('/playground');
  await run(page, 'DELETE FROM users WHERE id = 6');
  const edit = page.getByRole('button', { name: /^Edit data/ });
  const rows = Number((await edit.innerText()).match(/\((\d+)\)/)![1]);
  await page.getByRole('button', { name: /^Durability/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Durability' });
  await dialog.getByRole('button', { name: 'Crash', exact: true }).click();
  await dialog.getByRole('button', { name: 'Recover', exact: true }).click();
  await dialog.getByRole('button', { name: 'Use the recovered database in the Playground' }).click();
  await expect(edit).toContainText(`(${String(rows + 1)})`);
});

test('a database changed some other way makes the log say it is stale', async ({ page }) => {
  await page.goto('/playground');
  await run(page, 'UPDATE users SET age = 1 WHERE id = 1');
  await page.getByRole('button', { name: 'orders' }).click();
  await page.getByRole('button', { name: /^Durability/ }).click();
  await expect(page.getByRole('dialog', { name: 'Durability' }).getByRole('alert')).toContainText('not the one this log began with');
});
