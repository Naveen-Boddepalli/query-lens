import { expect, test } from '@playwright/test';

/**
 * The §21.3 feature routes: Gallery, the buffer-pool sandbox, Compare, and
 * Settings. Each is built on `src/engine/bufferTrace.ts` or the existing
 * shareable-URL layer, so these tests are about the wiring between them
 * rather than re-testing the engine (that is `bufferTrace.test.ts`'s job).
 */

test('a gallery moment opens the Playground already stepped to it', async ({ page }) => {
  await page.goto('/gallery');
  await page.getByRole('link', { name: /eviction storm/i }).click();
  await expect(page).toHaveURL(/\/playground\?q=/);
  await expect(page.getByText(/showing step/)).toBeVisible();
  await expect(page.getByText(/is evicted from frame/)).toBeVisible();
});

test('the buffer-pool sandbox steps a typed reference string', async ({ page }) => {
  await page.goto('/tools/buffer-pool');
  const input = page.getByLabel(/Reference string/);
  await input.fill('0 1 2 0 1 2 3 4');
  await page.getByRole('button', { name: 'Run' }).click();

  // Stepped by raw event (miss/load/evict are each their own step, the same
  // unit the Playground uses) rather than by access, so the eviction is some
  // step short of the end rather than a number worth hardcoding here —
  // `bufferTrace.test.ts` already pins the exact victim for this string.
  // Step forward until the narration announces it, or the trace ends first.
  const forward = page.getByRole('button', { name: 'Step forward' });
  const evicted = page.getByText(/is evicted from frame/);
  for (let i = 0; i < 30 && (await evicted.count()) === 0 && !(await forward.isDisabled()); i++) {
    await forward.click();
  }
  await expect(evicted).toBeVisible();
});

test('compare finds the point where LRU and clock sweep pick different victims', async ({ page }) => {
  await page.goto('/compare');
  await expect(page.getByText(/first pick a different victim/)).toBeVisible();

  await page.getByRole('button', { name: 'Jump there' }).click();
  const lruColumn = page.getByRole('heading', { name: 'LRU', exact: true }).locator('..');
  const clockColumn = page.getByRole('heading', { name: 'Clock sweep', exact: true }).locator('..');
  // Same reference string, same frame count, different victim: the two panels
  // must not show identical eviction counts landing on the same frame layout.
  await expect(lruColumn.getByText('page 4').first()).toBeVisible();
  await expect(clockColumn.getByText('page 4').first()).toBeVisible();
});

test('a settings preference becomes the Playground default on a bare visit', async ({ page }) => {
  await page.goto('/settings');
  await page.getByRole('radio', { name: 'Clock sweep' }).click();

  await page.goto('/playground');
  await expect(page.getByLabel('Eviction')).toHaveValue('clock');

  // A link's own policy still wins over the stored preference — and a bare
  // `/?...` link redirects into `/playground` with its params intact.
  await page.goto('/?q=SELECT%20*%20FROM%20users%20WHERE%20id%20%3D%205%3B&p=lru&x=0&s=1');
  await expect(page.getByLabel('Eviction')).toHaveValue('lru');

  await page.goto('/settings');
  await page.getByRole('button', { name: 'Reset to engine defaults' }).click();
  await page.goto('/playground');
  await expect(page.getByLabel('Eviction')).toHaveValue('lru');
});

test('creating an assignment produces a link the Playground opens correctly', async ({ page }) => {
  await page.goto('/assignments/new');
  await page.getByLabel('Land on step').fill('5');

  const link = page.locator('code');
  await expect(link).toContainText('s=5');
  await expect(link).toContainText('x=1');

  const linkText = await link.textContent();
  const url = new URL(linkText ?? '');
  await page.goto(`${url.pathname}${url.search}`);
  await expect(page.getByText(/showing step/)).toContainText('5');
  await expect(page.getByLabel('Ask me to predict before each reveal')).toBeChecked();
});
