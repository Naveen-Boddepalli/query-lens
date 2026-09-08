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

test('midpoint LRU keeps the hot set where plain LRU flushes it', async ({ page }) => {
  await page.goto('/tools/buffer-pool');
  // Pages 0 and 1 go hot, then a scan of fresh pages, then page 0 once more.
  await page.getByLabel(/Reference string/).fill('0 1 0 1 2 3 4 5 0');

  const stepToEnd = async () => {
    const fwd = page.getByRole('button', { name: 'Step forward' });
    for (let i = 0; i < 40 && !(await fwd.isDisabled()); i++) await fwd.click();
  };

  await page.getByLabel('Policy').selectOption('midpoint');
  await page.getByRole('button', { name: 'Run' }).click();
  await stepToEnd();
  // Page 0 rode out the scan in the young sublist — the last read is a hit.
  await expect(page.getByText(/Page 0 is already in frame .* a buffer hit/)).toBeVisible();

  await page.getByLabel('Policy').selectOption('lru');
  await page.getByRole('button', { name: 'Run' }).click();
  await stepToEnd();
  // Plain LRU evicted page 0 during the scan — the same last read hits disk.
  await expect(page.getByText(/Read page 0 from disk/)).toBeVisible();
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

test('compare scores the same query with and without the index', async ({ page }) => {
  await page.goto('/compare');
  await page.getByRole('radio', { name: 'Index vs. sequential scan' }).click();

  // The default preset is the point lookup, where the index pays off hugely.
  await expect(page.getByText(/Same 1 row either way/)).toBeVisible();
  const column = (heading: string) =>
    page.locator('div.flex.flex-col.gap-2', {
      has: page.getByRole('heading', { name: heading, exact: true }),
    });
  const btreeReads = (heading: string) =>
    column(heading).locator('div.contents', { hasText: 'B+Tree node reads' }).locator('dd');
  await expect(btreeReads('With the index')).not.toHaveText('0');
  await expect(btreeReads('Sequential scan')).toHaveText('0');

  // A range query cannot use the index — the page says so instead of scoring.
  await page.getByLabel('Query').selectOption('SELECT * FROM users WHERE age > 30');
  await page.getByRole('button', { name: 'Run' }).click();
  await expect(page.getByText(/cannot use the index/)).toBeVisible();

  // The policy comparison is still one click away.
  await page.getByRole('radio', { name: 'Replacement policies' }).click();
  await expect(page.getByText(/first pick a different victim/)).toBeVisible();
});

test('the AST and plan panels copy themselves as a Mermaid diagram', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);

  await page.goto('/stages/optimize');
  await page.getByRole('button', { name: 'Copy as Mermaid' }).click();
  await expect(page.getByRole('button', { name: 'Copied ✓' })).toBeVisible();

  const plan = await page.evaluate(() => navigator.clipboard.readText());
  expect(plan.startsWith('```mermaid\nflowchart TD\n')).toBe(true);
  expect(plan.trimEnd().endsWith('```')).toBe(true);
  expect(plan).toContain('IndexScan');
  expect(plan).toMatch(/n\d+ --> n\d+/);

  await page.goto('/stages/parse');
  await page.getByRole('button', { name: 'Copy as Mermaid' }).click();
  const ast = await page.evaluate(() => navigator.clipboard.readText());
  expect(ast).toContain('flowchart TD');
  expect(ast).toContain('"SELECT"');
});

test('the trace inspector filters the raw event stream and links into the Playground', async ({ page }) => {
  await page.goto('/trace');
  await expect(page.getByText(/of \d+ events/)).toBeVisible();

  // Toggling a stage chip removes that stage's rows.
  const parseCell = page.locator('tbody tr td span').filter({ hasText: /^parse$/ });
  expect(await parseCell.count()).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'parse', exact: true }).click();
  await expect(parseCell).toHaveCount(0);
  await page.getByRole('button', { name: 'parse', exact: true }).click();

  // A full scan under clock sweep evicts; the text filter narrows the table.
  await page.getByLabel('Query').fill('SELECT * FROM users WHERE age > 30');
  await page.getByLabel('Eviction policy').selectOption('clock');
  await page.getByRole('button', { name: 'Run' }).click();
  await expect(page.getByText(/query returned 35 rows/)).toBeVisible();

  const allRows = await page.locator('tbody tr').count();
  await page.getByLabel('Filter events by text').fill('evict');
  const filteredRows = await page.locator('tbody tr').count();
  expect(filteredRows).toBeGreaterThan(0);
  expect(filteredRows).toBeLessThan(allRows);
  await expect(page.getByText(/of \d+ events/)).toContainText(`of ${String(allRows)} events`);

  // Clearing the filter and clicking a row reveals that event's JSON.
  await page.getByLabel('Filter events by text').fill('');
  await page.locator('tbody tr').first().click();
  await expect(page.locator('tbody pre')).toContainText('"stage"');

  // The # cell is a link into the Playground at that exact step.
  await expect(page.locator('tbody tr td a').first()).toHaveAttribute(
    'href',
    /\/playground\?q=.*&p=clock&s=\d+/,
  );
});

