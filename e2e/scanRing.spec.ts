import { expect, test } from '@playwright/test';

// plan.md §25.4 F7: a range in the reference string is one marked scan, and the ring keeps it from flushing the pool.
const REF = '0%201%202%203%204%2010-50%200%201%202%203%204';

test('a scan ring keeps the hot set resident across one long scan (plan.md §25.4 F7)', async ({ page }) => {
  await page.goto(`/tools/buffer-pool?ref=${REF}&frames=8&policy=lru`);
  const stat = (label: string) =>
    page.locator('dt', { hasText: label }).locator('xpath=following-sibling::dd');

  await page.getByLabel('Scrub to step').press('End');
  await expect(stat('misses')).toHaveText('51');

  await page.getByLabel('Scan ring').selectOption('3');
  await expect.poll(() => page.url()).toMatch(/sr=3/);
  await page.getByLabel('Scrub to step').press('End');
  // The five hot pages were still resident when the scan was done, so the last five reads were hits.
  await expect(stat('misses')).toHaveText('46');
  await expect(stat('hits')).toHaveText('5');
});

test('the ring says why it reused a page', async ({ page }) => {
  await page.goto(`/tools/buffer-pool?ref=${REF}&frames=8&policy=lru&sr=3`);
  await page.getByLabel('Scrub to step').fill('21');
  await expect(page.getByText('reads through a ring of 3 frames')).toBeVisible();
});
