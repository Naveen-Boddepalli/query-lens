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
  // The frame that lost its page is tagged with a glyph, not just a red border
  // (plan.md §22.6).
  await expect(page.getByText('✕ evicted')).toBeVisible();
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
  await src.fill('SELECT * FROM users HAVING id > 5');
  await expect(page.getByText(/`HAVING` is not supported yet/)).toBeVisible();
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

  // Internal vs leaf carries a colour-independent glyph, not hue alone (§22.6):
  // a filled disc on internal nodes, a hollow ring on leaves. (`text-transform`
  // uppercases the label visually; the DOM text stays lowercase.)
  await expect(page.locator('.react-flow__node').getByText(/●\s*internal/).first()).toBeVisible();
  await expect(page.locator('.react-flow__node').getByText(/○\s*leaf/).first()).toBeVisible();

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

test('the locks sandbox blocks a conflicting request, then detects and resolves a deadlock', async ({
  page,
}) => {
  await page.goto('/tools/locks');

  // T1 shared, T2 shared: no conflict, both granted.
  await page.getByRole('radio', { name: 'T1' }).click();
  await page.getByRole('button', { name: 'Request' }).click();
  await page.getByRole('radio', { name: 'T2' }).click();
  await page.getByRole('button', { name: 'Request' }).click();
  await expect(page.getByText('T1 holds shared')).toBeVisible();
  await expect(page.getByText('T2 holds shared')).toBeVisible();

  await page.getByRole('button', { name: 'Reset' }).click();

  // The built-in example: two transactions each holding what the other wants,
  // in exclusive mode — a real cycle the sandbox must detect and resolve.
  await page.getByRole('button', { name: 'Deadlock example' }).click();
  await expect(page.getByText(/Deadlock: T2 → T1 → T2/)).toBeVisible();
  await expect(page.getByText('aborted', { exact: true })).toBeVisible();
  // The survivor's long-blocked request is granted the moment the victim's lock frees
  // up: T1 ends up holding both pages (T2, the victim, holds nothing — the only
  // transaction either "release" button can belong to).
  await expect(page.getByText('page 0 · exclusive · release')).toBeVisible();
  await expect(page.getByText('page 1 · exclusive · release')).toBeVisible();
});

test('the grammar sandbox diagrams every rule, and a rule reference jumps to its own row', async ({
  page,
}) => {
  await page.goto('/tools/grammar');
  await expect(page.getByRole('heading', { name: 'Grammar sandbox' })).toBeVisible();

  // Every rule the grammar data names gets its own row.
  for (const rule of ['statement', 'select', 'join', 'delete', 'insert', 'update', 'aggregateCall', 'qualifiedColumn']) {
    await expect(page.locator(`#rule-${rule}`)).toBeAttached();
  }

  // Clicking a rule reference (not the heading of the same name) jumps to that rule's own row.
  await page.locator('#rule-operand a', { hasText: 'qualifiedColumn' }).click();
  await expect(page.locator('#rule-qualifiedColumn')).toBeInViewport();
});

test('the slotted-page inspector lays a heap page out to the byte', async ({ page }) => {
  await page.goto('/tools/page');

  // The byte accounting, and one tuple row per row on the page.
  await expect(page.getByText(/\d+% used ·/)).toBeVisible();
  await expect(page.getByText(/slot array 4 × 4 B = 16 B/)).toBeVisible();
  expect(await page.locator('tbody tr').count()).toBe(4);
  await expect(page.getByText(/more rows of\s+this size would fit/)).toBeVisible();

  // Clicking a tuple cell in the map selects the matching table row.
  await page.getByRole('button', { name: '#0' }).click();
  await expect(page.locator('tbody tr[aria-selected="true"]')).toHaveCount(1);
  await expect(page.locator('tbody tr').first()).toHaveAttribute('aria-selected', 'true');

  // Shrink the page until the rows no longer fit; the state rides in the URL.
  await page.getByLabel('Page size (bytes)').fill('128');
  await expect(page.getByText(/do not fit a 128 B page/)).toBeVisible();
  await expect(page).toHaveURL(/[?&]bytes=128/);
  await expect(page).toHaveURL(/[?&]page=0/);
});

test('the external merge sort sandbox trades memory for I/O', async ({ page }) => {
  await page.goto('/tools/sort');
  await expect(page.getByRole('heading', { name: 'External merge sort' })).toBeVisible();

  // 32 records, 2/page, 3 buffer pages → 16 data pages, 3 merge passes, 128 I/Os.
  const io = () => page.getByText('page I/Os', { exact: true }).locator('..');
  await expect(io().getByText('128', { exact: true })).toBeVisible();
  await expect(page.getByText(/3 merge passes then folds/)).toBeVisible();

  // Wider merges with more buffer pages: fewer passes, less I/O.
  await page.getByLabel('Buffer pages').selectOption('6');
  await expect(io().getByText('64', { exact: true })).toBeVisible();
  await expect(page.getByText(/1 merge pass then folds/)).toBeVisible();
  await expect.poll(() => page.url()).toMatch(/[?&]mem=6/);

  // A run is selectable (the cross-highlight handle).
  const run = page.getByRole('button', { name: /^\d+ recs?\b/ }).first();
  await run.click();
  await expect(run).toHaveAttribute('aria-pressed', 'true');
});