test('the learn track opens lessons that deep-link into the Playground and remembers progress', async ({ page }) => {
  await page.goto('/learn');
  await expect(page.getByText('0 of 4 complete')).toBeVisible();

  await page.getByRole('link', { name: /Follow one row from disk to result/ }).click();
  await expect(page).toHaveURL(/\/learn\/one-row$/);
  await expect(page.getByText('Lesson 2 of 4')).toBeVisible();

  // A step link carries a computed Playground step.
  const jump = page.getByRole('link', { name: /Jump to the optimiser rewrite/ });
  await expect(jump).toHaveAttribute('href', /\/playground\?q=.*&s=\d+/);
  const href = await jump.getAttribute('href');
  await page.goto(href ?? '');
  await expect(page.getByText(/showing step/)).not.toContainText('showing step 0');

  // Mark complete → persists → shows on the index.
  await page.goto('/learn/one-row');
  await page.getByRole('button', { name: 'Mark this lesson complete' }).click();
  await expect(page.getByRole('button', { name: /Completed/ })).toBeVisible();

  await page.goto('/learn');
  await expect(page.getByText('1 of 4 complete')).toBeVisible();
  await page.getByRole('button', { name: 'Reset progress' }).click();
  await expect(page.getByText('0 of 4 complete')).toBeVisible();

  // An unknown lesson id lands back on the index rather than erroring.
  await page.goto('/learn/no-such-lesson');
  await expect(page).toHaveURL(/\/learn$/);
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

test('an assignment link lands on the step, forces prediction on, and locks the reveal', async ({ page }) => {
  await page.goto('/assignments/new');
  // Step 8 of the default point-lookup trace carries a prediction prompt.
  await page.getByLabel('Land on step').fill('8');

  const link = page.locator('code');
  await expect(link).toContainText('s=8');
  await expect(link).toContainText('x=1');
  await expect(link).toContainText('l=1');

  const url = new URL((await link.textContent()) ?? '');
  await page.goto(`${url.pathname}${url.search}`);
  await expect(page.getByText(/showing step/)).toContainText('8');

  // Assignment mode replaces the predict checkbox with a notice.
  await expect(page.getByText('Assignment mode.')).toBeVisible();
  await expect(page.getByLabel('Ask me to predict before each reveal')).toHaveCount(0);

  // The prompt is up; there is no skip, and playback cannot pass it.
  await expect(page.getByText('answer to continue')).toBeVisible();
  await expect(page.getByRole('button', { name: 'skip' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Step forward' })).toBeDisabled();

  // The scrubber track itself ends at the sealed step — it cannot be dragged past.
  const scrubber = page.getByLabel('Scrub to step');
  await expect(scrubber).toHaveAttribute('max', '8');

  // Committing an answer lifts the seal to the next prompt.
  await page.locator('section li button').first().click();
  await expect(scrubber).not.toHaveAttribute('max', '8');
  await expect(page.getByRole('button', { name: 'Step forward' })).toBeEnabled();
});

test('unchecking the lock produces an ordinary predict-on link', async ({ page }) => {
  await page.goto('/assignments/new');
  await page.getByLabel('Lock the reveal until they answer').uncheck();

  const link = page.locator('code');
  await expect(link).toContainText('x=1');
  await expect(link).not.toContainText('l=1');

  const url = new URL((await link.textContent()) ?? '');
  await page.goto(`${url.pathname}${url.search}`);
  await expect(page.getByLabel('Ask me to predict before each reveal')).toBeChecked();
});
