/**
 * Volcano-style execution: every operator exposes `open` / `next` / `close`,
 * and rows are *pulled* from the root downward. One `next()` is one natural
 * visualization tick (plan.md §7.4).
 *
 * Operators emit through a trace buffer — the `emit` callback threaded down in
 * the context — rather than returning events, so the shape of the operator
 * tree is unaffected by the fact that it is being watched.
 */

import type { Emit } from '../trace.ts';
import type { EngineOptions, Row, SqlValue, Table } from '../types.ts';
import type { Expr } from '../parser/index.ts';
import { lookupKeysOf } from '../planner/index.ts';
import type { AggregateSpec, Plan, ProjectList, RangeBound } from '../planner/index.ts';
import type { BufferPool, Heap, ScanRing } from '../storage/index.ts';
import { scanUsesRing } from '../storage/index.ts';
import type { LockManager } from '../locks/index.ts';
import type { BPlusTree, RowPointer } from '../index/index.ts';
import { columnsOfIndex, emitIndexLookup, emitRangeStart, nextInRange, pageCountFor, resolveClustered } from '../index/index.ts';
import { compare, equalityKeyOf, evaluateValue, passes } from './evaluate.ts';
import { externalMergeSort } from './sort.ts';

export interface Operator {
  readonly name: string;
  open: () => void;
  next: () => Row | null;
  close: () => void;
}

export interface ExecContext {
  emit: Emit;
  pool: BufferPool;
  locks: LockManager;
  /** The `FROM` table — or a `Join`'s left side, when the plan has one. */
  heap: Heap;
  /** Every index this table declares, keyed by column — empty if it has none. */
  trees: Record<string, BPlusTree>;
  table: Table;
  options: EngineOptions;
  /**
   * Every table a `Join` in this query's chain introduces (plan.md §22.2, plural since §25.4 C3 slice b), keyed by
   * table name — each one's own heap, page ids numbered right after whatever came before, so all of them share the
   * one real buffer pool. `trees` is empty unless that table's own join step runs `index-nested-loop` (plan.md
   * §25.4 B4); no algorithm ever consults any other index a joined table might have. A `Join` node looks up its own
   * `rightTable` here to find its partner — `undefined` for every query without a `JOIN` at all, which is every
   * operator here except the four join operators themselves.
   */
  joinPartners?: Record<string, { table: Table; heap: Heap; trees: Record<string, BPlusTree> }>;
  /**
   * Each `sort-merge` `Join` in the chain's own two spill-block page ids (plan.md §25.4 C3 slice b), keyed by that
   * `Join`'s own plan node identity — `runQuery.ts` computes these up front, in chain order, since a later join's
   * own worst-case row count depends on every earlier one's. `undefined` unless the plan has at least one.
   */
  sortMergeBases?: Map<Plan, { leftBase: number; rightBase: number }>;
  /**
   * First page id of each sort's own spill block — a `SortAggregate`'s, ORDER BY's `Sort`'s (plan.md §26 Feature 1)
   * and a `SortDistinct`'s (plan.md §25.4 B2) — laid out one after another past every heap, index and sort-merge
   * block, so two sorts never share scratch pages. Set by `runQuery.ts`, which sized the buffer pool for them.
   */
  aggregateSortBase?: number;
  sortBase?: number;
  distinctBase?: number;
}

/**
 * Counts rows an operator has produced, so `execute` events stay cumulative. `table` disambiguates this specific
 * node from another one with the same `name` elsewhere in the plan — a multi-join chain's several `SeqScan`s or
 * `Join`s — so EXPLAIN ANALYZE's actual-row lookup (`explain.ts`) does not mix up two nodes that share an `op`;
 * see `StepEventBody`'s own doc comment. Omitted for operators that can only appear once per query.
 */
function counter(ctx: ExecContext, name: string, table?: string) {
  let produced = 0;
  return (label: string) => {
    produced += 1;
    ctx.emit(label, { stage: 'execute', op: name, rowsProduced: produced, ...(table === undefined ? {} : { table }) });
  };
}

/* -------------------------------------------------------------------------- */

function seqScan(plan: Extract<Plan, { op: 'SeqScan' }>, ctx: ExecContext): Operator {
  let pageIndex = 0;
  let rowIndex = 0;
  let pinnedFrame: number | null = null;
  let lockedPage: number | null = null;
  let skipped = 0;
  // The scan's own claim on the pool (plan.md §25.4 F7). Made on the first `open` and kept across a nested-loop join's
  // rescans, as PostgreSQL keeps its strategy across a rescan, so every pass reuses the same few frames.
  let ring: ScanRing | undefined;
  const lastHeapPage = ctx.heap.pages[ctx.heap.pages.length - 1]?.pageId ?? -1;
  const produced = counter(ctx, 'SeqScan', plan.table);

  function releasePage(): void {
    if (pinnedFrame !== null) {
      ctx.pool.unpin(pinnedFrame);
      pinnedFrame = null;
    }
    if (lockedPage !== null) {
      ctx.locks.release(lockedPage, 'shared');
      lockedPage = null;
    }
  }

  return {
    name: 'SeqScan',
    open() {
      pageIndex = 0;
      rowIndex = 0;
      if (ring === undefined && scanUsesRing(ctx.heap.pages.length, ctx.options)) {
        ring = ctx.pool.beginScan(ctx.options.scanRing ?? 0);
      }
    },
    next() {
      for (;;) {
        const page = ctx.heap.pages[pageIndex];
        if (!page) {
          releasePage();
          return null;
        }

        if (rowIndex === 0) {
          releasePage();
          ctx.locks.acquire(
            page.pageId,
            'shared',
            `Take a shared lock on page ${String(page.pageId)} before reading its rows.`,
          );
          lockedPage = page.pageId;
          // The heap's pages end where this table's last page does: that is the scan's extent for read-ahead.
          const fetched = ctx.pool.fetch(page.pageId, ring, lastHeapPage + 1);
          if (!fetched) return null;
          // Held while its rows are read; released when we move on. Only an
          // unpinned frame can be evicted.
          pinnedFrame = fetched.frameId;
        }

        const row = page.rows[rowIndex];
        if (!row) {
          pageIndex += 1;
          rowIndex = 0;
          continue;
        }
        rowIndex += 1;

        if (!passes(plan.filter, row)) {
          skipped += 1;
          continue;
        }

        produced(
          `SeqScan returns a row from page ${page.pageId}${
            skipped > 0 ? ` (${skipped} row${skipped === 1 ? '' : 's'} rejected so far)` : ''
          }.`,
        );
        return row;
      }
    },
    close() {
      releasePage();
      if (ring) {
        ctx.pool.endScan(ring);
        ring = undefined;
      }
    },
  };
}

/**
 * Follows one index entry to its row's heap page: a shared lock, a pool fetch, a release — the real price of an
 * index scan, paid once per match. Exported for the write paths, which read every page they may modify.
 */
export function fetchHeapPage(ctx: ExecContext, pointer: RowPointer): void {
  ctx.locks.acquire(
    pointer.pageId,
    'shared',
    `Lock heap page ${String(pointer.pageId)}, where the matching row lives.`,
  );
  const fetched = ctx.pool.fetch(pointer.pageId);
  if (fetched) ctx.pool.unpin(fetched.frameId);
  ctx.locks.release(pointer.pageId, 'shared');
}

/**
 * Does `row` satisfy the range `plan` scans? The walk already stays inside it, so this is a second, independent
 * check on the row itself — with `compare`'s own rules, not the index's. It matters inside a composite index, where a
 * NULL in the range column sorts among the entries but never satisfies a range, and it means a mixed-type
 * comparison the index orders one way and SQL another can only ever lose a row, never invent one.
 */
export function rangeHolds(row: Row, plan: { column: string; prefix?: SqlValue[]; low?: RangeBound; high?: RangeBound }): boolean {
  const column = columnsOfIndex(plan.column)[plan.prefix?.length ?? 0];
  if (column === undefined) return true;
  const value = row[column] ?? null;
  if (plan.low && compare(plan.low.inclusive ? '>=' : '>', value, plan.low.value) !== true) return false;
  if (plan.high && compare(plan.high.inclusive ? '<=' : '<', value, plan.high.value) !== true) return false;
  return true;
}