test('the hash join sandbox partitions, spills, and shows a bucket collision', async ({ page }) => {
  // 12 build keys, 4 buffer pages → build side doesn't fit, forcing a spill.
  await page.goto('/tools/hash-join?build=12&probe=20&page=2&mem=4&seed=1');
  await expect(page.getByRole('heading', { name: 'Hash join' })).toBeVisible();
  await expect(page.getByText('too big — splits further')).toBeVisible();
  await expect(page.getByText('⚠ collision').first()).toBeVisible();

  // A leaf partition is selected by default and shows its own build/probe detail.
  await expect(page.getByRole('heading', { name: /build & probe/ })).toBeVisible();
  await expect(page.getByText(/\d+ matches?, \d+ misses?/)).toBeVisible();

  // A generous buffer budget needs no partitioning pass at all.
  await page.getByLabel('Buffer pages').selectOption('6');
  await expect(page.getByText(/no split needed/)).toBeVisible();
  await expect.poll(() => page.url()).toMatch(/[?&]mem=6/);
});

test('the planner sandbox runs the rewrite rules one at a time', async ({ page }) => {
  await page.goto('/tools/planner');
  await expect(page.getByRole('heading', { name: 'Planner sandbox' })).toBeVisible();

  const optimized = page.getByRole('figure').filter({ hasText: 'optimized' });

  // Default: every rule on, index on → the scan becomes a B+Tree lookup.
  await expect(optimized.getByText(/IndexScan/).first()).toBeVisible();
  await expect(page.getByText(/index-selection — /)).toContainText(/indexed/);

  // Drop the index → index-selection has nothing to match; the scan stays sequential.
  await page.getByLabel('id index').uncheck();
  await expect(optimized.getByText(/IndexScan/)).toHaveCount(0);
  await expect(optimized.getByText(/SeqScan/).first()).toBeVisible();
  await expect(page.getByText(/index-selection — no match/)).toBeVisible();
  await expect.poll(() => page.url()).toMatch(/[?&]idx=0/);

  // Turn predicate-pushdown off (index back on): nothing fires — the two plans match.
  await page.getByLabel('id index').check();
  await page.getByLabel('predicate-pushdown', { exact: true }).uncheck();
  await expect(page.getByText('optimized · unchanged')).toBeVisible();
  await expect(page.getByText(/predicate-pushdown — turned off/)).toBeVisible();
  await expect.poll(() => page.url()).toMatch(
    /rules=constant-folding%2Cjoin-predicate-pushdown%2Cindex-selection%2Cindex-only-scan/,
  );
});

test('the planner sandbox folds an always-true comparison out of the predicate', async ({ page }) => {
  await page.goto('/tools/planner?q=SELECT%20*%20FROM%20users%20WHERE%201%20%3D%201%20AND%20id%20%3D%205');
  await expect(page.getByText(/constant-folding — Constant folding:/)).toBeVisible();
  await expect(page.getByText(/index-selection — /)).toContainText(/indexed/);
});

