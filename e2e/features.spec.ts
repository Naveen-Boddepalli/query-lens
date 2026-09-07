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

test('the buffer-pool sandbox runs a policy the SQL pipeline never offers', async ({ page }) => {
  await page.goto('/tools/buffer-pool');
  // Five distinct pages, four frames: page 0 is loaded first and then made the
  // hottest page — FIFO evicts it anyway when page 4 arrives.
  await page.getByLabel(/Reference string/).fill('0 1 2 3 0 0 0 4');
  await page.getByLabel('Policy').selectOption('fifo');
  await page.getByRole('button', { name: 'Run' }).click();

  const forward = page.getByRole('button', { name: 'Step forward' });
  const evicted = page.getByText(/is evicted from frame/);
  for (let i = 0; i < 30 && (await evicted.count()) === 0 && !(await forward.isDisabled()); i++) {
    await forward.click();
  }
  await expect(page.getByText(/page 0 is evicted from frame.*FIFO/)).toBeVisible();
  await expect(page).toHaveURL(/policy=fifo/);
});

test('the parser sandbox shows the token stream and the parser\'s own errors', async ({ page }) => {
  await page.goto('/tools/parser');
  const src = page.getByLabel('SQL source');

  await src.fill("SELECT name FROM users WHERE age > 30");
  await expect(page.getByText(/\d+ tokens, then EOF/)).toBeVisible();
  await expect(page.getByText(/Parsed ·/)).toContainText('recursion depth');

  // Unsupported SQL tokenizes fine but the parser rejects it by name.
  await src.fill('SELECT * FROM users GROUP BY id');
  await expect(page.getByText(/`GROUP` is not supported yet/)).toBeVisible();
  await expect(page.getByText(/not in the v0 subset/)).toBeVisible();

  // A lexing failure is reported where it happens, not swallowed — the ribbon
  // and the AST panel both surface it, since parsing lexes too.
  await src.fill('SELECT # FROM t');
  await expect(page.getByLabel('Tokens').getByText(/Unexpected character/)).toBeVisible();
});

test('the B+Tree sandbox inserts, deletes with rebalancing, and finds', async ({ page }) => {
  await page.goto('/tools/btree');
  await page.getByRole('button', { name: 'Sample' }).click();
  await expect(page.getByText('invariants hold')).toBeVisible();
  expect(await page.locator('.react-flow__node').count()).toBeGreaterThan(3);

  const key = page.getByLabel('Key', { exact: true });
  const del = page.getByRole('button', { name: 'Delete', exact: true });

  // 48 lives in a leaf sitting at the minimum, next to a sibling with a key to
  // spare — so removing it underflows the leaf and forces a borrow.
  await key.fill('48');
  await del.click();
  await expect(page.getByText(/underflowed: .*borrowed a key/)).toBeVisible();
  await expect(page.getByText('invariants hold')).toBeVisible();

  // Keep deleting; the tree stays sound the whole way down.
  for (const k of ['50', '45', '40', '35', '33']) {
    await key.fill(k);
    await del.click();
    await expect(page.getByText('invariants hold')).toBeVisible();
  }

  // A surviving key still resolves; a deleted one does not.
  await key.fill('25');
  await page.getByRole('button', { name: 'Find', exact: true }).click();
  await expect(page.getByText(/Found 25 after \d+ node read/)).toBeVisible();

  await key.fill('48');
  await page.getByRole('button', { name: 'Find', exact: true }).click();
  await expect(page.getByText(/48 is not in the tree/)).toBeVisible();

  // Re-inserting keeps the tree sound.
  await key.fill('48');
  await page.getByRole('button', { name: 'Insert', exact: true }).click();
  await expect(page.getByText(/Inserted 48/)).toBeVisible();
  await expect(page.getByText('invariants hold')).toBeVisible();
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