/** The row an index entry points at, read out of `heap` — this query's own, unless a join's other side is meant. */
export function rowAt(ctx: ExecContext, pointer: RowPointer, heap: Heap = ctx.heap): Row | null {
  const page = heap.pages.find((p) => p.pageId === pointer.pageId);
  return page?.rows[pointer.slot] ?? null;
}

/**
 * An equality lookup. The index may hold several entries for the value (a
 * non-unique column, plan.md §25.4 B3), so this pulls one row per entry: the
 * lookup itself fetched the first match's heap page, and each later one is
 * fetched here as its row is asked for.
 */
function indexScan(plan: Extract<Plan, { op: 'IndexScan' }>, ctx: ExecContext): Operator {
  let pointers: RowPointer[] = [];
  let clusterKeys: (readonly SqlValue[])[] | undefined;
  let clusteredTree: BPlusTree | undefined;
  let clusteringColumn = '';
  let cursor = 0;
  const produced = counter(ctx, 'IndexScan', plan.table);

  return {
    name: 'IndexScan',
    open() {
      const tree = ctx.trees[plan.column];
      if (!tree) return;
      const outcome = emitIndexLookup(ctx.emit, tree, lookupKeysOf(plan), ctx.pool, plan.column, ctx.locks);
      pointers = outcome.pointers;
      clusterKeys = outcome.clusterKeys;
      if (tree.clusteredVia !== undefined) {
        clusteringColumn = tree.clusteredVia;
        clusteredTree = ctx.trees[tree.clusteredVia];
      }
    },
    next() {
      for (;;) {
        const at = cursor;
        cursor += 1;
        const pointer = pointers[at];
        if (!pointer) return null;

        // A clustered table's secondary entry has no address (plan.md §25.4 B3e): every match, the first included,
        // costs a real second descent through the clustered index. Otherwise the lookup already fetched the first
        // match's own heap page, and each later one is fetched here, lazily, as it is pulled.
        let resolved: RowPointer | null = pointer;
        const clusterKey = clusterKeys?.[at];
        if (clusterKey && clusteredTree) {
          resolved = resolveClustered(ctx.emit, clusteredTree, clusteringColumn, clusterKey, ctx.pool, ctx.locks);
        } else if (at > 0) {
          fetchHeapPage(ctx, pointer);
        }
        if (!resolved) continue;

        const row = rowAt(ctx, resolved);
        if (!row) continue;

        if (!passes(plan.residual, row)) {
          ctx.emit(
            'The row the index found fails the rest of the predicate, so it is discarded. The index narrowed the search; it did not verify the whole condition.',
            { stage: 'execute', op: 'IndexScan', rowsProduced: 0, table: plan.table },
          );
          continue;
        }

        produced(
          pointers.length === 1
            ? 'IndexScan returns the single row the lookup pointed at.'
            : `IndexScan returns entry ${String(at + 1)} of the ${String(pointers.length)} the lookup found.`,
        );
        return row;
      }
    },
    close() {
      pointers = [];
      clusterKeys = undefined;
      clusteredTree = undefined;
      cursor = 0;
    },
  };
}

/**
 * Same equality lookup as `IndexScan`, but the query needs nothing the leaf
 * doesn't already hold — `column`'s own value, which is the key it was
 * found by. `emitIndexLookup`'s `touchHeap: false` skips the heap fetch and
 * lock entirely, so the row this returns is built from the key alone, never
 * from a page read (plan.md §22.2). One row per entry the index holds for the value.
 */
