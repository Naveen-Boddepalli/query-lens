import { expect, test } from '@playwright/test';

test('the sandbox shows sequential read-ahead as prefetches, and a later request for them is a hit (plan.md §25.4 F7)', async ({ page }) => {
  await page.goto('/tools/buffer-pool?ref=0%201%202%203%204%205%206%207&frames=8&policy=lru&ra=2');
  await page.getByLabel('Scrub to step').press('End');
  const stat = (label: string) => page.locator('dt', { hasText: label }).locator('xpath=following-sibling::dd');
  await expect(stat('misses')).toHaveText('2');
  await expect(stat('prefetched')).toHaveText('6');
  await expect(stat('hits')).toHaveText('6');
  await expect(stat('disk reads')).toHaveText('8');
});

test('the read-ahead control is in the URL, and off leaves no prefetches (plan.md §25.4 F7)', async ({ page }) => {
  await page.goto('/tools/buffer-pool?ref=0%201%202%203%204%205&frames=8&policy=lru');
  await expect(page.locator('dt', { hasText: 'prefetched' })).toHaveCount(0);
  await page.getByLabel('Read-ahead').selectOption('1');
  await expect.poll(() => page.url()).toMatch(/ra=1/);
  await page.getByLabel('Scrub to step').press('End');
  await expect(page.locator('dt', { hasText: 'prefetched' })).toBeVisible();
});

test('/compare exposes read-ahead across replacement policies (plan.md §25.4 F7)', async ({ page }) => {
  await page.goto('/compare');
  await expect(page.getByLabel('Read-ahead')).toHaveValue('0');
  await page.getByLabel('Reference string').fill('0 1 2 3 4 5');
  await page.getByLabel('Read-ahead').selectOption('2');
  await page.getByRole('button', { name: 'Run' }).click();
  await page.getByLabel('Access index').fill('6');
  const prefetched = page.locator('dt', { hasText: 'prefetched' });
  await expect(prefetched.first()).toBeVisible();
});
