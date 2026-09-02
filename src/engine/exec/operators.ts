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
import type { Plan, ProjectList } from '../planner/index.ts';
import type { BufferPool, Heap } from '../storage/index.ts';
import type { LockManager } from '../locks/index.ts';
import type { BPlusTree } from '../index/index.ts';
import { emitIndexLookup } from '../index/index.ts';
import { passes } from './evaluate.ts';

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

/** Turns a plan tree into an operator tree of the same shape. */
export function buildOperator(plan: Plan, ctx: ExecContext): Operator {
  switch (plan.op) {
    case 'SeqScan':
      return seqScan(plan, ctx);
    case 'IndexScan':
      return indexScan(plan, ctx);
    case 'Filter':
      return filter(plan.predicate, buildOperator(plan.child, ctx), ctx);
    case 'Project':
      return project(plan.columns, buildOperator(plan.child, ctx), ctx);
  }
}