function indexOnlyScan(plan: Extract<Plan, { op: 'IndexOnlyScan' }>, ctx: ExecContext): Operator {
  let entries: SqlValue[][] = [];
  let cursor = 0;
  const produced = counter(ctx, 'IndexOnlyScan', plan.table);
  const columns = columnsOfIndex(plan.column);

  return {
    name: 'IndexOnlyScan',
    open() {
      const tree = ctx.trees[plan.column];
      if (!tree) return;
      entries = emitIndexLookup(ctx.emit, tree, lookupKeysOf(plan), ctx.pool, plan.column, ctx.locks, false).entries;
    },
    next() {
      const entry = entries[cursor];
      if (!entry) return null;
      cursor += 1;
      produced(
        columns.length > 1
          ? `IndexOnlyScan returns ${columns.map((c) => `\`${c}\``).join(' and ')} straight from the entry — the index covers the query, so the heap is never touched.`
          : 'IndexOnlyScan returns the key itself — the heap is never touched.',
      );
      // The leaf's own values, one per indexed column — a row with exactly the columns the index holds.
      const row: Row = {};
      columns.forEach((column, i) => { row[column] = entry[i] ?? null; });
      return row;
    },
    close() {
      entries = [];
      cursor = 0;
    },
  };
}

/**
 * `<`, `>`, `<=`, `>=` (or a `BETWEEN`) on an indexed column (plan.md
 * §23.1): descend once to the leaf the lower bound starts at, then pull
 * matching rows one at a time by walking the leaf chain — `nextInRange`
 * crosses a `next` sibling pointer exactly when the current leaf runs out,
 * so this stays as lazy as `SeqScan` rather than materialising the whole
 * range in `open()`. Always touches the heap, one page per matching row,
 * the same granularity `IndexScan`'s single row already costs — no
 * index-only variant yet.
 */
function indexRangeScan(plan: Extract<Plan, { op: 'IndexRangeScan' }>, ctx: ExecContext): Operator {
  let leafId: string | null = null;
  let cursorIndex = 0;
  let started = false;
  const produced = counter(ctx, 'IndexRangeScan', plan.table);

  return {
    name: 'IndexRangeScan',
    open() {
      const tree = ctx.trees[plan.column];
      if (!tree) return;
      const start = emitRangeStart(ctx.emit, tree, plan.column, plan.low, ctx.pool, ctx.locks, plan.prefix);
      leafId = start.leafId;
      cursorIndex = start.startIndex;
      started = true;
    },
    next() {
      if (!started) return null;
      const tree = ctx.trees[plan.column];
      if (!tree) return null;

      for (;;) {
        if (leafId === null) return null;
        const found = nextInRange(ctx.emit, tree, leafId, cursorIndex, plan.high, { pool: ctx.pool, locks: ctx.locks }, plan.prefix);
        if (!found) {
          leafId = null;
          return null;
        }
        leafId = found.leafId;
        cursorIndex = found.nextIndex;

        fetchHeapPage(ctx, found.pointer);
        const row = rowAt(ctx, found.pointer);
        if (!row) continue;

        if (!rangeHolds(row, plan) || !passes(plan.residual, row)) continue;

        produced(`IndexRangeScan returns a row via leaf ${found.leafId}.`);
        return row;
      }
    },
    close() {
      leafId = null;
      started = false;
    },
  };
}

/**
 * `Filter` and — with `name: 'Having'` — HAVING (plan.md §25.4 B2): the same
 * per-row predicate, but what flows through a `Having` is a *group* the
 * aggregate below produced, and its aggregate operands read the values that
 * aggregate already computed.
 */
function filter(predicate: Expr, child: Operator, ctx: ExecContext, name: 'Filter' | 'Having' = 'Filter'): Operator {
  const produced = counter(ctx, name);
  let rejected = 0;

  return {
    name,
    open: child.open,
    next() {
      for (;;) {
        const row = child.next();
        if (!row) return null;
        if (!passes(predicate, row)) {
          rejected += 1;
          continue;
        }
        produced(
          name === 'Having'
            ? `Having passes a group through${rejected > 0 ? `, having rejected ${rejected}` : ''} — its aggregates satisfy the predicate.`
            : `Filter passes a row through${rejected > 0 ? `, having rejected ${rejected}` : ''}.`,
        );
        return row;
      }
    },
    close: child.close,
  };
}

function project(columns: ProjectList, child: Operator, ctx: ExecContext): Operator {
  const produced = counter(ctx, 'Project');

  return {
    name: 'Project',
    open: child.open,
    next() {
      const row = child.next();
      if (!row) return null;

      if (columns.kind === 'star') {
        produced('Project passes the row through unchanged — `*` keeps every column.');
        return row;
      }

      if (columns.kind === 'expressions') {
        // Computed columns (plan.md §25.4 B1b): each item is evaluated against the row.
        const computed: Row = {};
        for (const { key, expr } of columns.items) computed[key] = evaluateValue(expr, row);
        produced(`Project computes ${columns.items.map((i) => i.key).join(', ')} for this row.`);
        return computed;
      }

      const narrowed: Row = {};
      for (const name of columns.names) narrowed[name] = row[name] ?? (null as SqlValue);
      produced(`Project keeps ${columns.names.join(', ')} and drops the rest.`);
      return narrowed;
    },
    close: child.close,
  };
}

/** A NULL-safe composite key for a group — collision-free via JSON, unlike joining with a separator. */
function groupKeyOf(row: Row, groupBy: readonly string[]): string {
  return JSON.stringify(groupBy.map((col) => row[col] ?? null));
}

function computeAggregate(spec: AggregateSpec, rows: readonly Row[]): SqlValue {
  if (spec.fn === 'COUNT') {
    return spec.column === null
      ? rows.length
      : rows.filter((r) => (r[spec.column!] ?? null) !== null).length;
  }

  const values = rows.map((r) => r[spec.column!] ?? null).filter((v) => v !== null);
  if (values.length === 0) return null;

  switch (spec.fn) {
    case 'SUM': {
      const nums = values.filter((v): v is number => typeof v === 'number');
      return nums.length === 0 ? null : nums.reduce((a, b) => a + b, 0);
    }
    case 'AVG': {
      const nums = values.filter((v): v is number => typeof v === 'number');
      return nums.length === 0 ? null : nums.reduce((a, b) => a + b, 0) / nums.length;
    }
    case 'MIN':
      return values.reduce((min, v) => (compare('<', v, min) === true ? v : min));
    case 'MAX':
      return values.reduce((max, v) => (compare('>', v, max) === true ? v : max));
  }
}

/** Groups `rows` by `groupBy` (or one group over everything, if empty) and computes each aggregate per group. */
function runHashAggregate(rows: readonly Row[], groupBy: readonly string[], aggregates: readonly AggregateSpec[]): Row[] {
  if (groupBy.length === 0) {
    const groupRow: Row = {};
    for (const spec of aggregates) groupRow[spec.key] = computeAggregate(spec, rows);
    return [groupRow];
  }

  const groups = new Map<string, { key: Row; rows: Row[] }>();
  for (const row of rows) {
    const groupKey = groupKeyOf(row, groupBy);
    let bucket = groups.get(groupKey);
    if (!bucket) {
      bucket = { key: Object.fromEntries(groupBy.map((col) => [col, row[col] ?? null])), rows: [] };
      groups.set(groupKey, bucket);
    }
    bucket.rows.push(row);
  }

  return [...groups.values()].map(({ key, rows: groupRows }) => {
    const groupRow: Row = { ...key };
    for (const spec of aggregates) groupRow[spec.key] = computeAggregate(spec, groupRows);
    return groupRow;
  });
}

/**
 * `GROUP BY` / aggregate functions, computed with a hash table — the other
 * operator here that cannot stream, for the same reason `Sort` cannot: a
 * group is not known to be complete until the whole input has been seen, so
 * the first `next()` call materialises the child, builds one hash-table
 * bucket per distinct `groupBy` combination (a single bucket, if there is no
 * `GROUP BY`), and every later call just streams the finished groups
 * (plan.md §22.2 — `sortAggregate` below is the second strategy this is
 * compared against).
 */
function hashAggregate(plan: Extract<Plan, { op: 'HashAggregate' }>, child: Operator, ctx: ExecContext): Operator {
  let rows: Row[] | null = null;
  let index = 0;
  const produced = counter(ctx, 'HashAggregate');

  return {
    name: 'HashAggregate',
    open() {
      child.open();
      rows = null;
      index = 0;
    },
    next() {
      if (rows === null) {
        const materialised: Row[] = [];
        for (;;) {
          const row = child.next();
          if (!row) break;
          materialised.push(row);
        }
        child.close();
        rows = runHashAggregate(materialised, plan.groupBy, plan.aggregates);
      }

      const row = rows[index];
      if (!row) return null;
      index += 1;
      produced(
        plan.groupBy.length > 0
          ? `HashAggregate returns group ${index} of ${rows.length} (${plan.groupBy
              .map((col) => `${col} = ${JSON.stringify(row[col] ?? null)}`)
              .join(', ')}).`
          : 'HashAggregate returns the one row the whole table collapses into.',
      );
      return row;
    },
    close() {
      if (rows === null) child.close();
    },
  };
}

/** One streaming pass over rows already sorted by `groupBy`: each run of equal keys collapses into one group. */
function collapseSortedGroups(
  sorted: readonly Row[],
  groupBy: readonly string[],
  aggregates: readonly AggregateSpec[],
): Row[] {
  if (groupBy.length === 0) {
    const groupRow: Row = {};
    for (const spec of aggregates) groupRow[spec.key] = computeAggregate(spec, sorted);
    return [groupRow];
  }

  const finishBucket = (bucket: readonly Row[]): Row => {
    const groupRow: Row = {};
    for (const col of groupBy) groupRow[col] = bucket[0]![col] ?? null;
    for (const spec of aggregates) groupRow[spec.key] = computeAggregate(spec, bucket);
    return groupRow;
  };

  const result: Row[] = [];
  let bucket: Row[] = [];
  let bucketKey: string | null = null;
  for (const row of sorted) {
    const key = groupKeyOf(row, groupBy);
    if (bucketKey !== null && key !== bucketKey) {
      result.push(finishBucket(bucket));
      bucket = [];
    }
    bucketKey = key;
    bucket.push(row);
  }
  if (bucket.length > 0) result.push(finishBucket(bucket));
  return result;
}

/**
 * The second aggregate strategy (plan.md §22.2): rather than a hash table,
 * sort the input on `groupBy` first — the exact same `externalMergeSort`
 * `Sort` uses below, so its spill genuinely competes for the same buffer
 * frames a heap scan does — then one streaming pass collapses each run of
 * equal keys into a group with `collapseSortedGroups`, computing every
 * aggregate with the same `computeAggregate` `hashAggregate` uses. Same
 * output, same row count as a `HashAggregate` over the same query; the only
 * difference is *how* it gets there, which is the whole point of naming two
 * strategies and putting them side by side in `/compare`.
 */
function sortAggregate(
  plan: Extract<Plan, { op: 'SortAggregate' }>,
  child: Operator,
  ctx: ExecContext,
): Operator {
  let rows: Row[] | null = null;
  let index = 0;
  const produced = counter(ctx, 'SortAggregate');

  return {
    name: 'SortAggregate',
    open() {
      child.open();
      rows = null;
      index = 0;
    },
    next() {
      if (rows === null) {
        const materialised: Row[] = [];
        for (;;) {
          const row = child.next();
          if (!row) break;
          materialised.push(row);
        }
        child.close();

        const sorted = externalMergeSort(
          materialised,
          (r) => plan.groupBy.map((col) => r[col] ?? null),
          'asc',
          {
            pool: ctx.pool,
            emit: ctx.emit,
            base: ctx.aggregateSortBase ?? pageCountFor(ctx.heap, ctx.trees),
            memPages: ctx.options.bufferFrames,
            rowsPerPage: ctx.options.rowsPerPage,
          },
          'SortAggregate',
          'SortAggregate',
        );
        rows = collapseSortedGroups(sorted, plan.groupBy, plan.aggregates);
      }

      const row = rows[index];
      if (!row) return null;
      index += 1;
      produced(
        plan.groupBy.length > 0
          ? `SortAggregate returns group ${index} of ${rows.length} (${plan.groupBy
              .map((col) => `${col} = ${JSON.stringify(row[col] ?? null)}`)
              .join(', ')}).`
          : 'SortAggregate returns the one row the whole table collapses into.',
      );
      return row;
    },
    close() {
      if (rows === null) child.close();
    },
  };
}

/**
 * `ORDER BY` — the one operator here that cannot stream. Volcano pulls a row
 * at a time, but a sort cannot hand back its first row until it has seen
 * every one, so the first `next()` call materialises the whole child, runs
 * `externalMergeSort` (its own driver, plan.md §22.2 — real page I/O through
 * `ctx.pool`, not `Array.prototype.sort`), and every later call just streams
 * the already-sorted result. A `LIMIT` above an `ORDER BY` therefore caps the
 * *output*, not the scan: the sort has already read everything by the time
 * `Limit` sees a row.
 */
function sort(plan: Extract<Plan, { op: 'Sort' }>, child: Operator, ctx: ExecContext): Operator {
  let rows: Row[] | null = null;
  let index = 0;
  const produced = counter(ctx, 'Sort');

  return {
    name: 'Sort',
    open() {
      child.open();
      rows = null;
      index = 0;
    },
    next() {
      if (rows === null) {
        const materialised: Row[] = [];
        for (;;) {
          const row = child.next();
          if (!row) break;
          materialised.push(row);
        }
        child.close();
        rows = externalMergeSort(materialised, (r) => [r[plan.column] ?? null], plan.direction, {
          pool: ctx.pool,
          emit: ctx.emit,
          base: ctx.sortBase ?? pageCountFor(ctx.heap, ctx.trees),
          memPages: ctx.options.bufferFrames,
          rowsPerPage: ctx.options.rowsPerPage,
        });
      }

      const row = rows[index];
      if (!row) return null;
      index += 1;
      produced(
        `Sort returns row ${index} of ${rows.length}, in ${plan.direction === 'asc' ? 'ascending' : 'descending'} ${plan.column} order.`,
      );
      return row;
    },
    close() {
      if (rows === null) child.close();
    },
  };
}

/**
 * Stops pulling from the child once `count` rows have been produced — the
 * visible Volcano short-circuit (plan.md §22.2). Everything below a `Limit`
 * that has not been pulled yet is simply never asked: a `SeqScan` beneath one
 * can leave most of the table unread, which `close()` on the child makes
 * final rather than merely paused.
 *
 * `offset` (plan.md §25.4 B1c) is the part that is *not* free: the first
 * `offset` rows have to be produced by everything beneath before they can be
 * thrown away, so `LIMIT 10 OFFSET 1000` reads a thousand rows to return
 * ten — the reason deep OFFSET pagination gets slower the further you page.
 */
function limit(count: number, offset: number, child: Operator, ctx: ExecContext): Operator {
  const produced = counter(ctx, 'Limit');
  let taken = 0;
  let skipped = 0;
  let stopped = false;

  return {
    name: 'Limit',
    open: child.open,
    next() {
      if (stopped || taken >= count) return null;

      if (skipped < offset) {
        while (skipped < offset) {
          const discarded = child.next();
          if (!discarded) {
            ctx.emit(
              `Limit discards ${String(skipped)} row${skipped === 1 ? '' : 's'} and then the input runs out — fewer than the OFFSET of ${String(offset)}, so nothing is left to return.`,
              { stage: 'execute', op: 'Limit', rowsProduced: 0 },
            );
            return null;
          }
          skipped += 1;
        }
        ctx.emit(
          `Limit discards the first ${String(offset)} row${offset === 1 ? '' : 's'}: everything beneath still produced each one, and Limit threw it away. That is the cost of OFFSET.`,
          { stage: 'execute', op: 'Limit', rowsProduced: 0 },
        );
      }

      const row = child.next();
      if (!row) return null;
      taken += 1;
      const capped = taken >= count;
      if (capped) stopped = true;
      produced(
        `Limit passes row ${taken} of ${count} through${
          capped ? ' — the cap is reached, so the rows beneath it are never pulled again' : ''
        }.`,
      );
      if (capped) child.close();
      return row;
    },
    close() {
      if (!stopped) child.close();
    },
  };
}

/**
 * A stable text key for a whole row: two rows collide exactly when every column is
 * *equal* — NULL equal to NULL (as DISTINCT and GROUP BY define it), and any other
 * pair equal under `=`'s own coercion (`equalityKeyOf`, the same one the hash and
 * sort-merge joins use). The coercion matters for consistency: the sort orders `1`,
 * `'1'` and `true` as equal, so a hash key that told them apart would let the two
 * DISTINCT strategies disagree on a column that mixes types.
 */
function rowKey(row: Row): string {
  return JSON.stringify(
    Object.keys(row).sort().map((k) => {
      const v = row[k] ?? null;
      return [k, v === null ? null : equalityKeyOf(v)];
    }),
  );
}

/**
 * `SELECT DISTINCT` by hashing (plan.md §25.4 B2). A row is passed on the first
 * time it is seen and dropped every time after — one hash-set lookup per row,
 * no I/O of its own, and *streaming*: the first new row leaves immediately, so
 * a `Limit` above it can stop the whole scan early. The price is memory
 * proportional to the number of distinct rows.
 */
function hashDistinct(child: Operator, ctx: ExecContext): Operator {
  const produced = counter(ctx, 'HashDistinct');
  let seen = new Set<string>();
  let dropped = 0;

  return {
    name: 'HashDistinct',
    open() {
      child.open();
      seen = new Set();
      dropped = 0;
    },
    next() {
      for (;;) {
        const row = child.next();
        if (!row) return null;
        const key = rowKey(row);
        if (seen.has(key)) {
          dropped += 1;
          continue;
        }
        seen.add(key);
        produced(
          `HashDistinct passes a row it has not seen before (${String(seen.size)} distinct so far${
            dropped > 0 ? `, ${String(dropped)} repeat${dropped === 1 ? '' : 's'} dropped` : ''
          }).`,
        );
        return row;
      }
    },
    close: child.close,
  };
}

/**
 * `SELECT DISTINCT` by sorting (plan.md §25.4 B2) — the other half of the hash-vs-
 * sort contrast `GROUP BY` already has. It cannot stream: it pulls *every* row,
 * runs them through `externalMergeSort` (real spill I/O through the buffer pool,
 * in its own reserved block of pages), and only then keeps one row of each run
 * of equals. The sort key is the `ORDER BY` column first (so the caller's order
 * survives) and then every column, which is what makes equal rows adjacent.
 */
function sortDistinct(plan: Extract<Plan, { op: 'SortDistinct' }>, child: Operator, ctx: ExecContext): Operator {
  const produced = counter(ctx, 'SortDistinct');
  let rows: Row[] | null = null;
  let index = 0;

  return {
    name: 'SortDistinct',
    open() {
      child.open();
      rows = null;
      index = 0;
    },
    next() {
      if (rows === null) {
        const materialised: Row[] = [];
        for (;;) {
          const row = child.next();
          if (!row) break;
          materialised.push(row);
        }
        child.close();

        const keyOf = (r: Row): SqlValue[] => {
          const columns = Object.keys(r).sort();
          const first = plan.sortKey ? [plan.sortKey.column] : [];
          return [...first, ...columns].map((c) => r[c] ?? null);
        };
        const sorted = externalMergeSort(
          materialised,
          keyOf,
          plan.sortKey?.direction ?? 'asc',
          {
            pool: ctx.pool,
            emit: ctx.emit,
            base: ctx.distinctBase ?? pageCountFor(ctx.heap, ctx.trees),
            memPages: ctx.options.bufferFrames,
            rowsPerPage: ctx.options.rowsPerPage,
          },
          'SortDistinct',
          'SortDistinct',
        );

        const kept: Row[] = [];
        let last: string | null = null;
        for (const row of sorted) {
          const key = rowKey(row);
          if (key !== last) kept.push(row);
          last = key;
        }
        rows = kept;
      }

      const row = rows[index];
      if (!row) return null;
      index += 1;
      produced(`SortDistinct returns distinct row ${String(index)} of ${String(rows.length)}.`);
      return row;
    },
    close() {
      if (rows === null) child.close();
    },
  };
}

/**
 * Merges a left and right row into one, qualifying every key `table.column` so the two can never collide. `leftRow`
 * came straight off a base-table scan the *first* time a query joins anything, so its own keys are still bare — but
 * a later `Join` in a chain (plan.md §25.4 C3 slice b) receives, as its `left`, the *previous* Join's already-merged
 * row, whose keys are already `table.column`-qualified for every table in the chain so far. Re-qualifying an
 * already-qualified key would nest a table name inside another (`b.a.id`), so a key that already has a `.` in it is
 * kept exactly as it is — column names themselves never contain one (the tokenizer's `.` is only ever the qualifier
 * separator), so this can never mistake a real column for an already-merged one.
 */
function mergeJoinedRow(leftTable: string, leftRow: Row, rightTable: string, rightRow: Row): Row {
  const merged: Row = {};
  for (const [key, value] of Object.entries(leftRow)) merged[key.includes('.') ? key : `${leftTable}.${key}`] = value;
  for (const [key, value] of Object.entries(rightRow)) merged[`${rightTable}.${key}`] = value;
  return merged;
}

/** A `LEFT JOIN`'s own row for a `left` row that matched nothing on `right` (plan.md §25.4 C3): every one of
 *  `right`'s declared columns comes back NULL, qualified the same way `mergeJoinedRow` qualifies a real match —
 *  the row is still there, it just has nothing real to report on that side. */
function nullPaddedRow(leftTable: string, leftRow: Row, rightTable: string, rightColumns: readonly string[]): Row {
  const merged: Row = {};
  for (const [key, value] of Object.entries(leftRow)) merged[key.includes('.') ? key : `${leftTable}.${key}`] = value;
  for (const column of rightColumns) merged[`${rightTable}.${column}`] = null;
  return merged;
}

/**
 * Reads a `Join`'s own left-hand join-key value off `row` — `column` bare if `row` came straight off a base-table
 * scan (a query's first `JOIN`), or `table.column` if an earlier `Join` in the chain already merged and qualified it
 * (plan.md §25.4 C3 slice b). Only ever needed for the *left* side: a left-deep chain's `right` side is always a
 * fresh, unqualified base-table scan or probe, so every plain `row[plan.rightColumn]` elsewhere is still correct
 * exactly as written.
 */
function leftJoinValue(row: Row, table: string, column: string): SqlValue {
  return (column in row ? row[column] : row[`${table}.${column}`]) ?? null;
}

/** `leftJoinValue`, coerced for equality the same way `joinKeyOf` coerces a right-side value — so sort-merge's two
 *  sides, sorted independently, still agree on which keys are equal. */
function leftJoinKeyOf(row: Row, table: string, column: string): string | null {
  const value = leftJoinValue(row, table, column);
  return value === null ? null : equalityKeyOf(value);
}

/** Which of the two subquery joins a `Join` is (plan.md §27.5 S1), or `null` for an inner or LEFT join. */
function semiKindOf(plan: Extract<Plan, { op: 'Join' }>): 'semi' | 'anti' | null {
  return plan.joinType === 'semi' || plan.joinType === 'anti' ? plan.joinType : null;
}

/**
 * A semi- or anti-join's own test of a pair whose keys already matched (plan.md §27.5 S1): the rest of the
 * subquery's `WHERE` that names both tables — `residual`, qualified — must hold too, read off the two rows merged the
 * way an inner join would merge them. With no residual, a key match is the whole test.
 */
function residualHolds(plan: Extract<Plan, { op: 'Join' }>, leftRow: Row, rightRow: Row): boolean {
  return plan.residual === undefined || passes(plan.residual, mergeJoinedRow(plan.leftTable, leftRow, plan.rightTable, rightRow));
}

/** How a semi- or anti-join's decision reads in the trace: the subquery's answer for this row, and what follows from it. */
function semiVerdict(kind: 'semi' | 'anti', found: boolean): string {
  if (kind === 'semi') return found ? 'EXISTS is TRUE, so the row is kept — once' : 'EXISTS is FALSE, so the row is dropped';
  return found ? 'NOT EXISTS is FALSE, so the row is dropped' : 'NOT EXISTS is TRUE, so the row is kept';
}

/**
 * Nested-loop join — the simplest algorithm, and the first one v1 had
 * (plan.md §22.2; `hashJoin` below is the second). For every row the left
 * (outer) side produces, the right (inner) side is rescanned from scratch
 * looking for a match: `right`'s operator is only ever built once and
 * re-opened per outer row, exactly the reset `open()` already means for
 * every other operator here. `ctx.joinPartners[plan.rightTable]` carries the right table's own heap (built by
 * `runQuery.ts`, its pages numbered right after whatever came before it), so `right`'s `SeqScan` reads through a
 * genuinely different table than
 * `left`'s — the one thing an `ExecContext` never had to represent before a
 * query could name two tables at once. `left` may itself be another `Join`
 * (plan.md §25.4 C3 slice b's chain) — `buildOperator`'s own recursion
 * handles that with no special case here at all.
 */
function join(plan: Extract<Plan, { op: 'Join' }>, ctx: ExecContext): Operator {
  const joinRight = ctx.joinPartners?.[plan.rightTable];
  if (!joinRight) throw new Error("unreachable: a Join plan implies ExecContext.joinPartners has this Join's rightTable");
  const isLeft = plan.joinType === 'left';
  // A semi- or anti-join (plan.md §27.5 S1) is this same loop with one change: the rescan of `right` stops at the first
  // match, because one is all EXISTS asks for. That is exactly what running the subquery again for every outer row does.
  const semi = semiKindOf(plan);

  const left = buildOperator(plan.left, ctx);
  const right = buildOperator(plan.right, {
    ...ctx,
    table: joinRight.table,
    heap: joinRight.heap,
    trees: joinRight.trees,
  });

  const produced = counter(ctx, 'Join', plan.rightTable);
  let leftRow: Row | null = null;
  let rightOpen = false;
  let checked = 0;
  // LEFT JOIN only (plan.md §25.4 C3): whether the current left row has matched anything yet.
  let matched = false;
  // Semi- and anti-joins only: how many inner rows this outer row's rescan has read.
  let readThisRow = 0;

  return {
    name: 'Join',
    open() {
      left.open();
      leftRow = null;
      rightOpen = false;
      checked = 0;
      matched = false;
      readThisRow = 0;
    },
    next() {
      for (;;) {
        if (!rightOpen) {
          leftRow = left.next();
          if (!leftRow) return null;
          matched = false;
          readThisRow = 0;
          right.open();
          rightOpen = true;
        }

        const rightRow = right.next();
        if (!rightRow) {
          rightOpen = false;
          // The whole inner table was read and nothing matched: NOT EXISTS keeps the row; EXISTS has already moved on.
          if (semi === 'anti') {
            produced(`Join reads all ${String(readThisRow)} row${readThisRow === 1 ? '' : 's'} of ${plan.rightTable} and finds no match for a row from ${plan.leftTable} — ${semiVerdict('anti', false)}.`);
            return leftRow;
          }
          if (semi === 'semi') continue;
          // The whole inner table was rescanned and nothing matched this left row — a LEFT JOIN keeps it anyway.
          if (isLeft && !matched) {
            produced(`Join finds no match in ${plan.rightTable} for a row from ${plan.leftTable} — LEFT JOIN keeps it, with ${plan.rightTable}'s columns NULL.`);
            return nullPaddedRow(plan.leftTable, leftRow!, plan.rightTable, joinRight.table.columns);
          }
          continue;
        }
        checked += 1;
        readThisRow += 1;

        // NULL never matches NULL — the same three-valued rule an ordinary
        // `=` predicate follows, so a NULL join key simply finds no partner.
        if (compare('=', leftJoinValue(leftRow!, plan.leftTable, plan.leftColumn), rightRow[plan.rightColumn] ?? null) !== true) {
          continue;
        }

        if (semi) {
          if (!residualHolds(plan, leftRow!, rightRow)) continue;
          // One match settles it either way: the rest of the inner table is never read for this row. The next outer
          // row reopens the scan from its first page.
          rightOpen = false;
          if (semi === 'anti') continue;
          produced(
            `Join finds a match in ${plan.rightTable} for a row from ${plan.leftTable} after reading ${String(readThisRow)} of its rows — ${semiVerdict('semi', true)}, and the rest of ${plan.rightTable} is not read for it.`,
          );
          return leftRow;
        }

        matched = true;
        produced(
          `Join matches a row from ${plan.leftTable} with one from ${plan.rightTable} (${checked} candidate${
            checked === 1 ? '' : 's'
          } checked so far).`,
        );
        return mergeJoinedRow(plan.leftTable, leftRow!, plan.rightTable, rightRow);
      }
    },
    close() {
      left.close();
      right.close();
    },
  };
}

