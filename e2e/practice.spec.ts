import { expect, test } from '@playwright/test';

// plan.md §25.4 G4: generated questions, engine-computed answers, a Leitner schedule kept in this browser.
test.beforeEach(async ({ page }) => {
  await page.goto('/practice');
  await page.evaluate(() => { localStorage.removeItem('querylens:practice'); });
  await page.reload();
});

test('a question is asked, answered, and explained', async ({ page }) => {
  const group = page.getByRole('radiogroup', { name: 'Answer' });
  await expect(group).toBeVisible();
  await group.getByRole('radio').first().check();
  await page.getByRole('button', { name: 'Check answer' }).click();
  await expect(page.getByRole('status')).toContainText(/Right\.|Not quite\./);
  await expect(page.getByRole('button', { name: 'Next question' })).toBeVisible();
});

test('the skills table records the answer and keeps it across a reload', async ({ page }) => {
  await page.getByRole('radiogroup', { name: 'Answer' }).getByRole('radio').first().check();
  await page.getByRole('button', { name: 'Check answer' }).click();
  const table = page.getByRole('table', { name: /Each skill, its Leitner box/ });
  await expect(table).toContainText(/\d of \d/);
  await page.reload();
  await expect(page.getByRole('table', { name: /Each skill, its Leitner box/ })).toContainText(/1 of 1|0 of 1/);
});

test('resetting practice starts again', async ({ page }) => {
  await page.getByRole('radiogroup', { name: 'Answer' }).getByRole('radio').first().check();
  await page.getByRole('button', { name: 'Check answer' }).click();
  await page.getByRole('button', { name: 'Reset practice' }).click();
  await expect(page.getByRole('table', { name: /Each skill, its Leitner box/ })).toContainText('not asked');
});
