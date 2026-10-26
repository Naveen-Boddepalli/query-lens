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

test('the buffer-pool sandbox runs any policy over a reference string typed in', async ({ page }) => {
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

test('the Playground runs a query under any of the eight policies, and the link and a reload keep it', async ({ page }) => {
  await page.goto('/playground?q=SELECT+*+FROM+orders+WHERE+total+%3E+500+ORDER+BY+total&t=orders&x=0');
  const eviction = page.getByLabel('Eviction');
  await expect(eviction.locator('option')).toHaveCount(8);

  await eviction.selectOption('two-q');
  await expect(page).toHaveURL(/p=two-q/);
  // The buffer panel's note is the policy's own.
  await page.getByRole('button', { name: 'Buffer Pool' }).first().click();
  await expect(page.getByText(/keeps a page read only once in a small FIFO/)).toBeVisible();

  // Bélády's optimal needs the future: the query is run once first to record its page reads, and the note says so.
  await eviction.selectOption('optimal');
  await expect(page).toHaveURL(/p=optimal/);
  await expect(page.getByText(/a query is run once first to record the\s+pages it reads/)).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Eviction')).toHaveValue('optimal');
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
  await src.fill('SELECT * FROM users UNION SELECT * FROM users');
  await expect(page.getByText(/`UNION` is not supported yet/)).toBeVisible();
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
  for (const rule of ['statement', 'select', 'join', 'delete', 'insert', 'update', 'aggregateCall', 'qualifiedColumn', 'orExpr', 'predicate', 'operand', 'primary']) {
    await expect(page.locator(`#rule-${rule}`)).toBeAttached();
  }

  // Clicking a rule reference (not the heading of the same name) jumps to that rule's own row.
  await page.locator('#rule-primary a', { hasText: 'qualifiedColumn' }).click();
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

test('the LSM tree sandbox flushes, compacts, and shows write/space/read amplification', async ({ page }) => {
  // 30 writes, a tight memtable (3) and L0 trigger (2) force real compaction cascades down to L3.
  await page.goto('/tools/lsm?n=30&mem=3&trigger=2&base=4&mult=2&seed=1');
  await expect(page.getByRole('heading', { name: 'LSM tree' })).toBeVisible();

  const stat = (label: string) => page.getByText(label, { exact: true }).locator('..');
  await expect(stat('flushes / compactions').getByText('21', { exact: true })).toBeVisible();
  await expect(stat('write amplification').getByText('3.83×', { exact: true })).toBeVisible();
  await expect(stat('read amp., worst case').getByText('1', { exact: true })).toBeVisible();
  await expect(stat('read amp., measured').getByText('0.50×', { exact: true })).toBeVisible();
  await expect(stat('false-positive rate').getByText('0.0%', { exact: true })).toBeVisible();

  // L0, L1 and L2 all drained down to L3 — the deepest, only non-empty level.
  await expect(page.getByText('L0 (flushed from the memtable)')).toBeVisible();
  await expect(page.getByText('empty').first()).toBeVisible();

  // A real hit: key 1's value survived every flush and compaction, and the lookup highlights the table
  // that actually held it.
  await page.getByLabel('Look up a key').fill('1');
  await page.getByRole('button', { name: 'Look up' }).click();
  await expect(page.getByText(/found — value 427/)).toBeVisible();
  await expect(page.getByText('found here')).toBeVisible();

  // A genuine miss: strictly past the highest key ever written, so the Bloom filter correctly says "no"
  // everywhere it is checked.
  await page.getByLabel('Look up a key').fill('71');
  await page.getByRole('button', { name: 'Look up' }).click();
  await expect(page.getByText(/not found, after the Bloom filter still sent 0 false positives/)).toBeVisible();
  await expect(page.getByText('found here')).not.toBeVisible();

  // A roomy memtable and level budget: everything fits, no compaction, and the write-amp drops below 1 —
  // the memtable coalescing an overwrite before it is ever flushed, a real reduction, not a bug.
  await page.getByLabel('Memtable capacity').selectOption('8');
  await page.getByLabel('L0 compaction trigger').selectOption('6');
  await page.getByLabel('L1 capacity').selectOption('32');
  await expect(stat('flushes / compactions').getByText('4', { exact: true })).toBeVisible();
  await expect(stat('write amplification').getByText('0.90×', { exact: true })).toBeVisible();
  await expect(stat('false-positive rate').getByText('11.8%', { exact: true })).toBeVisible();
  await expect.poll(() => page.url()).toMatch(/[?&]mem=8/);

  // A narrower Bloom filter (fewer bits per key) raises the measured false-positive rate; a wider one drops
  // it to zero — the filter's own size/accuracy trade-off, not a fixed property of the structure.
  await page.getByLabel('Bloom bits/key').selectOption('2');
  await expect(stat('false-positive rate').getByText('67.4%', { exact: true })).toBeVisible();
  await expect.poll(() => page.url()).toMatch(/[?&]bits=2/);

  await page.getByLabel('Bloom bits/key').selectOption('20');
  await expect(stat('false-positive rate').getByText('0.0%', { exact: true })).toBeVisible();
  await expect.poll(() => page.url()).toMatch(/[?&]bits=20/);

  // An SSTable is selectable and names what built it.
  const table = page.getByRole('button', { name: /entr(y|ies)/ }).first();
  await table.click();
  await expect(table).toHaveAttribute('aria-pressed', 'true');
  await expect(table.getByText(/flushed from the memtable|compacted from/)).toBeVisible();
});

test('switching the LSM sandbox to tiered compaction trades read amplification for write amplification', async ({ page }) => {
  await page.goto('/tools/lsm?n=30&mem=3&trigger=2&base=4&mult=2&seed=1');
  await expect(page.getByRole('heading', { name: 'LSM tree' })).toBeVisible();

  const stat = (label: string) => page.getByText(label, { exact: true }).locator('..');

  // Leveled (the default): the known baseline from the test above.
  await expect(stat('write amplification').getByText('3.83×', { exact: true })).toBeVisible();
  await expect(stat('read amp., worst case').getByText('1', { exact: true })).toBeVisible();

  // Tiered never re-splits a merge or touches the next level's existing tables — less data rewritten per
  // compaction, so less write amplification for the identical writes, but more tables can now overlap below
  // L0 too, so more read amplification worst-case. Both directions of the same real trade-off, at once.
  await page.getByLabel('Compaction strategy').selectOption('tiered');
  await expect(stat('write amplification').getByText('2.97×', { exact: true })).toBeVisible();
  await expect(stat('read amp., worst case').getByText('2', { exact: true })).toBeVisible();
  await expect.poll(() => page.url()).toMatch(/[?&]strategy=tiered/);

  // The leveled-only controls (re-split level capacity/multiplier) are disabled, not just hidden, and the
  // shared trigger control's label changes to reflect its new, every-level meaning.
  await expect(page.getByLabel('L1 capacity')).toBeDisabled();
  await expect(page.getByLabel('Level size ×')).toBeDisabled();
  await expect(page.getByLabel('Files per tier')).toBeVisible();

  // Any level, not just L0, can now hold overlapping SSTables — clicking one names how many source tables it
  // merged, same as leveled, but every tiered merge creates exactly one new table, never re-split.
  const table = page.getByRole('button', { name: /entr(y|ies)/ }).first();
  await table.click();
  await expect(table.getByText(/compacted from 2 tables/)).toBeVisible();
});

test('the hash-index sandbox grows a directory under extendible hashing and a bucket array under linear hashing', async ({ page }) => {
  await page.goto('/tools/hash-index?n=60&cap=4&init=2&seed=1');
  await expect(page.getByRole('heading', { name: 'Hash index', exact: true })).toBeVisible();

  const stat = (label: string) => page.getByText(label, { exact: true }).locator('..');

  // Extendible (the default): a directory, sized by a global depth.
  await expect(stat('buckets').getByText('10', { exact: true })).toBeVisible();
  await expect(stat('global depth').getByText('4', { exact: true })).toBeVisible();
  await expect(page.getByText(/Directory \(16 slots, global depth 4\)/)).toBeVisible();

  // A real hit and a genuine miss, both through the actual lookup path.
  await page.getByLabel('Look up a key').fill('27');
  await page.getByRole('button', { name: 'Look up' }).click();
  await expect(page.getByText(/found — value 865/)).toBeVisible();
  await page.getByLabel('Look up a key').fill('542');
  await page.getByRole('button', { name: 'Look up' }).click();
  await expect(page.getByText(/Key 542 not found/)).toBeVisible();

  // Ten consecutive keys scatter across several different buckets — the reason this tool exists.
  await expect(page.getByText(/consecutive keys, right after the highest one actually written/)).toBeVisible();

  // Switching to linear hashing: no directory, a bucket array with a split pointer and overflow chains instead.
  await page.getByLabel('Scheme').selectOption('linear');
  await expect(stat('level').getByText('2', { exact: true })).toBeVisible();
  await expect(stat('split pointer').getByText('1', { exact: true })).toBeVisible();
  await expect(stat('max chain length').getByText('2', { exact: true })).toBeVisible();
  await expect(page.getByText(/Buckets \(level 2, split pointer at address 1\)/)).toBeVisible();
  await expect.poll(() => page.url()).toMatch(/[?&]strategy=linear/);

  // Extendible's own "initial buckets" control is irrelevant to it and stays disabled.
  await page.getByLabel('Scheme').selectOption('extendible');
  await expect(page.getByLabel('Initial buckets')).toBeDisabled();
});

test('the columnar sandbox computes real compressed sizes, per-layout page counts, and a materialization gap', async ({ page }) => {
  await page.goto('/tools/columnar?n=500&page=256&layout=DSM&seed=1');
  await expect(page.getByRole('heading', { name: 'Row vs. column storage' })).toBeVisible();

  // Each demo column auto-picks its own genuinely best encoding, with a real compressed byte count.
  const columnRow = (name: string) => page.locator('div.flex.flex-wrap.items-center.gap-3', { hasText: name }).first();
  await expect(columnRow('id').getByText('2000 B → 129 B')).toBeVisible();
  await expect(columnRow('status_grouped').getByText('2000 B → 24 B')).toBeVisible();
  await expect(columnRow('status_shuffled').getByText('2000 B → 125 B')).toBeVisible();
  await expect(columnRow('amount').getByText('2000 B → 1938 B')).toBeVisible();

  // DSM (the default): a single-column scan costs far fewer pages than a full scan, and reconstructing a row
  // means visiting one region per column.
  const dl = page.locator('dl').first();
  await expect(dl.getByText('32', { exact: true })).toBeVisible();
  await expect(dl.getByText('8', { exact: true }).first()).toBeVisible();
  await expect(dl.getByText('4', { exact: true })).toBeVisible();

  // Switching to NSM: no layout can skip a column within a page, so every single-column cost rises to match
  // the full-scan cost, and a row is reconstructed from just one region (the opposite trade-off from DSM).
  await page.getByRole('radio', { name: 'NSM' }).click();
  const nsmValues = await dl.locator('dd').allTextContents();
  expect(new Set(nsmValues.slice(0, 5))).toEqual(new Set(['32'])); // full scan + all 4 single-column costs tie
  await expect(dl.getByText('1', { exact: true })).toBeVisible();
  await expect.poll(() => page.url()).toMatch(/[?&]layout=NSM/);

  // Late materialization touches far fewer bytes than early materialization for the default filter/project pair.
  await expect(page.getByText(/\d+ of 500 rows match/)).toBeVisible();
  await expect(page.getByText('8,000', { exact: true })).toBeVisible();
  await expect(page.getByText('2,412', { exact: true })).toBeVisible();
});

test('latch crabbing: lock coupling blocks threads less than naive latching on the same scripted inserts', async ({ page }) => {
  await page.goto('/tools/latch-crabbing?fanout=4&threads=3&ops=2&seed=1');
  await expect(page.getByRole('heading', { name: 'Latch crabbing', exact: true })).toBeVisible();

  const column = (heading: string) =>
    page.locator('div.flex.flex-col.gap-2', { has: page.getByRole('heading', { name: heading, exact: true }) });
  const stat = (heading: string, label: string) =>
    column(heading).locator('dt', { hasText: label }).locator('xpath=following-sibling::dd[1]');

  // The same six inserts, both protocols. Naive funnels every thread through the root for the whole insert.
  await expect(stat('Naive latching', 'ticks spent blocked')).toHaveText('30');
  await expect(stat('Naive latching', 'ticks to finish')).toHaveText('28');
  await expect(stat('Lock crabbing', 'ticks spent blocked')).toHaveText('20');
  await expect(stat('Lock crabbing', 'ticks to finish')).toHaveText('24');

  // The timeline is the engine's own schedule: switching protocol shows its first action list.
  await page.getByRole('radio', { name: 'Naive timeline' }).click();
  await expect(page.getByRole('cell', { name: 'blocked' }).first()).toBeVisible();
});

test('vector index: brute force, IVF and HNSW, scored by distances computed and recall, on the same seeded points', async ({ page }) => {
  await page.goto('/tools/vector-index?n=200&k=10&seed=1');
  await expect(page.getByRole('heading', { name: 'Vector index', exact: true })).toBeVisible();

  // Brute force is the exact baseline: every point read, every neighbour found.
  const row = (label: RegExp) => page.getByRole('row', { name: label });
  await expect(row(/brute force/)).toContainText('200.0');
  await expect(row(/brute force/)).toContainText('100.0%');

  // IVF reaches full recall after four clusters for 69.3 distances; HNSW after a beam of 10 for 55.3. At this size
  // HNSW is the cheaper route to full recall; at 400 points the order flips (116.6 against IVF's 99.3, from the planner).
  await expect(row(/IVF, probe 4 of 14/)).toContainText('69.3');
  await expect(row(/IVF, probe 4 of 14/)).toContainText('100.0%');
  await expect(row(/HNSW, beam width 10/)).toContainText('55.3');

  // The query's own panel: IVF probing two clusters misses one neighbour; HNSW at beam 16 finds all of them.
  await expect(page.getByText(/IVF, probing 2 clusters/)).toBeVisible();
  await expect(page.getByText('90.0% · 67 distances')).toBeVisible();
  await expect(page.getByText('100.0% · 79 distances')).toBeVisible();

  // The HNSW layers thin out: every point on layer 0, one on the top layer.
  await expect(page.getByText('layer 0', { exact: true })).toBeVisible();
  await expect(page.getByText('200', { exact: true }).first()).toBeVisible();
});

test('LRU-2 is a selectable policy on the buffer-pool sandbox (its scan resistance is covered by unit tests)', async ({ page }) => {
  await page.goto('/tools/buffer-pool');
  await page.getByLabel('Policy').selectOption({ label: 'LRU-2 (scan-resistant)' });
  await expect.poll(() => page.url()).toMatch(/policy=lru-k/);
});

test('the planner sandbox runs the rewrite rules one at a time', async ({ page }) => {
  await page.goto('/tools/planner');
  await expect(page.getByRole('heading', { name: 'Planner sandbox' })).toBeVisible();

  const optimized = page.getByRole('figure').filter({ hasText: 'optimized' });

  // Default: every rule on, index on → the scan becomes a B+Tree lookup.
  // Anchored at `^` so it does not also match `range-index-selection`.
  await expect(optimized.getByText(/IndexScan/).first()).toBeVisible();
  await expect(page.getByText(/^index-selection — /)).toContainText(/indexed/);

  // Drop the index → index-selection has nothing to match; the scan stays sequential.
  await page.getByLabel('id index').uncheck();
  await expect(optimized.getByText(/IndexScan/)).toHaveCount(0);
  await expect(optimized.getByText(/SeqScan/).first()).toBeVisible();
  await expect(page.getByText(/^index-selection — no match/)).toBeVisible();
  await expect.poll(() => page.url()).toMatch(/[?&]idx=0/);

  // Turn predicate-pushdown off (index back on): nothing fires — the two plans match.
  await page.getByLabel('id index').check();
  await page.getByLabel('predicate-pushdown', { exact: true }).uncheck();
  await expect(page.getByText('optimized · unchanged')).toBeVisible();
  await expect(page.getByText(/predicate-pushdown — turned off/)).toBeVisible();
  await expect.poll(() => page.url()).toMatch(
    /rules=constant-folding%2Cjoin-predicate-pushdown%2Cjoin-algorithm-selection%2Cindex-selection%2Crange-index-selection%2Cindex-only-scan/,
  );
});

test('the planner sandbox folds an always-true comparison out of the predicate', async ({ page }) => {
  await page.goto('/tools/planner?q=SELECT%20*%20FROM%20users%20WHERE%201%20%3D%201%20AND%20id%20%3D%205');
  await expect(page.getByText(/constant-folding — Constant folding:/)).toBeVisible();
  await expect(page.getByText(/^index-selection — /)).toContainText(/indexed/);
});

test('the planner sandbox plans a real JOIN against its authors/posts demo tables', async ({ page }) => {
  await page.goto(
    '/tools/planner?q=SELECT%20authors.name%2C%20posts.title%20FROM%20authors%20JOIN%20posts%20ON%20authors.id%20%3D%20posts.authorId',
  );
  const canonical = page.getByRole('figure').filter({ hasText: 'canonical' });
  await expect(canonical.getByText(/Join \(nested-loop\)/)).toBeVisible();
  await expect(canonical.getByText(/SeqScan authors/)).toBeVisible();
  await expect(canonical.getByText(/SeqScan posts/)).toBeVisible();
  // join-algorithm-selection (plan.md §25.4 C5 slice 2) prices every algorithm and picks the cheapest — hash,
  // on this small demo pair — so the optimized tree now differs from the canonical, naive nested-loop one.
  const optimized = page.getByRole('figure').filter({ hasText: 'optimized' });
  await expect(optimized.getByText(/Join \(hash\)/)).toBeVisible();
  await expect(page.getByText(/^join-algorithm-selection — /)).toContainText(/hash join chosen by cost/);

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

  // SELECT DISTINCT rides on the same setting (plan.md §25.4 B2): a HashDistinct streams and writes nothing,
  // a SortDistinct spills through the buffer pool — same rows either way.
  await page.getByLabel('Query').selectOption({ label: 'SELECT DISTINCT a high-cardinality column' });
  await page.getByRole('button', { name: 'Run' }).click();
  await expect(page.getByText(/Same \d+ rows? either way/)).toBeVisible();
  await expect(writes('Hash distinct')).toHaveText('0');
  await expect(writes('Sort distinct')).not.toHaveText('0');

  // A plain SELECT has no aggregate at all — the strategy makes no difference.
  await page.getByLabel('SQL').fill('SELECT * FROM orders');
  await page.getByRole('button', { name: 'Run' }).click();
  await expect(page.getByText(/makes no difference/)).toBeVisible();
});

test('compare builds the same index two ways: bulk-loaded, it is shallower and a lookup reads fewer pages (plan.md §25.4 B3d)', async ({ page }) => {
  await page.goto('/compare');
  await page.getByRole('radio', { name: 'Index build' }).click();
  await expect(page.getByText(/Same \d+ rows? every time/)).toBeVisible();

  const column = (heading: string) =>
    page.locator('div.flex.flex-col.gap-2', { has: page.getByRole('heading', { name: heading, exact: true }) });
  const stat = async (heading: string, label: string) =>
    Number(await column(heading).locator('div.contents', { hasText: label }).locator('dd').innerText());

  const oneAtATime = { levels: await stat('One entry at a time', 'tree height'), pages: await stat('One entry at a time', 'index pages'), reads: await stat('One entry at a time', 'disk reads') };
  const packed = { levels: await stat('Bulk load, 100% full', 'tree height'), pages: await stat('Bulk load, 100% full', 'index pages'), reads: await stat('Bulk load, 100% full', 'disk reads') };
  const half = { levels: await stat('Bulk load, 50% full', 'tree height'), pages: await stat('Bulk load, 50% full', 'index pages') };

  expect(packed.levels).toBeLessThan(oneAtATime.levels);
  expect(packed.pages).toBeLessThan(oneAtATime.pages);
  expect(packed.reads).toBeLessThan(oneAtATime.reads);
  // Leaving room to grow costs pages: half-full leaves make the biggest tree of the three.
  expect(half.pages).toBeGreaterThan(oneAtATime.pages);

  // A query that never touches the index has no tree to compare.
  await page.getByLabel('SQL').fill('SELECT * FROM readings WHERE value = 5');
  await page.getByRole('button', { name: 'Run' }).click();
  await expect(page.getByText(/does not use the index/)).toBeVisible();
});

test('compare forces nested-loop, hash, sort-merge and index nested-loop join onto the same JOIN query', async ({ page }) => {
  await page.goto('/compare');
  await page.getByRole('radio', { name: 'JOIN algorithms' }).click();

  // Same rows out of all four algorithms; the hash join reads far fewer
  // pages than either — the demo purposely runs them under few enough
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

  // The index join is no free lunch: over ten small posts, probing a tree costs more than scanning them once.
  const indexJoin = Number(await diskReads('Index nested-loop join').innerText());
  expect(indexJoin).toBeGreaterThan(hashJoin);

  // One outer row over a big indexed inner is where it earns its keep (plan.md §25.4 B4).
  await page.getByLabel('Query').selectOption({ label: 'A tiny outer over a big indexed inner' });
  await page.getByRole('button', { name: 'Run' }).click();
  await expect(page.getByText(/the index join needed/)).toBeVisible();
  const tinyIndex = Number(await diskReads('Index nested-loop join').innerText());
  expect(tinyIndex).toBeLessThan(Number(await diskReads('Nested-loop join').innerText()));
  expect(tinyIndex).toBeLessThan(Number(await diskReads('Hash join').innerText()));
  expect(tinyIndex).toBeLessThan(Number(await diskReads('Sort-merge join').innerText()));

  // A query with no JOIN at all — the algorithm makes no difference.
  await page.getByLabel('SQL').fill('SELECT * FROM authors');
  await page.getByRole('button', { name: 'Run' }).click();
  await expect(page.getByText(/makes no difference/)).toBeVisible();
});

test('compare counts next() calls per operator, tuple-at-a-time vs. batched, from one real run', async ({ page }) => {
  await page.goto('/compare');
  await page.getByRole('radio', { name: 'Tuple-at-a-time vs. batched' }).click();

  // The default preset: a 3,000-row scan filtered to 296 rows. One SeqScan and one Project, each producing 296 rows,
  // so 592 next() calls tuple-at-a-time, and 2 batches of 256 per operator — 4 calls batched.
  await expect(page.getByText('296 rows out either way')).toBeVisible();
  await expect(page.getByText('592', { exact: true })).toBeVisible();
  await expect(page.getByText('148.0×')).toBeVisible();

  // A join across different-sized tables: the same run, broken down per operator — 10 posts and 120 comments
  // flow through the join, so the operators disagree about how many rows they each produced.
  await page.getByLabel('Query').selectOption({ label: 'A join across tables of different sizes' });
  await page.getByRole('button', { name: 'Run' }).click();
  await expect(page.getByText('120 rows out either way')).toBeVisible();
  await expect(page.getByText('370', { exact: true })).toBeVisible();
  await expect(page.getByText('92.5×')).toBeVisible();

  // Batch size 1 is tuple-at-a-time itself: the two counts must match, and the ratio is exactly 1.
  await page.getByLabel('Batch size', { exact: false }).selectOption('1');
  await expect(page.getByText('1.0×')).toBeVisible();
});

test('compare feeds the identical write sequence to a real B+Tree and an LSM tree, with amplification from real counters', async ({ page }) => {
  await page.goto('/compare');
  await page.getByRole('radio', { name: 'B+Tree vs. LSM tree' }).click();

  const column = (heading: string) =>
    page.locator('div.flex.flex-col.gap-2', { has: page.getByRole('heading', { name: heading, exact: true }) });
  const stat = (heading: string, label: string) =>
    column(heading).locator('div.contents', { hasText: label }).locator('dd');

  // The default 150 writes: the B+Tree's own measured numbers.
  await expect(stat('B+Tree', 'tree height')).toHaveText('4');
  await expect(stat('B+Tree', 'index pages')).toHaveText('37');
  await expect(stat('B+Tree', 'write amplification')).toHaveText('1.44×');
  await expect(stat('B+Tree', 'point-lookup cost')).toHaveText('4');

  // The LSM tree (leveled), same 150 writes — a real, measured counter-per-counter contrast, not a guess.
  await expect(stat('LSM tree (leveled)', 'levels')).toHaveText('6');
  await expect(stat('LSM tree (leveled)', 'write amplification')).toHaveText('6.21×');
  await expect(stat('LSM tree (leveled)', 'read amp., worst case')).toHaveText('3');

  // The B+Tree's own write cost stays low and roughly constant; the LSM tree's own write cost is genuinely
  // higher at the same data size — the real, measured point of this comparison, not asserted from the text.
  const btreeWriteAmp = Number((await stat('B+Tree', 'write amplification').innerText()).replace('×', ''));
  const lsmWriteAmp = Number((await stat('LSM tree (leveled)', 'write amplification').innerText()).replace('×', ''));
  expect(lsmWriteAmp).toBeGreaterThan(btreeWriteAmp);

  // Fewer writes: both structures shrink, but the gap (and the trade-off's direction) still holds.
  await page.getByLabel('Writes').fill('60');
  await expect(stat('B+Tree', 'write amplification')).toHaveText('1.33×');
  await expect(stat('LSM tree (leveled)', 'write amplification')).toHaveText('3.87×');

  // The LSM tree's own tool page is one click away, for the full sandbox.
  await expect(page.getByRole('link', { name: 'an LSM tree' })).toHaveAttribute('href', '/tools/lsm');
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

test('a range predicate on the indexed column becomes an IndexRangeScan and walks the leaf chain (plan.md §23.1)', async ({
  page,
}) => {
  await page.goto('/playground?q=SELECT+*+FROM+users+WHERE+id+%3E+43&p=lru&x=0&s=9999');
  // 5 of the 48 seed rows have id > 43 — narrow enough that the index actually costs less than the scan
  // (plan.md §25.4 C5); id > 40 (17%) no longer does.
  await expect(page.getByText('5 rows returned', { exact: false })).toBeVisible();

  await page.getByRole('button', { name: 'Optimizer' }).click();
  await expect(page.getByText('IndexRangeScan', { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/range-index-selection/)).toBeVisible();

  await page.getByRole('button', { name: 'Index', exact: true }).click();
  // The leaf-chaining narration, and the breadcrumb it leaves behind — the
  // point of the feature: more than one leaf visited, joined by a sibling
  // hop, not a fresh descent from the root each time.
  await expect(page.getByLabel('Scrub to step')).toBeVisible();
  await page.getByLabel('Scrub to step').fill('1');
  await expect(page.getByText(/sibling pointer/)).not.toBeVisible();
  let hopSeen = false;
  for (let step = 1; step <= 60; step++) {
    await page.getByLabel('Scrub to step').fill(String(step));
    if (await page.getByText(/sibling pointer/).isVisible()) {
      hopSeen = true;
      break;
    }
  }
  expect(hopSeen).toBe(true);
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

test('trace diff: re-running a query reports what changed since its last run, including the rows a write added', async ({ page }) => {
  await page.goto('/playground');
  const editor = page.locator('.cm-content');
  const diff = page.getByRole('region', { name: 'Since your last run' });

  // The first run of a query has nothing to compare against, so no note appears.
  await editor.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('SELECT * FROM users;');
  await page.getByRole('button', { name: 'Run' }).click();
  await expect(diff).toHaveCount(0);

  // The same query again, with nothing in between: the note says so.
  await page.getByRole('button', { name: 'Run' }).click();
  await expect(diff.getByText('Nothing measurable has changed')).toBeVisible();

  // A write changes the table; the next run of the SELECT reports the row it now returns.
  await editor.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type("INSERT INTO users (id, name, email, age) VALUES (999, 'zeta', 'zeta@example.com', 50);");
  await page.getByRole('button', { name: 'Run' }).click();
  await editor.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('SELECT * FROM users;');
  await page.getByRole('button', { name: 'Run' }).click();
  await expect(diff.getByText('rows returned:')).toBeVisible();
  await expect(diff.getByText('48 → 49')).toBeVisible();
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

test('an index on a column that repeats returns every matching row, one entry each (plan.md §25.4 B3)', async ({ page }) => {
  // A custom `posts`, indexed on `authorId`, which repeats: ten authors, one with three posts, the rest with
  // four — big enough that the honest cost gate (plan.md §25.4 C5) actually favors the index; the shared starter
  // database's four-author, ten-post `posts` (30% selectivity) never did.
  await page.addInitScript(() => {
    const authorIds: number[] = [];
    for (let author = 1; author <= 10; author++) {
      for (let k = 0; k < (author === 1 ? 3 : 4); k++) authorIds.push(author);
    }
    const rows = authorIds.map((authorId, i) => ({ id: i + 1, authorId, title: `author ${String(authorId)}'s post ${String(i + 1)}` }));
    localStorage.setItem(
      'querylens.customDatabase.v1',
      JSON.stringify({ tables: { posts: { name: 'posts', columns: ['id', 'authorId', 'title'], rows, indexes: [{ columns: ['authorId'] }] } } }),
    );
  });
  // Predictions off, so stepping is not gated on answering one.
  await page.goto('/playground?x=0');
  await page.getByRole('button', { name: 'Custom', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Manage tables (1)' })).toBeVisible();

  const editor = page.locator('.cm-content');
  await editor.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('SELECT * FROM posts WHERE authorId = 1;');
  await page.getByRole('button', { name: /^Run/ }).click();
  await page.getByLabel('Scrub to step').press('End');

  // All three of author 1's posts — not the one an overwriting unique index would have kept.
  await expect(page.getByText(/3 rows returned/)).toBeVisible();

  // The lookup says why: three entries for one value, and an IndexScan that returns them one by one.
  await page.getByLabel('Scrub to step').press('Home');
  let sawRepeat = false;
  for (let i = 0; i < 60 && !sawRepeat; i++) {
    await page.getByRole('button', { name: 'Step forward' }).click();
    sawRepeat = (await page.getByText(/2 more entries for the same value follow it/).count()) > 0;
  }
  expect(sawRepeat).toBe(true);
});

test('a composite index is entered by its leftmost column and declined without it (plan.md §25.4 B3b)', async ({ page }) => {
  // A custom database with one table indexed on (city, age): 72 people, eight cities — enough that the honest
  // cost gate (plan.md §25.4 C5) actually favors the composite index; three cities (33% selectivity each) never did.
  await page.addInitScript(() => {
    const cities = ['oslo', 'rome', 'kyiv', 'lima', 'cairo', 'accra', 'seoul', 'dhaka'];
    const rows = Array.from({ length: 72 }, (_, i) => ({ id: i + 1, city: cities[i % 8], age: 20 + (i % 9) }));
    localStorage.setItem(
      'querylens.customDatabase.v1',
      JSON.stringify({ tables: { people: { name: 'people', columns: ['id', 'city', 'age'], rows, indexes: [{ columns: ['city', 'age'] }] } } }),
    );
  });
  await page.goto('/playground?x=0');
  await page.getByRole('button', { name: 'Custom', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Manage tables (1)' })).toBeVisible();

  async function narrationContains(sql: string, text: RegExp): Promise<boolean> {
    const editor = page.locator('.cm-content');
    await editor.click();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.type(sql);
    await page.getByRole('button', { name: /^Run/ }).click();
    await page.getByLabel('Scrub to step').press('Home');
    for (let i = 0; i < 40; i++) {
      if ((await page.getByText(text).count()) > 0) return true;
      await page.getByRole('button', { name: 'Step forward' }).click();
    }
    return (await page.getByText(text).count()) > 0;
  }

  // The leading column alone is enough to enter the index…
  expect(await narrationContains("SELECT * FROM people WHERE city = 'oslo'", /leftmost column of the composite index \(city, age\)/)).toBe(true);
  await page.getByLabel('Scrub to step').press('End');
  await expect(page.getByText(/9 rows returned/)).toBeVisible();

  // A range on the next column narrows *within* that city's run.
  expect(await narrationContains("SELECT * FROM people WHERE city = 'oslo' AND age > 25", /narrows it within that run/)).toBe(true);
  await page.getByLabel('Scrub to step').press('End');
  await expect(page.getByText(/3 rows returned/)).toBeVisible();

  // …but the second column alone cannot: the plan says why, and the rows still come back.
  expect(await narrationContains('SELECT * FROM people WHERE age = 22', /The index on \(city, age\) cannot help/)).toBe(true);
  await page.getByLabel('Scrub to step').press('End');
  await expect(page.getByText(/8 rows returned/)).toBeVisible();
});

test('a UNIQUE index rejects a repeated key, with the lookup that found it (plan.md §25.4 B3c)', async ({ page }) => {
  await page.addInitScript(() => {
    const rows = [
      { id: 1, email: 'ada@x.org' },
      { id: 2, email: 'alan@x.org' },
      { id: 3, email: null },
    ];
    localStorage.setItem(
      'querylens.customDatabase.v1',
      JSON.stringify({ tables: { accounts: { name: 'accounts', columns: ['id', 'email'], rows, indexes: [{ columns: ['email'], unique: true }] } } }),
    );
  });
  await page.goto('/playground?x=0');
  await page.getByRole('button', { name: 'Custom', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Manage tables (1)' })).toBeVisible();

  const editor = page.locator('.cm-content');
  await editor.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type("INSERT INTO accounts (id, email) VALUES (4, 'ada@x.org');");
  await page.getByRole('button', { name: /^Run/ }).click();

  // The trace is kept: it shows the check that found the duplicate, and the page says the statement was rejected.
  await expect(page.getByText(/Rejected after \d+ steps/)).toBeVisible();
  await expect(page.getByText(/Duplicate key — the UNIQUE index on/).first()).toBeVisible();
  await page.getByLabel('Scrub to step').press('End');
  await expect(page.getByText(/INSERT is rejected/)).toBeVisible();

  // A free key goes in, and the table grows; a NULL is never a conflict.
  await editor.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type("INSERT INTO accounts (id, email) VALUES (4, NULL);");
  await page.getByRole('button', { name: /^Run/ }).click();
  await page.getByLabel('Scrub to step').press('End');
  await expect(page.getByText(/1 row inserted/)).toBeVisible();
});

test('ANALYZE builds real statistics, shown in the Result panel, and a later query reads them (plan.md §25.4 C1)', async ({ page }) => {
  await page.goto('/playground?x=0');
  const editor = page.locator('.cm-content');

  await editor.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('ANALYZE users');
  await page.getByRole('button', { name: /^Run/ }).click();
  await page.getByLabel('Scrub to step').press('End');

  // The result *is* the statistics — the same Result panel any other query's answer would be.
  await expect(page.getByText(/scanned all 48 rows of `users`/)).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'N_DISTINCT' })).toBeVisible();
  await expect(page.getByRole('cell', { name: /\d+ \(2\)/ }).first()).toBeVisible(); // a most-common value with its real count

  // A later query against the same table reads what ANALYZE left behind.
  await editor.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('SELECT * FROM users WHERE age = 34');
  await page.getByRole('button', { name: /^Run/ }).click();
  await page.getByLabel('Scrub to step').press('End');
  await expect(page.getByText(/most common value, ANALYZE/)).toBeVisible();
});

test('the correlated dataset names a real q-error, at least 10× (plan.md §25.4 C2)', async ({ page }) => {
  await page.goto('/playground?x=0');
  await page.getByRole('button', { name: 'employees', exact: true }).click();
  await page.getByRole('button', { name: 'Correlated AND' }).click();
  await page.getByRole('button', { name: /^Run/ }).click();
  await page.getByLabel('Scrub to step').press('End');

  // department alone already tells you the office — an AND of both is no narrower, but the optimizer's
  // independence assumption multiplies their fractions as if it were, badly underestimating.
  const line = page.getByText(/SeqScan employees.*q-error/);
  await expect(line).toBeVisible();
  const text = (await line.textContent())!;
  const q = Number(/q-error (\d+(?:\.\d+)?)×/.exec(text)?.[1]);
  expect(q).toBeGreaterThanOrEqual(10);
});

test('every link on the course map and the interview roadmap goes somewhere real (plan.md §25.4 G1)', async ({ page }) => {
  const targets = new Set<string>();
  for (const [path, marker] of [
    ['/docs/study/course-map', /Not affiliated with any course or university/],
    ['/docs/study/interview-roadmap', /Week 6/],
  ] as const) {
    await page.goto(path);
    await expect(page.getByText(marker).first()).toBeVisible();
    // The page's own links: everything but the header, the docs sidebar and the footer.
    const hrefs = await page.locator('a[href^="/"]').evaluateAll((links) =>
      links
        .filter((a) => !a.closest('nav, header, footer, aside'))
        .map((a) => (a as HTMLAnchorElement).getAttribute('href') ?? ''),
    );
    expect(hrefs.length, `${path} has links`).toBeGreaterThan(10);
    for (const href of hrefs) if (!href.startsWith('/docs/study/')) targets.add(href.split('#')[0]);
  }
  for (const href of targets) {
    const response = await page.goto(href);
    expect(response?.status(), `${href} status`).toBeLessThan(400);
    // The app's own not-found page says so; every real route renders something else.
    await expect(page.getByText(/simplified educational model/).first(), `${href}: app shell missing`).toBeVisible();
    await expect(page.locator('body'), `${href} is the not-found page`).not.toContainText(/This node has no child pointer/);
  }
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

test('the B+Tree concept page embeds a real, searchable tree (plan.md §23.1)', async ({ page }) => {
  await page.goto('/docs/concepts/btree');

  // Scoped to the widget's own wrapper — the page's own "Try this" prose
  // also contains the words "✓ found", further down the page.
  const demo = page.locator('div.not-prose').filter({ has: page.getByLabel('Key to search for') });

  // Loads with a default search already run.
  await expect(demo.getByText(/✓ found/)).toBeVisible();

  await page.getByLabel('Key to search for').fill('9999');
  await page.getByRole('button', { name: 'Find' }).click();
  await expect(demo.getByText(/✗ not found/)).toBeVisible();

  await page.getByLabel('Key to search for').fill('5');
  await page.getByRole('button', { name: 'Find' }).click();
  await expect(demo.getByText(/✓ found/)).toBeVisible();
});

test('the buffer pool concept page embeds a live, steppable pool with an LRU/clock toggle (plan.md §23.1)', async ({
  page,
}) => {
  await page.goto('/docs/concepts/buffer-pool');

  await expect(page.getByText('0 / 16')).toBeVisible();
  await expect(page.getByRole('button', { name: 'LRU' })).toHaveAttribute('aria-pressed', 'true');

  await page.getByLabel('Scrub to step').fill('16');
  await expect(page.getByText('page 0').first()).toBeVisible();

  await page.getByRole('button', { name: 'Clock sweep' }).click();
  await expect(page.getByRole('button', { name: 'Clock sweep' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('0 / 21')).toBeVisible();
  await page.getByLabel('Scrub to step').fill('21');
  await expect(page.getByText('page 0').first()).toBeVisible();
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

test('a tour taken from the first-visit hint opens once, and not again on the next visit to the Playground', async ({ page }) => {
  await page.goto('/playground');
  // The Playground is mounted and listening, so the request reaches it live rather than through the one-shot flag.
  await expect(page.getByLabel('SQL query')).toBeVisible();
  await page.getByRole('button', { name: 'Take the 60-second tour' }).click();
  const tour = page.getByRole('dialog', { name: 'Playground tour' });
  await expect(tour).toBeVisible();
  await tour.getByRole('button', { name: 'Skip tour' }).click();
  await expect(tour).toHaveCount(0);

  // Away and back within the app — the same tab, so the same sessionStorage — and then a reload. The request was
  // answered, so nothing may be left waiting to open the tour again.
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  await nav.getByRole('link', { name: 'Tools' }).click();
  await expect(page).toHaveURL(/\/tools$/);
  await nav.getByRole('link', { name: 'Playground' }).click();
  await expect(page.getByLabel('SQL query')).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Playground tour' })).toHaveCount(0);
  await page.reload();
  await expect(page.getByLabel('SQL query')).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Playground tour' })).toHaveCount(0);
});

test('the tour spotlight lands on its target after the page scrolls to it', async ({ page }) => {
  // A phone-sized viewport is where the page itself scrolls: the trace comes
  // first and the editor sits a screen below it. The page sets
  // `scroll-behavior: smooth`, which used to leave the spotlight at the
  // target's pre-scroll position while the page scrolled out from under it.
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto('/playground?tour=1');

  const tour = page.getByRole('dialog', { name: 'Playground tour' });
  await expect(tour).toBeVisible();

  for (const target of ['editor', 'pipeline', 'panel', 'narration', 'playback']) {
    const spotlight = tour.locator(`[data-tour-spotlight="${target}"]`);
    const framed = page.locator(`[data-tour="${target}"]`);
    await expect(spotlight).toBeVisible();

    // The spotlight is the target's box plus 6px of margin on every side. Poll,
    // because it glides to its new place over a short transition.
    await expect
      .poll(async () => {
        const [s, t] = await Promise.all([spotlight.boundingBox(), framed.boundingBox()]);
        if (!s || !t) return Infinity;
        return Math.max(
          Math.abs(s.x - (t.x - 6)),
          Math.abs(s.y - (t.y - 6)),
          Math.abs(s.width - (t.width + 12)),
          Math.abs(s.height - (t.height + 12)),
        );
      })
      .toBeLessThanOrEqual(1);

    // …and what it frames is actually on screen.
    await expect(framed).toBeInViewport();

    if (target !== 'playback') await tour.getByRole('button', { name: 'Next' }).click();
  }
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

test('the customers preset has NULLs: IS NULL finds five, = NULL none, and NOT IN meets a NULL (plan.md §26 Feature 3)', async ({ page }) => {
  await page.goto('/playground');
  await page.getByRole('button', { name: 'customers', exact: true }).click();
  await expect(page.getByLabel('SQL query')).toContainText('city IS NULL');
  await expect(page.getByText(/20 rows, some with no city/)).toBeVisible();
  await expect.poll(() => page.url()).toContain('t=customers');

  const result = async (preset: string, rows: string) => {
    await page.getByRole('button', { name: preset }).click();
    await page.getByLabel('Scrub to step').press('End');
    await expect(page.getByText(rows).first()).toBeVisible();
  };
  await result('IS NULL', '5 rows returned');
  await result('= NULL finds nothing', '0 rows returned');
  await result('NOT IN meets a NULL', '0 rows returned');
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
  await expect(page.getByText(/^0 of \d+ solved$/)).toBeVisible();
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
  await expect(page.getByText(/^1 of \d+ solved$/)).toBeVisible();
  await page.getByRole('button', { name: 'Reset progress' }).click();
  await expect(page.getByText(/^0 of \d+ solved$/)).toBeVisible();
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

test('a challenge with its own database reruns the query under a second algorithm to check it (plan.md §23.2)', async ({
  page,
}) => {
  await page.goto('/challenges/hash-beats-loop');
  await expect(page.getByText(/runs against its own.*authors.*posts.*pair/)).toBeVisible();

  // The starter has no JOIN at all — nested-loop and hash cost the same.
  await page.getByRole('button', { name: 'Run & check' }).click();
  await expect(page.getByText(/Not there yet/)).toBeVisible();

  const editor = page.locator('.cm-content');
  await editor.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('SELECT * FROM authors JOIN posts ON authors.id = posts.authorId;');
  await page.getByRole('button', { name: 'Run & check' }).click();
  await expect(page.getByText('✓ Solved.')).toBeVisible();

  // No "step through" link — the Playground's own dataset URL scheme has no
  // way to name this one-off JOIN demo.
  await expect(page.getByRole('link', { name: /Step through this run in the Playground/ })).toHaveCount(0);
});

test('a misconception challenge reveals the belief it checks once it is solved (plan.md §G3)', async ({ page }) => {
  await page.goto('/challenges/equals-null');
  await expect(page.getByText(/The contacts table has one row whose/)).toBeVisible();

  // The starter compares with = NULL, which is never true — it does not pass, and the belief is not shown yet.
  await page.getByRole('button', { name: 'Run & check' }).click();
  await expect(page.getByText(/Not there yet/)).toBeVisible();
  await expect(page.getByText('The belief this checks:')).toHaveCount(0);

  const editor = page.locator('.cm-content');
  await editor.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('SELECT * FROM contacts WHERE email IS NULL;');
  await page.getByRole('button', { name: 'Run & check' }).click();
  await expect(page.getByText('✓ Solved.')).toBeVisible();
  await expect(page.getByText('The belief this checks:')).toBeVisible();
  await expect(page.getByText(/x = NULL/)).toBeVisible();
});

test('the range-leap challenge is solved by an IndexRangeScan (plan.md §23.1/§23.2)', async ({ page }) => {
  await page.goto('/challenges/range-leap');

  // The starter filters on the unindexed `age` column — a full scan.
  await page.getByRole('button', { name: 'Run & check' }).click();
  await expect(page.getByText(/Not there yet/)).toBeVisible();
  await expect(page.getByText('range scan')).toBeVisible();

  const editor = page.locator('.cm-content');
  await editor.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('SELECT * FROM users WHERE id > 44;');
  await page.getByRole('button', { name: 'Run & check' }).click();
  await expect(page.getByText('✓ Solved.')).toBeVisible();
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
  await expect(page.getByText(/^0 of \d+ complete$/)).toBeVisible();

  await page.getByRole('link', { name: /Follow one row from disk to result/ }).click();
  await expect(page).toHaveURL(/\/learn\/one-row$/);
  await expect(page.getByText(/Lesson 2 of \d+/)).toBeVisible();

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
  await expect(page.getByText(/^1 of \d+ complete$/)).toBeVisible();
  await page.getByRole('button', { name: 'Reset progress' }).click();
  await expect(page.getByText(/^0 of \d+ complete$/)).toBeVisible();

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

/**
 * plan.md §25.4 A3. QueryLens has no telemetry (§14.4), so "which step confused
 * you" is only ever a message a reader chooses to send. The link is a prefilled
 * GitHub issue *form* — never a request the page makes itself.
 */
test('"Report a confusing step" prefills an issue form with this exact moment, and follows the playhead', async ({ page }) => {
  await page.goto('/playground?q=SELECT%20*%20FROM%20users%20WHERE%20id%20%3D%205&p=clock&x=0&s=7');
  const link = page.getByRole('link', { name: /Report a confusing step/ });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', /noreferrer/);

  const read = async () => {
    const url = new URL((await link.getAttribute('href'))!);
    return { template: url.searchParams.get('template'), moment: url.searchParams.get('moment') ?? '' };
  };

  const before = await read();
  expect(before.template).toBe('confusing_step.yml');
  expect(before.moment).toContain('step 7 of 33');
  expect(before.moment).toContain('SELECT * FROM users WHERE id = 5');
  // The link that reopens the moment names the same step, and points at this app.
  expect(before.moment).toMatch(/Reopen this moment:\*\* http:\/\/localhost:\d+\/playground\?.*s=7/);

  await page.getByRole('button', { name: 'Step forward' }).click();
  await expect.poll(async () => (await read()).moment).toContain('step 8 of 33');
});

/**
 * plan.md §25.4 B5 — the plan as relational algebra. The plan tree says *how* the
 * engine runs a query; the algebra says *what* it computes.
 */
test('the plan can be read as relational algebra, and copied as a σ π ⋈ γ expression or LaTeX', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/playground?q=SELECT%20name%20FROM%20users%20WHERE%20age%20%3E%2030%20ORDER%20BY%20age%20LIMIT%203&x=0&s=8');
  await page.getByRole('button', { name: /^Planner/ }).click();

  const group = page.getByRole('group', { name: 'Plan notation' });
  await expect(group.getByRole('button', { name: 'Operators' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.react-flow__node').getByText('Filter', { exact: true }).first()).toBeVisible();

  await group.getByRole('button', { name: 'Relational algebra' }).click();
  await expect(group.getByRole('button', { name: 'Relational algebra' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.react-flow__node').getByText('σ age > 30')).toBeVisible();
  // The physical operator is still there, beneath: what beside how.
  await expect(page.locator('.react-flow__node').getByText('SeqScan users').first()).toBeVisible();

  // Step on to the point where the whole plan is built, then copy it.
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.getByRole('button', { name: 'Copy as relational algebra' }).click();
  const text = await page.evaluate(() => navigator.clipboard.readText());
  expect(text).toContain('σ_{age > 30}(users)');
  expect(text).toMatch(/^[πτλδ]|^π/);

  await page.getByRole('button', { name: 'Copy as LaTeX' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('\\sigma_{age > 30}');
});

/**
 * plan.md §25.4 B6 — EXPLAIN [ANALYZE] as SQL: the keyword works in the editor,
 * and its answer is a result you can read like any other.
 */
test('EXPLAIN ANALYZE is a statement: a QUERY PLAN with estimate beside actual, and EXPLAIN alone reads nothing', async ({ page }) => {
  // The chip fills the editor; the trace runs to its end, where the plan is the result.
  await page.goto('/playground');
  await page.getByRole('button', { name: 'EXPLAIN ANALYZE' }).click();
  await expect(page.locator('.cm-content')).toContainText('EXPLAIN ANALYZE');

  await page.goto('/playground?q=EXPLAIN%20ANALYZE%20SELECT%20*%20FROM%20users%20WHERE%20age%20%3E%2030&x=0&s=9999');
  await expect(page.getByRole('columnheader', { name: 'QUERY PLAN' })).toBeVisible();
  await expect(page.getByRole('cell', { name: /SeqScan users .*est ~\d+ rows; actual \d+ rows/ })).toBeVisible();
  await expect(page.getByRole('cell', { name: /^Buffer pool: \d+ hits?, \d+ miss(es)?, \d+ evictions?$/ })).toBeVisible();

  // Plain EXPLAIN never touches a page: its trace has no buffer or execute stage to step through.
  await page.goto('/playground?q=EXPLAIN%20SELECT%20*%20FROM%20users%20WHERE%20id%20%3D%205&x=0&s=9999');
  await expect(page.getByRole('cell', { name: /IndexScan users\.id/ })).toBeVisible();
  await expect(page.getByRole('cell', { name: /actual/ })).toHaveCount(0);
});

test('a confidence rating is taken before the commit and shown as a calibration bar (plan.md §G2)', async ({ page }) => {
  await page.goto('/playground?q=SELECT+*+FROM+users+WHERE+id+%3D+5&p=lru&x=1&s=8');
  await page.getByRole('group', { name: 'How sure are you?' }).getByRole('button', { name: 'Certain' }).click();
  await page.getByRole('button', { name: /index lookup/i }).click();
  await expect(page.getByText('You were certain.')).toBeVisible();

  await page.goto('/progress');
  await expect(page.getByRole('heading', { name: 'Calibration' })).toBeVisible();
  await expect(page.locator('li', { hasText: 'Certain' }).filter({ hasText: /of 1 right/ })).toBeVisible();
  await expect(page.locator('li', { hasText: 'Guessing' }).filter({ hasText: 'none yet' })).toBeVisible();
});