/**
 * Hash join — the second algorithm (plan.md §22.2). The build phase drains
 * the right side once into an in-memory hash table keyed by
 * `equalityKeyOf(rightColumn)` — a NULL key is never inserted, mirroring the
 * "NULL never matches NULL" rule nested-loop's `compare('=', ...)` already
 * enforces — reading every one of its pages exactly once through the real
 * buffer pool; the probe phase then streams the left side one row at a
 * time, looking each one up instead of rescanning. `equalityKeyOf` is used
 * on both sides specifically so a hash join agrees with nested-loop even
 * when the two columns hold mixed types (a number and a numeric string, say)
 * — the two algorithms must never disagree on which rows match. No
 * partitioning or spill: the table itself lives in a plain JS `Map`, the
 * same simplification `HashAggregate` already makes for `GROUP BY`; a build
 * side too large for memory needs partition spill (Grace hash join),
 * `/tools/hash-join`'s own deferred future work.
 */
function hashJoin(plan: Extract<Plan, { op: 'Join' }>, ctx: ExecContext): Operator {
  const joinRight = ctx.joinPartners?.[plan.rightTable];
  if (!joinRight) throw new Error("unreachable: a Join plan implies ExecContext.joinPartners has this Join's rightTable");
  const isLeft = plan.joinType === 'left';
  // A semi- or anti-join (plan.md §27.5 S1) builds the same table and probes it the same way, but an outer row comes out
  // at most once: kept if any row in its bucket passes the residual (semi), or if none does (anti).
  const semi = semiKindOf(plan);

  const left = buildOperator(plan.left, ctx);
  const right = buildOperator(plan.right, {
    ...ctx,
    table: joinRight.table,
    heap: joinRight.heap,
    trees: joinRight.trees,
  });

  const produced = counter(ctx, 'Join', plan.rightTable);
  let built: Map<string, Row[]> | null = null;
  let leftRow: Row | null = null;
  let bucket: Row[] = [];
  let bucketIndex = 0;
  let matched = 0;

  return {
    name: 'Join',
    open() {
      left.open();
      right.open();
      built = null;
      leftRow = null;
      bucket = [];
      bucketIndex = 0;
      matched = 0;
    },
    next() {
      if (!built) {
        const table = new Map<string, Row[]>();
        for (;;) {
          const row = right.next();
          if (!row) break;
          const value = row[plan.rightColumn] ?? null;
          if (value === null) continue;
          const key = equalityKeyOf(value);
          const existing = table.get(key);
          if (existing) existing.push(row);
          else table.set(key, [row]);
        }
        right.close();
        built = table;
        ctx.emit(
          `Join builds an in-memory hash table over ${plan.rightTable}, keyed on ${plan.rightColumn} (${String(table.size)} distinct key${table.size === 1 ? '' : 's'}).`,
          { stage: 'execute', op: 'Join', rowsProduced: 0, table: plan.rightTable },
        );
      }

      if (semi) {
        for (;;) {
          const row = left.next();
          if (!row) return null;
          const value = leftJoinValue(row, plan.leftTable, plan.leftColumn);
          const candidates = value === null ? [] : (built.get(equalityKeyOf(value)) ?? []);
          const found = candidates.some((candidate) => residualHolds(plan, row, candidate));
          if (found !== (semi === 'semi')) continue;
          produced(
            found
              ? `Join probes the hash table with a row from ${plan.leftTable} and finds ${candidates.length === 1 ? 'a match' : `${String(candidates.length)} rows with its key`} in ${plan.rightTable} — ${semiVerdict('semi', true)}, however many rows share its key.`
              : `Join probes the hash table with a row from ${plan.leftTable} and finds nothing in ${plan.rightTable} — ${semiVerdict('anti', false)}.`,
          );
          return row;
        }
      }

      for (;;) {
        if (bucketIndex >= bucket.length) {
          leftRow = left.next();
          if (!leftRow) return null;
          const value = leftJoinValue(leftRow, plan.leftTable, plan.leftColumn);
          bucket = value === null ? [] : (built.get(equalityKeyOf(value)) ?? []);
          bucketIndex = 0;
          // Empty bucket, or a NULL key that was never even looked up — nothing matched this left row at all.
          if (isLeft && bucket.length === 0) {
            produced(`Join probes the hash table with a row from ${plan.leftTable} and finds nothing in ${plan.rightTable} — LEFT JOIN keeps it, with ${plan.rightTable}'s columns NULL.`);
            return nullPaddedRow(plan.leftTable, leftRow, plan.rightTable, joinRight.table.columns);
          }
          continue;
        }

        const rightRow = bucket[bucketIndex]!;
        bucketIndex += 1;
        matched += 1;
        produced(
          `Join probes the hash table with a row from ${plan.leftTable} and finds a match in ${plan.rightTable} (${matched} match${matched === 1 ? '' : 'es'} so far).`,
        );
        return mergeJoinedRow(plan.leftTable, leftRow!, plan.rightTable, rightRow);
      }
    },
    close() {
      left.close();
      if (!built) right.close();
    },
  };
}