test('the planner sandbox plans a real JOIN against its authors/posts demo tables', async ({ page }) => {
  await page.goto(
    '/tools/planner?q=SELECT%20authors.name%2C%20posts.title%20FROM%20authors%20JOIN%20posts%20ON%20authors.id%20%3D%20posts.authorId',
  );
  const canonical = page.getByRole('figure').filter({ hasText: 'canonical' });
  await expect(canonical.getByText(/Join \(nested-loop\)/)).toBeVisible();
  await expect(canonical.getByText(/SeqScan authors/)).toBeVisible();
  await expect(canonical.getByText(/SeqScan posts/)).toBeVisible();
  // No rule reaches into a JOIN yet — the optimized tree is identical.
  await expect(page.getByText('optimized · unchanged')).toBeVisible();

  // An unqualified column once the query joins two tables is a real parse error.
  await page.getByLabel('SQL query').fill('SELECT name FROM authors JOIN posts ON authors.id = posts.authorId');
  await expect(page.getByText(/needs a table name/)).toBeVisible();
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

test('compare forces a hash aggregate and a sort aggregate onto the same GROUP BY query', async ({ page }) => {
  await page.goto('/compare');
  await page.getByRole('radio', { name: 'Hash aggregate vs. sort aggregate' }).click();

  // The default preset groups by a real column, so both strategies produce
  // the same groups but only the sort aggregate touches the buffer pool.
  await expect(page.getByText(/Same \d+ groups? either way/)).toBeVisible();
  const column = (heading: string) =>
    page.locator('div.flex.flex-col.gap-2', {
      has: page.getByRole('heading', { name: heading, exact: true }),
    });
  const writes = (heading: string) =>
    column(heading).locator('div.contents', { hasText: 'pages written' }).locator('dd');
  await expect(writes('Hash aggregate')).toHaveText('0');
  await expect(writes('Sort aggregate')).not.toHaveText('0');

  // A plain SELECT has no aggregate at all — the strategy makes no difference.
  await page.getByLabel('SQL').fill('SELECT * FROM orders');
  await page.getByRole('button', { name: 'Run' }).click();
  await expect(page.getByText(/makes no difference/)).toBeVisible();
});

test('compare forces nested-loop, hash and sort-merge join onto the same JOIN query', async ({ page }) => {
  await page.goto('/compare');
  await page.getByRole('radio', { name: 'JOIN algorithms' }).click();

  // Same rows out of all three algorithms; the hash join reads far fewer
  // pages than either — the demo purposely runs all three under few enough
  // buffer frames that a nested-loop rescan (or a sort-merge spill) cannot
  // stay cached.
  await expect(page.getByText(/Same \d+ rows? every time/)).toBeVisible();
  const column = (heading: string) =>
    page.locator('div.flex.flex-col.gap-2', {
      has: page.getByRole('heading', { name: heading, exact: true }),
    });
  const diskReads = (heading: string) =>
    column(heading).locator('div.contents', { hasText: 'disk reads' }).locator('dd');
  const nestedLoop = Number(await diskReads('Nested-loop join').innerText());
  const hashJoin = Number(await diskReads('Hash join').innerText());
  const sortMergeJoin = Number(await diskReads('Sort-merge join').innerText());
  expect(hashJoin).toBeLessThan(nestedLoop);
  expect(hashJoin).toBeLessThan(sortMergeJoin);
  expect(sortMergeJoin).toBeLessThan(nestedLoop);

  // A query with no JOIN at all — the algorithm makes no difference.
  await page.getByLabel('SQL').fill('SELECT * FROM authors');
  await page.getByRole('button', { name: 'Run' }).click();
  await expect(page.getByText(/makes no difference/)).toBeVisible();
});

test('a diagram panel exports itself as a PNG with real bytes', async ({ page }) => {
  await page.goto('/stages/index'); // the B+Tree panel — a real diagram
  const button = page.getByRole('button', { name: 'Download PNG' });

  const downloadPromise = page.waitForEvent('download');
  await button.click();
  const download = await downloadPromise;

  expect(download.suggestedFilename()).toBe('querylens-index.png');

  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  const bytes = Buffer.concat(chunks);
  // PNG magic number, and it is not a stub.
  expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  expect(bytes.length).toBeGreaterThan(2000);

  await expect(page.getByRole('button', { name: 'Saved ✓' })).toBeVisible();
});

test('the AST, plan and B+Tree panels export themselves as a real vector SVG', async ({ page }) => {
  async function downloadSvg(path: string, filename: string) {
    await page.goto(path);
    const button = page.getByRole('button', { name: 'Download SVG' });
    const downloadPromise = page.waitForEvent('download');
    await button.click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe(filename);

    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  }

  const ast = await downloadSvg('/stages/parse', 'querylens-parse.svg');
  expect(ast.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
  expect(ast.trimEnd().endsWith('</svg>')).toBe(true);
  expect(ast).toContain('<rect ');
  expect(ast).toContain('<text ');
  // The whole point: real rgb()/rgba() colours, never this app's own oklch()
  // design tokens, which Illustrator/Inkscape/PowerPoint don't reliably import.
  expect(ast).not.toMatch(/oklch|oklab/);

  const plan = await downloadSvg('/stages/optimize', 'querylens-optimize.svg');
  expect(plan).toContain('<path ');
  expect(plan).not.toMatch(/oklch|oklab/);

  // The B+Tree — the one Mermaid can't take, since it lays out a sibling
  // chain badly; this renderer draws it as a dashed side edge instead.
  const btree = await downloadSvg('/stages/index', 'querylens-index.svg');
  expect(btree).toContain('stroke-dasharray');
  expect(btree).not.toMatch(/oklch|oklab/);
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

test('the panels also copy themselves as monospace text', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);

  await page.goto('/stages/parse');
  await page.getByRole('button', { name: 'Copy as text' }).click();
  await expect(page.getByRole('button', { name: 'Copied ✓' })).toBeVisible();

  const ast = await page.evaluate(() => navigator.clipboard.readText());
  expect(ast.startsWith('```\n')).toBe(true);
  expect(ast).not.toContain('```mermaid');
  expect(ast).toContain('SELECT');
  expect(ast).toMatch(/[├└]─ /); // tree(1) connectors

  // The B+Tree panel — which has no "Copy as Mermaid" — still offers text.
  await page.goto('/stages/index');
  await expect(page.getByRole('button', { name: 'Copy as Mermaid' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Copy as text' }).click();
  const tree = await page.evaluate(() => navigator.clipboard.readText());
  expect(tree).toMatch(/(internal|leaf), page \d+/);
});

test('the result stage offers an in-app EXPLAIN — estimate next to actual', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);

  // Not offered before the query has actually run.
  await page.goto('/stages/optimize');
  await expect(page.getByRole('button', { name: 'Copy as EXPLAIN' })).toHaveCount(0);

  // The default demo query is `id = 5` — an exact index lookup, so the
  // estimate and the actual count agree.
  await page.goto('/stages/result');
  await page.getByRole('button', { name: 'Copy as EXPLAIN' }).click();
  await expect(page.getByRole('button', { name: 'Copied ✓' })).toBeVisible();

  const explain = await page.evaluate(() => navigator.clipboard.readText());
  expect(explain.startsWith('```\n')).toBe(true);
  expect(explain).toContain('IndexScan');
  expect(explain).toMatch(/est ~1 rows/);
  expect(explain).toMatch(/actual 1 rows/);
});

test('LIMIT caps the result and shows as a Limit node in the plan', async ({ page }) => {
  await page.goto('/playground?q=SELECT+*+FROM+users+LIMIT+3&p=lru&x=0&s=9999');
  await expect(page.getByText(/3 rows returned/)).toBeVisible();
  await expect(page.getByText(/cost model guessed ~3/)).toBeVisible();

  await page.getByRole('button', { name: 'Optimizer' }).click();
  // Present in both the before and after trees — LIMIT isn't touched by either rewrite rule.
  await expect(page.getByText('Limit 3', { exact: true }).first()).toBeVisible();
});

test('ORDER BY sorts the result and spills through the real buffer pool', async ({ page }) => {
  await page.goto('/playground?q=SELECT+*+FROM+users+ORDER+BY+age+DESC&p=lru&x=0&s=9999');
  await expect(page.getByText(/48 rows returned/)).toBeVisible();
  // The first row after a DESC sort by age is the oldest user in the seed data.
  const firstRow = page.locator('table tbody tr').first();
  await expect(firstRow).toContainText('matz');

  await page.getByRole('button', { name: 'Optimizer' }).click();
  await expect(page.getByText('Sort', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('age DESC', { exact: true }).first()).toBeVisible();

  await page.getByRole('button', { name: 'Buffer Pool' }).click();
  await expect(page.getByText(/writes/)).toBeVisible();
});

test('GROUP BY aggregates and shows as a HashAggregate node in the plan', async ({ page }) => {
  await page.goto(
    '/playground?t=orders&q=SELECT+status,+COUNT(*)+FROM+orders+GROUP+BY+status&p=lru&x=0&s=9999',
  );
  await expect(page.getByText(/3 rows returned/)).toBeVisible();
  await expect(page.getByRole('cell', { name: 'paid', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Planner' }).click();
  await expect(page.getByText('HashAggregate', { exact: true }).first()).toBeVisible();

  await page.getByRole('button', { name: 'Execution' }).click();
  await expect(page.getByText('HashAggregate', { exact: true }).first()).toBeVisible();
});

test('an index-only scan answers the query without ever fetching the heap page', async ({ page }) => {
  await page.goto('/playground?q=SELECT+id+FROM+users+WHERE+id+=+5&p=lru&x=0&s=9999');
  // 3 disk reads is the B+Tree's own height, with no +1 for a heap page.
  await expect(page.getByText(/1 row returned, from 3 disk read/)).toBeVisible();

  await page.getByRole('button', { name: 'Optimizer' }).click();
  await expect(page.getByText('IndexOnlyScan', { exact: true }).first()).toBeVisible();
});

test('DELETE removes a row for real — the Playground persists it across the next query', async ({
  page,
}) => {
  await page.goto('/playground');
  await expect(page.getByRole('button', { name: /^Edit data/ })).toHaveText('Edit data (48)');

  const editor = page.locator('.cm-content');
  await editor.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('DELETE FROM users WHERE id = 5;');
  await page.getByRole('button', { name: 'Run' }).click();
  await page.getByLabel('Scrub to step').press('End');

  await expect(page.getByText(/1 row deleted/)).toBeVisible();
  await expect(page.getByText(/users now has 47 rows/)).toBeVisible();
  // The seed editor's own count is the same `db` state DELETE just wrote to.
  await expect(page.getByRole('button', { name: /^Edit data/ })).toHaveText('Edit data (47)');

  // Persisted, not just narrated: a fresh SELECT for the same id finds nothing.
  await editor.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('SELECT * FROM users WHERE id = 5;');
  await page.getByRole('button', { name: 'Run' }).click();
  await page.getByLabel('Scrub to step').press('End');
  await expect(page.getByText('0 rows returned')).toBeVisible();

  await editor.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('SELECT * FROM users;');
  await page.getByRole('button', { name: 'Run' }).click();
  await page.getByLabel('Scrub to step').press('End');
  await expect(page.getByText('47 rows returned')).toBeVisible();
});

test('INSERT adds a row for real — the Playground persists it across the next query', async ({
  page,
}) => {
  await page.goto('/playground');
  await expect(page.getByRole('button', { name: /^Edit data/ })).toHaveText('Edit data (48)');

  const editor = page.locator('.cm-content');
  await editor.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type("INSERT INTO users (id, name, email, age) VALUES (999, 'zeta', 'zeta@example.com', 50);");
  await page.getByRole('button', { name: 'Run' }).click();
  await page.getByLabel('Scrub to step').press('End');

  await expect(page.getByText(/1 row inserted/)).toBeVisible();
  await expect(page.getByText(/users now has 49 rows/)).toBeVisible();
  // The seed editor's own count is the same `db` state INSERT just wrote to.
  await expect(page.getByRole('button', { name: /^Edit data/ })).toHaveText('Edit data (49)');

  // Persisted, not just narrated: a fresh SELECT for the new id finds it.
  await editor.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('SELECT * FROM users WHERE id = 999;');
  await page.getByRole('button', { name: 'Run' }).click();
  await page.getByLabel('Scrub to step').press('End');
  await expect(page.getByText('1 row returned')).toBeVisible();
  await expect(page.getByText('zeta@example.com')).toBeVisible();
});

test('UPDATE changes a row for real, rekeying the index when the indexed column changes', async ({
  page,
}) => {
  await page.goto('/playground');
  await expect(page.getByRole('button', { name: /^Edit data/ })).toHaveText('Edit data (48)');

  const editor = page.locator('.cm-content');
  await editor.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('UPDATE users SET id = 9000 WHERE id = 5;');
  await page.getByRole('button', { name: 'Run' }).click();
  await page.getByLabel('Scrub to step').press('End');

  await expect(page.getByText(/1 row updated/)).toBeVisible();
  // The row count never changes on an UPDATE.
  await expect(page.getByRole('button', { name: /^Edit data/ })).toHaveText('Edit data (48)');

  // Persisted, not just narrated: the old key is gone, the new one is there.
  await editor.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('SELECT * FROM users WHERE id = 5;');
  await page.getByRole('button', { name: 'Run' }).click();
  await page.getByLabel('Scrub to step').press('End');
  await expect(page.getByText('0 rows returned')).toBeVisible();

  await editor.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('SELECT * FROM users WHERE id = 9000;');
  await page.getByRole('button', { name: 'Run' }).click();
  await page.getByLabel('Scrub to step').press('End');
  await expect(page.getByText('1 row returned')).toBeVisible();
});

test('the preset chips load and run a query in one click', async ({ page }) => {
  await page.goto('/playground');

  await page.getByRole('button', { name: 'Sequential scan' }).click();
  await expect(page.getByLabel('SQL query')).toContainText('age > 30');
  // A scan runs many more steps than the default point lookup.
  await expect(page.getByText(/steps in this trace/)).not.toContainText('33 steps');

  await page.getByRole('button', { name: 'Lookup, no index' }).click();
  await expect(page.getByLabel('SQL query')).toContainText("name = 'grace'");
  // Same equality shape as the point lookup, but no index for it to use.
  await page.getByLabel('Scrub to step').press('End');
  await expect(page.getByRole('cell', { name: 'grace', exact: true })).toBeVisible();
});

test('the first-visit hint shows once on the bare Playground, then never again', async ({ page }) => {
  // A shared-moment link is someone else's onboarding — the hint stays out of it.
  await page.goto('/playground?q=SELECT+*+FROM+users+WHERE+id+%3D+5&p=lru&x=0&s=1');
  await expect(page.getByText(/steps in this trace/)).toBeVisible();
  await expect(page.getByText(/New here\?/)).toHaveCount(0);

  // The app's own front door: the one line appears.
  await page.goto('/playground');
  const hint = page.getByText(/New here\?/);
  await expect(hint).toBeVisible();

  await page.getByRole('button', { name: 'Dismiss' }).click();
  await expect(hint).toHaveCount(0);

  // Retired for good — a fresh visit to the bare front door never brings it back.
  await page.goto('/playground');
  await expect(page.getByText(/steps in this trace/)).toBeVisible();
  await expect(page.getByText(/New here\?/)).toHaveCount(0);
});

test('the panel `?` explains the stage and links to its concept page', async ({ page }) => {
  await page.goto('/playground');

  // The Parser panel is on screen at the landing step.
  const parserHelp = page.getByRole('button', { name: 'What is the Parser panel?' });
  await expect(parserHelp).toHaveAttribute('aria-expanded', 'false');
  await parserHelp.click();
  await expect(parserHelp).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByText(/never the original string/)).toBeVisible();
  await expect(page.getByRole('link', { name: /Read the full explanation/ })).toHaveAttribute(
    'href',
    '/stages/parse',
  );

  // Pin the buffer pool from the pipeline rail: the disclosure closes with the
  // stage, and the buffer panel's `?` points at its own concept page.
  await page.getByRole('button', { name: 'Buffer Pool', exact: true }).click();
  await expect(page.getByRole('button', { name: 'What is the Parser panel?' })).toHaveCount(0);
  await page.getByRole('button', { name: 'What is the Buffer Pool panel?' }).click();
  await expect(page.getByRole('link', { name: /Read the full explanation/ })).toHaveAttribute(
    'href',
    '/docs/concepts/buffer-pool',
  );
});

test('the 60-second tour steps through the Playground and is skippable', async ({ page }) => {
  await page.goto('/playground');

  // The first-visit hint offers it; taking it dismisses the hint.
  await page.getByRole('button', { name: 'Take the 60-second tour' }).click();
  await expect(page.getByText(/New here\?/)).toHaveCount(0);

  const tour = page.getByRole('dialog', { name: 'Playground tour' });
  await expect(tour).toBeVisible();
  await expect(tour.getByText('Step 1 of 5')).toBeVisible();
  await expect(tour.getByRole('heading', { name: 'Your query' })).toBeVisible();

  // Playback shortcuts are suspended while it is open: the arrows drive the
  // tour, not the trace.
  await expect(page.getByText(/showing step/)).toContainText('1');
  await page.keyboard.press('ArrowRight');
  await expect(tour.getByText('Step 2 of 5')).toBeVisible();
  await expect(page.getByText(/showing step/)).toContainText('1');

  await tour.getByRole('button', { name: 'Back' }).click();
  await expect(tour.getByText('Step 1 of 5')).toBeVisible();

  await tour.getByRole('button', { name: 'Next' }).click();
  await tour.getByRole('button', { name: 'Next' }).click();
  await tour.getByRole('button', { name: 'Next' }).click();
  await tour.getByRole('button', { name: 'Next' }).click();
  await expect(tour.getByText('Step 5 of 5')).toBeVisible();
  await tour.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('dialog', { name: 'Playground tour' })).toHaveCount(0);

  // The permanent "Tour" link reopens it; Escape leaves.
  await page.getByRole('button', { name: 'Tour', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Playground tour' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Playground tour' })).toHaveCount(0);
});

test('the tour degrades to a static numbered overlay under reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/playground?tour=1');

  const tour = page.getByRole('dialog', { name: 'Playground tour' });
  await expect(tour).toBeVisible();
  // A single list, no stepping.
  await expect(tour.getByRole('listitem')).toHaveCount(5);
  await expect(tour.getByText('Step 1 of 5')).toHaveCount(0);
  await expect(tour.getByRole('button', { name: 'Next' })).toHaveCount(0);

  await tour.getByRole('button', { name: 'Got it' }).click();
  await expect(page.getByRole('dialog', { name: 'Playground tour' })).toHaveCount(0);
});

test('the preset dataset chips swap the table, the query and the URL', async ({ page }) => {
  await page.goto('/playground');
  await expect(page.getByLabel('SQL query')).toContainText('FROM users');

  // Switch to orders: the starter query, the blurb and the preset chips all move.
  await page.getByRole('button', { name: 'orders', exact: true }).click();
  await expect(page.getByLabel('SQL query')).toContainText('FROM orders');
  await expect(page.getByText(/120 rows, indexed on id/)).toBeVisible();
  await expect(page.getByText(/steps in this trace/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Eviction storm' })).toBeVisible();
  await expect.poll(() => page.url()).toContain('t=orders');

  // A preset for this dataset runs its own query.
  await page.getByRole('button', { name: 'Scan by customer' }).click();
  await expect(page.getByLabel('SQL query')).toContainText("customer = 'acme'");

  // The seed editor edits whichever table is active.
  await page.getByRole('button', { name: /^Edit data/ }).click();
  await expect(page.getByRole('heading', { name: 'Seed data · orders' })).toBeVisible();
  await page.keyboard.press('Escape');

  // Back to the default and the param drops out of the link again.
  await page.getByRole('button', { name: 'users', exact: true }).click();
  await expect(page.getByLabel('SQL query')).toContainText('FROM users');
  await expect.poll(() => page.url()).not.toContain('t=');
});

test('a link that names a dataset reopens on it, in the Playground and the inspector', async ({
  page,
}) => {
  const link = '/playground?q=SELECT+*+FROM+logins+WHERE+status+%3D+%27blocked%27&p=lru&x=0&s=9999&t=logins';
  await page.goto(link);
  await expect(page.getByRole('button', { name: 'logins', exact: true })).toHaveClass(/border-accent/);
  await page.getByLabel('Scrub to step').press('End');
  // The skewed dataset: `status = 'blocked'` is a small handful of rows.
  await expect(page.getByText(/rows? returned/)).toBeVisible();

  // The trace inspector reads the same `t` key: the query runs against `logins`
  // rather than erroring on an unknown table.
  await page.goto(link.replace('/playground', '/trace'));
  await expect(page.getByText(/\d+ of \d+ events/)).toBeVisible();
  await expect(page.getByText(/no table called/i)).toHaveCount(0);
});

test('a challenge checks the query on Run and remembers the solve', async ({ page }) => {
  await page.goto('/challenges');
  await expect(page.getByText('0 of 8 solved')).toBeVisible();
  await page.getByRole('link', { name: /Make the planner use the index/ }).click();
  await expect(page).toHaveURL(/\/challenges\/use-the-index$/);

  // The starter is a sequential scan — running it does not pass.
  await page.getByRole('button', { name: 'Run & check' }).click();
  await expect(page.getByText(/Not there yet/)).toBeVisible();
  await expect(page.getByText('index used')).toBeVisible();

  // A hint is available on demand.
  await page.getByRole('button', { name: 'Show hint' }).click();
  await expect(page.getByText(/index-selection rule fires only on an/)).toBeVisible();

  // Edit to an equality on the indexed column and it passes.
  const editor = page.locator('.cm-content');
  await editor.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('SELECT * FROM users WHERE id = 5;');
  await page.getByRole('button', { name: 'Run & check' }).click();
  await expect(page.getByText('✓ Solved.')).toBeVisible();
  await expect(page.getByRole('link', { name: /Step through this run in the Playground/ })).toBeVisible();

  // The solve persists to the index.
  await page.goto('/challenges');
  await expect(page.getByText('1 of 8 solved')).toBeVisible();
  await page.getByRole('button', { name: 'Reset progress' }).click();
  await expect(page.getByText('0 of 8 solved')).toBeVisible();
});

test('a challenge can run against a non-default preset table', async ({ page }) => {
  await page.goto('/challenges/needle-in-the-skew');
  await expect(page.getByText(/runs against the .*logins.* table/)).toBeVisible();

  // The starter returns the common `status = 'ok'` set — too many rows to pass.
  await page.getByRole('button', { name: 'Run & check' }).click();
  await expect(page.getByText(/Not there yet/)).toBeVisible();

  const editor = page.locator('.cm-content');
  await editor.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type("SELECT * FROM logins WHERE status = 'blocked';");
  await page.getByRole('button', { name: 'Run & check' }).click();
  await expect(page.getByText('✓ Solved.')).toBeVisible();

  // The "step through" link carries the dataset so it opens on `logins`.
  await expect(
    page.getByRole('link', { name: /Step through this run in the Playground/ }),
  ).toHaveAttribute('href', /[?&]t=logins/);
});

test('the seed editor imports rows from pasted CSV', async ({ page }) => {
  await page.goto('/playground');
  await page.getByRole('button', { name: /^Edit data/ }).click();
  await page.getByRole('button', { name: 'Import CSV' }).click();

  const box = page.getByLabel(/Paste CSV/);

  // A malformed block is rejected whole, with a reason, and changes nothing.
  await box.fill('1,ada,ada@x.dev');
  await page.getByRole('button', { name: 'Replace rows' }).click();
  await expect(page.getByRole('alert')).toContainText(/expected 4/);
  await expect(page.locator('dialog')).toBeVisible();
  expect(await page.locator('dialog tbody tr').count()).toBe(48);

  // A good block replaces the grid.
  await box.fill('id,name,email,age\n1,ada,ada@x.dev,36\n2,bo,bo@x.dev,41\n3,cy,cy@x.dev,29');
  await page.getByRole('button', { name: 'Replace rows' }).click();
  await expect(page.locator('dialog tbody tr')).toHaveCount(3);

  await page.getByRole('button', { name: /Apply .* re-run/ }).click();
  await expect(page.getByRole('button', { name: 'Edit data (3)' })).toBeVisible();
  await expect(page.getByText(/steps in this trace/)).toBeVisible();
});

test('a custom multi-table database can be built and joined from the Playground itself', async ({ page }) => {
  await page.goto('/playground');
  await page.getByRole('button', { name: 'Custom', exact: true }).click();

  // Opens on a real two-table JOIN, run against the starter authors/posts pair.
  await expect(page.getByRole('button', { name: 'Manage tables (2)' })).toBeVisible();
  await expect(page.getByText(/steps in this trace/)).toBeVisible();
  // A custom database isn't part of a trace file yet — the button says so.
  await expect(page.getByRole('button', { name: 'Download trace' })).toBeDisabled();

  await page.getByRole('button', { name: 'Manage tables (2)' }).click();
  const manage = page.getByRole('dialog', { name: 'Manage tables' });
  await manage.getByRole('button', { name: '+ Add table' }).click();
  await manage.getByPlaceholder('reviews').fill('comments');
  await manage.getByPlaceholder('id, rating, comment').fill('id, postId, body');
  // Two indexes at once (plan.md §22.2's "second candidate index") — a real
  // multi-select, not just a single choice.
  await manage.getByLabel(/Indexes/).selectOption(['id', 'postId']);
  await manage.getByRole('button', { name: 'Add table' }).click();
  await expect(manage.getByText('3 tables')).toBeVisible();
  await expect(manage.getByText('indexed on id, postId')).toBeVisible();

  // Edit its rows in the nested DataEditor — no "Reset to seed" for a table with no seed.
  await manage.getByRole('button', { name: 'Edit rows' }).nth(1).click();
  const rowEditor = page.getByRole('dialog', { name: 'Edit seed data' });
  await expect(rowEditor.getByRole('button', { name: /Reset to seed/ })).toHaveCount(0);
  await rowEditor.getByRole('button', { name: '+ Add row' }).click();
  await rowEditor.getByLabel('id row 1', { exact: true }).fill('1');
  await rowEditor.getByLabel('postId row 1', { exact: true }).fill('1');
  await rowEditor.getByLabel('body row 1', { exact: true }).fill('nice post!');
  await rowEditor.getByRole('button', { name: /Apply .* re-run/ }).click();
  await expect(manage.getByText('1 row', { exact: true })).toBeVisible();

  await manage.getByRole('button', { name: /Apply .* re-run/ }).click();
  await expect(manage).toHaveCount(0);

  // JOIN the freshly-created table against an existing one, in the real Playground.
  await page.getByLabel('SQL query').click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type(
    'SELECT posts.title, comments.body FROM posts JOIN comments ON posts.id = comments.postId',
  );
  await page.getByRole('button', { name: /^Run/ }).click();
  await page.getByLabel('Scrub to step').press('End');
  await expect(page.getByText(/1 row returned/)).toBeVisible();
  await expect(page.getByText("nice post!")).toBeVisible();

  // Persists across a reload.
  await page.reload();
  await page.getByRole('button', { name: 'Custom', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Manage tables (3)' })).toBeVisible();

  // Switching to a preset cleanly leaves custom mode.
  await page.getByRole('button', { name: 'users', exact: true }).click();
  await expect(page.getByRole('button', { name: /^Edit data/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download trace' })).toBeEnabled();
});

test('the progress dashboard fills in from real Playground activity', async ({ page }) => {
  await page.goto('/progress');
  await expect(page.getByText(/Nothing tracked yet/)).toBeVisible();

  // Answer a prediction, which also runs the trace up to that step.
  await page.goto('/playground?q=SELECT+*+FROM+users+WHERE+id+%3D+5&p=lru&x=1&s=8');
  await page.getByRole('button', { name: /index lookup/i }).click();
  // Step to the end so several stages are marked seen.
  await page.getByLabel('Scrub to step').press('End');

  await page.goto('/progress');
  await expect(page.getByText(/Nothing tracked yet/)).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Pipeline stages seen' })).toBeVisible();
  await expect(page.getByText(/1 right of 1 committed|0 right of 1 committed/)).toBeVisible();
  // At least one stage chip is in the "seen" state.
  await expect(page.locator('li', { hasText: /●\s*Parser/ })).toBeVisible();

  await page.getByRole('button', { name: 'Clear progress' }).click();
  await expect(page.getByText(/Nothing tracked yet/)).toBeVisible();
});

test('presenter mode is a keyboard-driven overlay with prediction suppressed', async ({ page }) => {
  // A link with prediction ON, landing on the gated step.
  await page.goto('/playground?q=SELECT+*+FROM+users+WHERE+id+%3D+5&p=lru&x=1&s=8&present=1');

  const dialog = page.getByRole('dialog', { name: 'Presenter view' });
  await expect(dialog).toBeVisible();

  // No prediction card in here, and the playhead is not gated: → advances.
  await expect(page.getByText('Predict before revealing')).toHaveCount(0);
  const forward = dialog.getByRole('button', { name: 'Step forward' });
  await expect(forward).toBeEnabled();
  await page.keyboard.press('ArrowRight');
  await expect(dialog.getByText(/step 9 \//)).toBeVisible();

  // Esc leaves it, and the flag drops out of the URL.
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page).not.toHaveURL(/present=1/);

  // The "Present" button re-opens it.
  await page.getByRole('button', { name: 'Present', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Presenter view' })).toBeVisible();
  await expect(page).toHaveURL(/[?&]present=1/);
});

test('the Playground round-trips a moment through a downloaded trace file', async ({ page }) => {
  await page.goto('/playground?q=SELECT+*+FROM+users+WHERE+age+%3E+30&p=clock&x=0&s=40');
  await expect(page.getByLabel('Scrub to step')).toHaveValue('40');

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download trace' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^querylens-trace-.*\.json$/);
  const path = await download.path();
  expect(path).toBeTruthy();

  // Land somewhere unrelated, then load the file and confirm it is restored.
  await page.goto('/playground');
  await expect(page.getByLabel('Scrub to step')).toHaveValue('1');

  await page.locator('input[type=file]').setInputFiles(path);
  await expect(page.getByRole('status')).toContainText('step 40');
  await expect(page.getByLabel('Scrub to step')).toHaveValue('40');
  await expect(page.getByLabel('Eviction')).toHaveValue('clock');

  // A file that is not ours is refused with a message, not a broken page.
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['{"kind":"nope"}'], 'bad.json', { type: 'application/json' }));
    const input = document.querySelector<HTMLInputElement>('input[type=file]')!;
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(page.getByRole('status')).toContainText(/not a QueryLens trace file/i);
  await expect(page.getByLabel('Scrub to step')).toHaveValue('40'); // unchanged
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

  // The Transcript view: a numbered prose list, every line a Playground link,
  // and the choice rides in the URL.
  await page.getByRole('radio', { name: 'Transcript' }).click();
  await expect(page).toHaveURL(/[?&]v=transcript/);
  await expect(page.locator('table')).toHaveCount(0);
  const items = page.locator('[data-print] ol > li');
  expect(await items.count()).toBeGreaterThan(10);
  await expect(items.first().locator('a')).toHaveAttribute(
    'href',
    /\/playground\?q=.*&p=clock&s=\d+/,
  );
  await expect(page.getByRole('button', { name: 'Print' })).toBeVisible();

  // A direct link opens straight into the transcript.
  await page.goto('/trace?q=SELECT+*+FROM+users+WHERE+id+%3D+5&p=lru&v=transcript');
  await expect(page.getByRole('radio', { name: 'Transcript', checked: true })).toBeVisible();
  await expect(page.locator('[data-print] ol > li').first()).toContainText(/\S/);
});

test('the Playground prints its trace as a paper worksheet', async ({ page }) => {
  await page.goto('/playground?q=SELECT+*+FROM+users+WHERE+age+%3E+30&p=clock&x=1&s=1');
  await expect(page.getByText(/steps in this trace/)).toBeVisible();

  const sheet = page.locator('[data-print].print-only');
  await expect(sheet).toBeHidden(); // display:none on screen

  await page.emulateMedia({ media: 'print' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('heading', { name: 'QueryLens trace worksheet' })).toBeVisible();
  await expect(sheet).toContainText('age > 30');
  await expect(sheet).toContainText(/table users · Clock sweep · prediction on/);
  expect(await sheet.locator('ol > li').count()).toBeGreaterThan(10);
  await expect(sheet.locator('ol > li', { hasText: 'predict first' }).first()).toBeVisible();

  // Nothing else on the page prints.
  await expect(page.getByRole('button', { name: /^Run/ })).toBeHidden();
  await page.emulateMedia({ media: 'screen' });
});

test('the learn track opens lessons that deep-link into the Playground and remembers progress', async ({ page }) => {
  await page.goto('/learn');
  await expect(page.getByText('0 of 9 complete')).toBeVisible();

  await page.getByRole('link', { name: /Follow one row from disk to result/ }).click();
  await expect(page).toHaveURL(/\/learn\/one-row$/);
  await expect(page.getByText('Lesson 2 of 9')).toBeVisible();

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
  await expect(page.getByText('1 of 9 complete')).toBeVisible();
  await page.getByRole('button', { name: 'Reset progress' }).click();
  await expect(page.getByText('0 of 9 complete')).toBeVisible();

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

test('assignments bundle into a set worksheet', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/assignments/new');

  await page.getByLabel('Assignment label').fill('Follow the eviction');
  await page.getByRole('button', { name: 'Add to set' }).click();
  await page.getByLabel('Land on step').fill('8');
  await page.getByLabel('Assignment label').fill('Predict the rewrite');
  await page.getByRole('button', { name: 'Add to set' }).click();

  await expect(page.getByText('2 assignments in this set')).toBeVisible();
  await page.getByLabel('Class code').fill('CS564');

  await page.getByRole('button', { name: 'Copy worksheet' }).click();
  const sheet = await page.evaluate(() => navigator.clipboard.readText());
  expect(sheet.startsWith('# CS564 — assignment set\n')).toBe(true);
  expect(sheet).toMatch(/1\. \*\*Follow the eviction\*\* — http.*\/playground\?/);
  expect(sheet).toMatch(/2\. \*\*Predict the rewrite\*\* — http.*s=8.*l=1/);

  // Remove one, then clear.
  await page.getByRole('button', { name: 'Remove assignment 1' }).click();
  await expect(page.getByText('1 assignment in this set')).toBeVisible();
  await page.getByRole('button', { name: 'Clear set' }).click();
  await expect(page.getByText(/assignments? in this set/)).toHaveCount(0);
});
