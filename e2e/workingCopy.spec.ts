import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/** The working copy's record in IndexedDB, read directly: the table names, or null when there is no record. */
function storedTables(page: Page) {
  return page.evaluate(
    () =>
      new Promise<string | null>((resolve, reject) => {
        const open = indexedDB.open('querylens');
        open.onerror = () => { reject(open.error ?? new Error('IndexedDB could not be opened')); };
        open.onsuccess = () => {
          const db = open.result;
          const get = db.transaction('working').objectStore('working').get('working') as IDBRequest<
            { database: { tables: Record<string, unknown> } } | undefined
          >;
          get.onerror = () => { reject(get.error ?? new Error('IndexedDB read failed')); };
          get.onsuccess = () => {
            db.close();
            resolve(get.result ? Object.keys(get.result.database.tables).join(',') : null);
          };
        };
      }),
  );
}

const gadgets = {
  format: 'querylens-workspace',
  version: 1,
  name: 'Gadgets',
  database: { tables: { gadgets: { name: 'gadgets', columns: ['id', 'label'], rows: [{ id: 1, label: 'a' }] } } },
};

test('the custom database autosaves to IndexedDB and is still there after a reload (plan.md §H7)', async ({ page }) => {
  await page.goto('/playground');
  await page.getByRole('button', { name: 'Custom', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Manage tables (2)' })).toBeVisible();

  await page.getByRole('button', { name: 'Workspaces', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Workspaces' });
  page.once('dialog', (d) => { void d.accept(); });
  await dialog.getByLabel('Workspace file').setInputFiles({
    name: 'gadgets.querylens.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(gadgets)),
  });
  await expect(page.getByRole('button', { name: 'Manage tables (1)' })).toBeVisible();
  await expect.poll(() => storedTables(page)).toBe('gadgets');

  await page.reload();
  await page.getByRole('button', { name: 'Custom', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Manage tables (1)' })).toBeVisible();
});

test('a copy from the old localStorage key moves into IndexedDB once, and the old key is removed (plan.md §H7)', async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('seeded') === null) {
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem(
        'querylens.customDatabase.v1',
        JSON.stringify({ tables: { widgets: { name: 'widgets', columns: ['id'], rows: [{ id: 1 }] } } }),
      );
    }
  });
  await page.goto('/playground');
  await page.getByRole('button', { name: 'Custom', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Manage tables (1)' })).toBeVisible();
  await expect.poll(() => storedTables(page)).toBe('widgets');
  expect(await page.evaluate(() => localStorage.getItem('querylens.customDatabase.v1'))).toBeNull();
});