/**
 * Index nested-loop join — the fourth algorithm (plan.md §25.4 B4). The
 * nested-loop join's shape (an outer loop over `left`, an inner lookup per
 * row), but the inner lookup is a descent of `right`'s own B+Tree on the join
 * column instead of a rescan of its whole heap: each outer row costs the
 * tree's few levels plus a heap page per matching row, whatever the inner
 * table's size. That is why "a small outer over a big indexed inner" is where
 * this algorithm wins — and why it is the *worst* of the four when the outer is
 * large and the inner is small enough that one scan of it would have done.
 *
 * The inner index may repeat a value (a foreign key: several posts per
 * author), so a probe returns *every* entry for the key — the first entry's
 * heap page is fetched by the lookup itself and each later one as its row is
 * pulled, so a `LIMIT` above the join stops the probing early. A NULL join key
 * is never probed: `= NULL` is never true and an index holds no NULLs.
 * Every candidate is rechecked against the ON equality, so this can never
 * return a row the other three would not.
 */
function indexNestedLoopJoin(plan: Extract<Plan, { op: 'Join' }>, ctx: ExecContext): Operator {
  const joinRight = ctx.joinPartners?.[plan.rightTable];
  if (!joinRight) throw new Error("unreachable: a Join plan implies ExecContext.joinPartners has this Join's rightTable");
  const inner = plan.right;
  if (inner.op !== 'IndexProbe') throw new Error('unreachable: an index nested-loop Join has an IndexProbe as its inner side');
  const tree = joinRight.trees[inner.column];
  if (!tree) throw new Error('unreachable: an index nested-loop Join implies its inner index was built');
  const isLeft = plan.joinType === 'left';
  // A semi- or anti-join (plan.md §27.5 S1) probes once per outer row like the inner join, but stops fetching the
  // probe's entries at the first that passes: one is all EXISTS needs.
  const semi = semiKindOf(plan);

  const left = buildOperator(plan.left, ctx);
  const produced = counter(ctx, 'Join', plan.rightTable);
  let leftRow: Row | null = null;
  let pointers: RowPointer[] = [];
  let cursor = 0;
  let probes = 0;
  let matched = 0;
  // LEFT JOIN only (plan.md §25.4 C3): whether the current left row has matched anything yet.
  let matchedThisRow = false;

  return {
    name: 'Join',
    open() {
      left.open();
      leftRow = null;
      pointers = [];
      cursor = 0;
      probes = 0;
      matched = 0;
      matchedThisRow = false;
    },
    next() {
      if (semi) {
        for (;;) {
          const row = left.next();
          if (!row) return null;
          const key = leftJoinValue(row, plan.leftTable, plan.leftColumn);
          let found = false;
          let fetched = 0;
          // A NULL key matches nothing, so there is nothing to probe — EXISTS is FALSE and NOT EXISTS TRUE for it.
          if (key !== null) {
            probes += 1;
            ctx.emit(
              `Join takes a row from ${plan.leftTable} whose ${plan.leftColumn} is ${typeof key === 'string' ? `'${key}'` : String(key)} and probes ${plan.rightTable}'s B+Tree on ${plan.rightColumn} for it (probe ${String(probes)}).`,
              { stage: 'execute', op: 'Join', rowsProduced: matched, table: plan.rightTable },
            );
            const entries = emitIndexLookup(ctx.emit, tree, [key], ctx.pool, inner.column, ctx.locks).pointers;
            for (let at = 0; at < entries.length && !found; at++) {
              const pointer = entries[at]!;
              // The lookup itself fetched the first entry's heap page; each later one is fetched only if it is needed.
              if (at > 0) fetchHeapPage(ctx, pointer);
              fetched = at + 1;
              const rightRow = rowAt(ctx, pointer, joinRight.heap);
              if (!rightRow) continue;
              if (compare('=', key, rightRow[plan.rightColumn] ?? null) !== true) continue;
              found = residualHolds(plan, row, rightRow);
            }
            if (found && entries.length > fetched) {
              ctx.emit(
                `Join stops after ${String(fetched)} of the ${String(entries.length)} entries the probe found — one match settles it.`,
                { stage: 'execute', op: 'Join', rowsProduced: matched, table: plan.rightTable },
              );
            }
          }
          if (found !== (semi === 'semi')) continue;
          matched += 1;
          produced(
            found
              ? `Join's probe of ${plan.rightTable} finds a match for a row from ${plan.leftTable} — ${semiVerdict('semi', true)}.`
              : `Join's probe of ${plan.rightTable} finds nothing for a row from ${plan.leftTable} — ${semiVerdict('anti', false)}.`,
          );
          return row;
        }
      }

      for (;;) {
        const pointer = pointers[cursor];
        if (pointer === undefined) {
          // Every candidate the probe found (a NULL key never even probed counts too) has been checked and rejected
          // — LEFT JOIN keeps this left row anyway, before moving on to the next one.
          if (leftRow && isLeft && !matchedThisRow) {
            const unmatched = leftRow;
            leftRow = null;
            produced(`Join's probe of ${plan.rightTable} finds nothing for a row from ${plan.leftTable} — LEFT JOIN keeps it, with ${plan.rightTable}'s columns NULL.`);
            return nullPaddedRow(plan.leftTable, unmatched, plan.rightTable, joinRight.table.columns);
          }

          leftRow = left.next();
          if (!leftRow) return null;
          pointers = [];
          cursor = 0;
          matchedThisRow = false;

          const key = leftJoinValue(leftRow, plan.leftTable, plan.leftColumn);
          if (key === null) continue; // NULL joins nothing, so there is nothing to look up
          probes += 1;
          ctx.emit(
            `Join takes a row from ${plan.leftTable} whose ${plan.leftColumn} is ${typeof key === 'string' ? `'${key}'` : String(key)} and probes ${plan.rightTable}'s B+Tree on ${plan.rightColumn} for it (probe ${String(probes)}).`,
            { stage: 'execute', op: 'Join', rowsProduced: matched, table: plan.rightTable },
          );
          pointers = emitIndexLookup(ctx.emit, tree, [key], ctx.pool, inner.column, ctx.locks).pointers;
          continue;
        }

        const at = cursor;
        cursor += 1;
        // The lookup itself fetched the first match's heap page; each later one is fetched as its row is pulled.
        if (at > 0) fetchHeapPage(ctx, pointer);
        const rightRow = rowAt(ctx, pointer, joinRight.heap);
        if (!rightRow) continue;
        if (compare('=', leftJoinValue(leftRow!, plan.leftTable, plan.leftColumn), rightRow[plan.rightColumn] ?? null) !== true) continue;

        matchedThisRow = true;
        matched += 1;
        produced(
          `Join pairs a row from ${plan.leftTable} with entry ${String(at + 1)} of ${String(pointers.length)} its probe found in ${plan.rightTable} (${String(matched)} match${matched === 1 ? '' : 'es'} so far).`,
        );
        return mergeJoinedRow(plan.leftTable, leftRow!, plan.rightTable, rightRow);
      }
    },
    close() {
      left.close();
      pointers = [];
    },
  };
}

