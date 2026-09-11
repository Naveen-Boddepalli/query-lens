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
import type { AggregateSpec, Plan, ProjectList } from '../planner/index.ts';
import type { BufferPool, Heap } from '../storage/index.ts';
import type { LockManager } from '../locks/index.ts';
import type { BPlusTree } from '../index/index.ts';
import { emitIndexLookup, pageCountFor } from '../index/index.ts';
import { compare, passes } from './evaluate.ts';
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
  heap: Heap;
  tree: BPlusTree | null;
  table: Table;
  options: EngineOptions;
}

/** Counts rows an operator has produced, so `execute` events stay cumulative. */
function counter(ctx: ExecContext, name: string) {
  let produced = 0;
  return (label: string) => {
    produced += 1;
    ctx.emit(label, { stage: 'execute', op: name, rowsProduced: produced });
  };
}

/* -------------------------------------------------------------------------- */

function seqScan(plan: Extract<Plan, { op: 'SeqScan' }>, ctx: ExecContext): Operator {
  let pageIndex = 0;
  let rowIndex = 0;
  let pinnedFrame: number | null = null;
  let lockedPage: number | null = null;
  let skipped = 0;
  const produced = counter(ctx, 'SeqScan');

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
          const fetched = ctx.pool.fetch(page.pageId);
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
    close: releasePage,
  };
}

function indexScan(plan: Extract<Plan, { op: 'IndexScan' }>, ctx: ExecContext): Operator {
  let row: Row | null = null;
  let done = false;
  const produced = counter(ctx, 'IndexScan');

  return {
    name: 'IndexScan',
    open() {
      if (!ctx.tree) return;
      const { pointer } = emitIndexLookup(
        ctx.emit,
        ctx.tree,
        plan.key,
        ctx.pool,
        plan.column,
        ctx.locks,
      );
      if (!pointer) return;

      const page = ctx.heap.pages.find((p) => p.pageId === pointer.pageId);
      row = page?.rows[pointer.slot] ?? null;
    },
    next() {
      if (done || !row) return null;
      done = true;

      if (!passes(plan.residual, row)) {
        ctx.emit(
          'The row the index found fails the rest of the predicate, so it is discarded. The index narrowed the search; it did not verify the whole condition.',
          { stage: 'execute', op: 'IndexScan', rowsProduced: 0 },
        );
        return null;
      }

      produced('IndexScan returns the single row the lookup pointed at.');
      return row;
    },
    close() {
      row = null;
    },
  };
}

function filter(predicate: Expr, child: Operator, ctx: ExecContext): Operator {
  const produced = counter(ctx, 'Filter');
  let rejected = 0;

  return {
    name: 'Filter',
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
          `Filter passes a row through${rejected > 0 ? `, having rejected ${rejected}` : ''}.`,
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
 * (plan.md §22.2 — the point of comparison for a future sort aggregate).
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
        rows = externalMergeSort(materialised, (r) => r[plan.column] ?? null, plan.direction, {
          pool: ctx.pool,
          emit: ctx.emit,
          base: pageCountFor(ctx.heap, ctx.tree),
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
 */
function limit(count: number, child: Operator, ctx: ExecContext): Operator {
  const produced = counter(ctx, 'Limit');
  let taken = 0;
  let stopped = false;

  return {
    name: 'Limit',
    open: child.open,
    next() {
      if (stopped || taken >= count) return null;
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

/** Turns a plan tree into an operator tree of the same shape. */
export function buildOperator(plan: Plan, ctx: ExecContext): Operator {
  switch (plan.op) {
    case 'SeqScan':
      return seqScan(plan, ctx);
    case 'IndexScan':
      return indexScan(plan, ctx);
    case 'Filter':
      return filter(plan.predicate, buildOperator(plan.child, ctx), ctx);
    case 'HashAggregate':
      return hashAggregate(plan, buildOperator(plan.child, ctx), ctx);
    case 'Sort':
      return sort(plan, buildOperator(plan.child, ctx), ctx);
    case 'Project':
      return project(plan.columns, buildOperator(plan.child, ctx), ctx);
    case 'Limit':
      return limit(plan.count, buildOperator(plan.child, ctx), ctx);
  }
}
