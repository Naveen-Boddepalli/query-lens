import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const tiny = (name: string) => ({
  format: 'querylens-workspace',
  version: 1,
  name,
  database: {
    tables: {
      gadgets: { name: 'gadgets', columns: ['id', 'label'], rows: [{ id: 1, label: 'a' }] },
    },
  },
});

test('a saved workspace survives a reload, opens back in, and can be deleted (plan.md §H7)', async ({ page }) => {
  await page.goto('/playground');
  await page.getByRole('button', { name: 'Custom', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Manage tables (2)' })).toBeVisible();

  await page.getByRole('button', { name: 'Workspaces', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Workspaces' });
  await dialog.getByLabel('Name').fill('Week 3 lab');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog.getByRole('status')).toHaveText('Saved "Week 3 lab".');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();

  await page.reload();
  await page.getByRole('button', { name: 'Custom', exact: true }).click();
  await page.getByRole('button', { name: 'Workspaces', exact: true }).click();
  const reopened = page.getByRole('dialog', { name: 'Workspaces' });
  await expect(reopened.getByText('Week 3 lab')).toBeVisible();

  page.once('dialog', (d) => { void d.accept(); });
  await reopened.getByRole('listitem').filter({ hasText: 'Week 3 lab' }).getByRole('button', { name: 'Open' }).click();
  await expect(reopened).toBeHidden();
  await expect(page.getByRole('button', { name: 'Manage tables (2)' })).toBeVisible();

  await page.getByRole('button', { name: 'Workspaces', exact: true }).click();
  const again = page.getByRole('dialog', { name: 'Workspaces' });
  page.once('dialog', (d) => { void d.accept(); });
  await again.getByRole('listitem').filter({ hasText: 'Week 3 lab' }).getByRole('button', { name: 'Delete' }).click();
  await expect(again.getByRole('status')).toHaveText('Deleted "Week 3 lab".');
  await expect(again.getByText('Nothing saved yet.')).toBeVisible();
});

test('a workspace downloads as a file and opens from one (plan.md §H7)', async ({ page }) => {
  await page.goto('/playground');
  await page.getByRole('button', { name: 'Custom', exact: true }).click();
  await page.getByRole('button', { name: 'Workspaces', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Workspaces' });
  await dialog.getByLabel('Name').fill('Shared lab');

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    dialog.getByRole('button', { name: 'Download as a file' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('Shared-lab.querylens.json');
  const exported = JSON.parse(readFileSync(await download.path(), 'utf8')) as { format: string; name: string };
  expect(exported).toMatchObject({ format: 'querylens-workspace', name: 'Shared lab' });

  page.once('dialog', (d) => { void d.accept(); });
  await dialog.getByLabel('Workspace file').setInputFiles({
    name: 'tiny.querylens.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(tiny('Tiny'))),
  });
  await expect(page.getByRole('button', { name: 'Manage tables (1)' })).toBeVisible();
});

test('a file whose tables do not check out is refused whole, and the database is kept (plan.md §H7)', async ({ page }) => {
  await page.goto('/playground');
  await page.getByRole('button', { name: 'Custom', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Manage tables (2)' })).toBeVisible();

  await page.getByRole('button', { name: 'Workspaces', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Workspaces' });
  const broken = tiny('Broken');
  broken.database.tables.gadgets.name = 'not-gadgets';
  await dialog.getByLabel('Workspace file').setInputFiles({
    name: 'broken.querylens.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(broken)),
  });
  await expect(dialog.getByRole('status')).toContainText('do not check out');
  await expect(dialog).toBeVisible();
});