/**
 * A join key, coerced the exact way `equalityKeyOf` already does for hash
 * join — so a value that hash join and nested-loop's `compare('=', ...)`
 * would call equal (a number and a numeric string, say) sorts to the *same*
 * key here too. Without that, the sort could scatter two "equal" rows apart
 * instead of adjacent, and the merge below would silently miss the match —
 * sort-merge join must never disagree with the other two on which rows
 * match, the same property hash join's own mixed-type test defends.
 */
function joinKeyOf(row: Row, column: string): string | null {
  const value = row[column] ?? null;
  return value === null ? null : equalityKeyOf(value);
}

/**
 * The merge phase, as a generator: `left`/`right` are already fully sorted
 * on their own join key (ascending, NULLs last — `externalMergeSort`'s own
 * rule). NULL never matches, so once either pointer reaches the NULL tail it
 * only ever advances, never matches. A key can repeat on either side (the
 * join column need not be unique), so a matching key advances through the
 * *entire* run on both sides — every left row in the run paired with every
 * right row in it — before either pointer moves past the run, the textbook
 * refinement a plain two-pointer merge misses.
 *
 * `isLeft` (plan.md §25.4 C3): a plain merge only ever needs to look as far as
 * whichever side runs out first — once one is exhausted, nothing further can
 * match. A `LEFT JOIN` cannot stop there: every remaining `left` row, and any
 * `left` row the walk passes with no run of equal keys on `right` at all, must
 * still be yielded — paired with `null` rather than dropped — so the loop
 * keeps going until `left` itself is exhausted, not `right`.
 *
 * `leftTable` (plan.md §25.4 C3 slice b): `left`'s own rows may already carry qualified keys from an earlier `Join`
 * in a chain, so every left-side key read goes through `leftJoinKeyOf` rather than `joinKeyOf` directly — `right` is
 * always a fresh base-table scan, so its own reads are unaffected.
 */
function* sortMergeMatches(
  left: readonly Row[],
  right: readonly Row[],
  leftTable: string,
  leftColumn: string,
  rightColumn: string,
  isLeft: boolean,
): Generator<readonly [Row, Row | null]> {
  let i = 0;
  let j = 0;
  while (i < left.length) {
    const leftKey = leftJoinKeyOf(left[i]!, leftTable, leftColumn);
    if (leftKey === null) {
      if (isLeft) yield [left[i]!, null];
      i += 1;
      continue;
    }

    // Advance past whatever this key can never match: a NULL key, or one sorted strictly behind it.
    while (j < right.length) {
      const aheadKey = joinKeyOf(right[j]!, rightColumn);
      if (aheadKey !== null && aheadKey >= leftKey) break;
      j += 1;
    }
    const rightKey = j < right.length ? joinKeyOf(right[j]!, rightColumn) : null;
    if (rightKey !== leftKey) {
      // Either the right side is exhausted, or its next key is already past this one — nothing here matches.
      if (isLeft) yield [left[i]!, null];
      i += 1;
      continue;
    }

    const runStart = j;
    while (i < left.length && leftJoinKeyOf(left[i]!, leftTable, leftColumn) === leftKey) {
      for (let k = runStart; k < right.length && joinKeyOf(right[k]!, rightColumn) === leftKey; k++) {
        yield [left[i]!, right[k]!];
      }
      i += 1;
    }
    j = runStart;
    while (j < right.length && joinKeyOf(right[j]!, rightColumn) === leftKey) j += 1;
  }
}

/**
 * The merge phase of a sort-merge semi- or anti-join (plan.md §27.5 S1), as a generator of the `left` rows that
 * survive: each left row is checked against the run of equal keys on `right` — the same walk `sortMergeMatches`
 * makes — and comes out once if a row in that run passes `test` (semi), or if none does (anti). A NULL left key has
 * no run at all, so an anti-join keeps it and a semi-join drops it.
 */
function* sortMergeSemi(
  left: readonly Row[],
  right: readonly Row[],
  leftTable: string,
  leftColumn: string,
  rightColumn: string,
  kind: 'semi' | 'anti',
  test: (leftRow: Row, rightRow: Row) => boolean,
): Generator<Row> {
  let j = 0;
  for (const row of left) {
    const leftKey = leftJoinKeyOf(row, leftTable, leftColumn);
    let found = false;
    if (leftKey !== null) {
      while (j < right.length) {
        const aheadKey = joinKeyOf(right[j]!, rightColumn);
        if (aheadKey !== null && aheadKey >= leftKey) break;
        j += 1;
      }
      for (let k = j; k < right.length && joinKeyOf(right[k]!, rightColumn) === leftKey && !found; k++) {
        found = test(row, right[k]!);
      }
    }
    if (found === (kind === 'semi')) yield row;
  }
}

/**
 * Sort-merge join — the third algorithm (plan.md §22.2). Sorts both sides on
 * the join key, each its own `externalMergeSort` call (the same driver
 * `Sort` uses, real spill I/O through `ctx.pool`), then merges the two
 * sorted lists in a single pass — the classic trade against the other two:
 * no per-row rescan (nested-loop's cost) and no in-memory table sized to one
 * side (hash join's), at the price of sorting both sides first even when
 * neither would otherwise need to be. Like `Sort`, this cannot produce a row
 * until *both* sides are fully sorted, so a `LIMIT` above it caps only the
 * merge's output — the sorting has already happened by the time any row
 * comes out, the same honest gap `Sort`'s own doc comment names.
 *
 * `left`'s sort scratch starts right after every page id already spoken for; `right`'s starts right after `left`'s
 * own reservation. For a chain of several `JOIN`s (plan.md §25.4 C3 slice b), each sort-merge step's own pair of
 * bases depends on how much scratch space every *earlier* step already claimed — genuinely sequential bookkeeping,
 * not something this operator alone can work out from its own two children — so `runQuery.ts` computes every
 * sort-merge `Join`'s bases up front, in chain order, and hands them back keyed by that `Join`'s own plan-node
 * identity (`ctx.sortMergeBases`); this operator just looks its own up rather than deriving it.
 */
function sortMergeJoin(plan: Extract<Plan, { op: 'Join' }>, ctx: ExecContext): Operator {
  const joinRight = ctx.joinPartners?.[plan.rightTable];
  if (!joinRight) throw new Error("unreachable: a Join plan implies ExecContext.joinPartners has this Join's rightTable");
  const bases = ctx.sortMergeBases?.get(plan);
  if (!bases) throw new Error('unreachable: a sort-merge Join plan implies runQuery.ts reserved its scratch bases');
  const isLeft = plan.joinType === 'left';
  const semi = semiKindOf(plan);

  const left = buildOperator(plan.left, ctx);
  const right = buildOperator(plan.right, {
    ...ctx,
    table: joinRight.table,
    heap: joinRight.heap,
    trees: joinRight.trees,
  });

  const produced = counter(ctx, 'Join', plan.rightTable);
  let matches: Generator<readonly [Row, Row | null]> | null = null;
  // A semi- or anti-join's survivors (plan.md §27.5 S1), in place of `matches`' pairs.
  let survivors: Generator<Row> | null = null;
  let matched = 0;

  return {
    name: 'Join',
    open() {
      left.open();
      right.open();
      matches = null;
      survivors = null;
      matched = 0;
    },
    next() {
      if (!matches) {
        const leftRows: Row[] = [];
        for (;;) {
          const row = left.next();
          if (!row) break;
          leftRows.push(row);
        }
        left.close();

        const rightRows: Row[] = [];
        for (;;) {
          const row = right.next();
          if (!row) break;
          rightRows.push(row);
        }
        right.close();

        const leftSorted = externalMergeSort(
          leftRows,
          (r) => [leftJoinKeyOf(r, plan.leftTable, plan.leftColumn)],
          'asc',
          {
            pool: ctx.pool,
            emit: ctx.emit,
            base: bases.leftBase,
            memPages: ctx.options.bufferFrames,
            rowsPerPage: ctx.options.rowsPerPage,
          },
          plan.leftTable,
          'Join',
          plan.rightTable,
        );
        const rightSorted = externalMergeSort(
          rightRows,
          (r) => [joinKeyOf(r, plan.rightColumn)],
          'asc',
          {
            pool: ctx.pool,
            emit: ctx.emit,
            base: bases.rightBase,
            memPages: ctx.options.bufferFrames,
            rowsPerPage: ctx.options.rowsPerPage,
          },
          plan.rightTable,
          'Join',
          plan.rightTable,
        );

        ctx.emit(
          `Join sorts ${plan.leftTable} and ${plan.rightTable} on the join key, then merges the two sorted lists in one pass.`,
          { stage: 'execute', op: 'Join', rowsProduced: 0, table: plan.rightTable },
        );

        if (semi) {
          survivors = sortMergeSemi(leftSorted, rightSorted, plan.leftTable, plan.leftColumn, plan.rightColumn, semi, (l, r) => residualHolds(plan, l, r));
        }
        matches = sortMergeMatches(leftSorted, rightSorted, plan.leftTable, plan.leftColumn, plan.rightColumn, isLeft);
      }

      if (survivors) {
        const kept = survivors.next();
        if (kept.done) return null;
        matched += 1;
        produced(
          semi === 'semi'
            ? `Join's merge finds a run of matching keys on ${plan.rightTable} for a row from ${plan.leftTable} — ${semiVerdict('semi', true)}.`
            : `Join's merge finds no run of matching keys on ${plan.rightTable} for a row from ${plan.leftTable} — ${semiVerdict('anti', false)}.`,
        );
        return kept.value;
      }

      const step = matches.next();
      if (step.done) return null;
      const [leftRow, rightRow] = step.value;
      if (rightRow === null) {
        produced(`Join's merge passes a row from ${plan.leftTable} with no run of matching keys on ${plan.rightTable} — LEFT JOIN keeps it, with ${plan.rightTable}'s columns NULL.`);
        return nullPaddedRow(plan.leftTable, leftRow, plan.rightTable, joinRight.table.columns);
      }
      matched += 1;
      produced(
        `Join merges a row from ${plan.leftTable} with one from ${plan.rightTable} — both sides already sorted on the join key (${matched} match${matched === 1 ? '' : 'es'} so far).`,
      );
      return mergeJoinedRow(plan.leftTable, leftRow, plan.rightTable, rightRow);
    },
    close() {
      if (!matches) {
        left.close();
        right.close();
      }
    },
  };
}

/** Dispatches a `Join` node to its own algorithm's operator. */
function buildJoinOperator(plan: Extract<Plan, { op: 'Join' }>, ctx: ExecContext): Operator {
  switch (plan.algorithm) {
    case 'hash':
      return hashJoin(plan, ctx);
    case 'sort-merge':
      return sortMergeJoin(plan, ctx);
    case 'nested-loop':
      return join(plan, ctx);
    case 'index-nested-loop':
      return indexNestedLoopJoin(plan, ctx);
  }
}

/** Turns a plan tree into an operator tree of the same shape. */
export function buildOperator(plan: Plan, ctx: ExecContext): Operator {
  switch (plan.op) {
    case 'SeqScan':
      return seqScan(plan, ctx);
    case 'IndexScan':
      return indexScan(plan, ctx);
    case 'IndexOnlyScan':
      return indexOnlyScan(plan, ctx);
    case 'IndexRangeScan':
      return indexRangeScan(plan, ctx);
    case 'IndexProbe':
      // Only ever the inner side of an index nested-loop `Join`, which probes it itself, once per outer row.
      throw new Error('unreachable: an IndexProbe is driven by its Join, never built on its own');
    case 'Join':
      return buildJoinOperator(plan, ctx);
    case 'Filter':
      return filter(plan.predicate, buildOperator(plan.child, ctx), ctx);
    case 'Having':
      return filter(plan.predicate, buildOperator(plan.child, ctx), ctx, 'Having');
    case 'HashAggregate':
      return hashAggregate(plan, buildOperator(plan.child, ctx), ctx);
    case 'SortAggregate':
      return sortAggregate(plan, buildOperator(plan.child, ctx), ctx);
    case 'Sort':
      return sort(plan, buildOperator(plan.child, ctx), ctx);
    case 'Project':
      return project(plan.columns, buildOperator(plan.child, ctx), ctx);
    case 'HashDistinct':
      return hashDistinct(buildOperator(plan.child, ctx), ctx);
    case 'SortDistinct':
      return sortDistinct(plan, buildOperator(plan.child, ctx), ctx);
    case 'Limit':
      return limit(plan.count, plan.offset ?? 0, buildOperator(plan.child, ctx), ctx);
  }
}
