/**
 * Executes a `DELETE`'s access plan (`SeqScan` or `IndexScan`, from
 * `emitDeletePlanEvents`) against the real heap and index: finds every
 * matching row, drops its key from the B+Tree with the real `deleteKey`
 * algorithm — real borrows, merges, root-collapses, narrated — and marks the
 * heap pages it removed a row from dirty (plan.md §22.2, the write path).
 *
 * A `SELECT` streams rows through Volcano operators one at a time; a
 * `DELETE` cannot — it has to find *every* match before it starts mutating
 * anything, or a deletion mid-scan could shift what a later step reads. So
 * this is its own pass rather than a reuse of `buildOperator`, though it
 * narrates through the same `execute`-stage shape (`op: 'SeqScan'` /
 * `'IndexScan'` as it finds matches, then `op: 'Delete'` as it removes them)
 * so the Execute panel reads the same way a `SELECT`'s does.
 */

import type { Row, SqlValue } from '../types.ts';
import type { Expr } from '../parser/index.ts';
import type { Plan } from '../planner/index.ts';
import type { ExecContext } from './operators.ts';
import { passes } from './evaluate.ts';
import { deleteKey, emitIndexLookup } from '../index/index.ts';
import type { DeleteStep } from '../index/index.ts';

export interface DeleteOutcome {
  /** The rows removed — value-identical to their entry in `table.rows`. */
  deleted: Row[];
}

/** One clause summarising what a B+Tree delete had to do beyond the plain removal. */
function summarizeSteps(steps: DeleteStep[]): string {
  const rest = steps.slice(1); // steps[0] is always the leaf `remove` itself
  if (rest.length === 0) return 'the leaf stayed at least half full, so nothing else moved';
  return `the tree also had to ${rest.map((s) => s.kind.replace('-', ' ')).join(', then ')}`;
}

/** Removes `row`'s key from the tree, if the table is indexed and the key is not NULL. */
function deleteFromIndex(ctx: ExecContext, row: Row): string | null {
  const column = ctx.table.indexedColumn;
  if (!ctx.tree || !column) return null;
  const key: SqlValue = row[column] ?? null;
  if (key === null) return null; // NULLs were never indexed — nothing to remove

  const result = deleteKey(ctx.tree, key);
  if (!result.found) return null; // defensive: every row here came from the heap this tree indexes
  return `The B+Tree drops key ${JSON.stringify(key)} from leaf ${
    result.steps[0]?.node ?? '?'
  } — ${summarizeSteps(result.steps)}.`;
}

/** Every heap page, filtered by `filter` if present — the SeqScan half of a delete. */
function scanForMatches(ctx: ExecContext, filter: Expr | undefined): Row[] {
  const matched: Row[] = [];
  let produced = 0;

  for (const page of ctx.heap.pages) {
    ctx.locks.acquire(
      page.pageId,
      'exclusive',
      `Take an exclusive lock on page ${String(page.pageId)} — DELETE may remove a row from it, so a shared lock is not enough.`,
    );
    const fetched = ctx.pool.fetch(page.pageId);
    if (fetched) ctx.pool.unpin(fetched.frameId);

    let touchedPage = false;
    for (const row of page.rows) {
      if (!passes(filter, row)) continue;
      matched.push(row);
      touchedPage = true;
      produced += 1;
      ctx.emit(`SeqScan finds a matching row on page ${page.pageId} — DELETE will remove it.`, {
        stage: 'execute',
        op: 'SeqScan',
        rowsProduced: produced,
      });
    }
    if (touchedPage) ctx.pool.markDirty(page.pageId);

    ctx.locks.release(page.pageId, 'exclusive');
  }

  return matched;
}

/** Finds the one row an equality lookup points at, if it passes any residual predicate. */
function indexScanForMatch(ctx: ExecContext, plan: Extract<Plan, { op: 'IndexScan' }>): Row[] {
  const emit = ctx.emit;
  if (!ctx.tree) return [];

  const { pointer } = emitIndexLookup(emit, ctx.tree, plan.key, ctx.pool, plan.column, ctx.locks);
  if (!pointer) return [];

  const page = ctx.heap.pages.find((p) => p.pageId === pointer.pageId);
  const row = page?.rows[pointer.slot];
  if (!row) return [];

  if (!passes(plan.residual, row)) {
    emit('The row the index found fails the rest of the predicate, so DELETE leaves it alone.', {
      stage: 'execute',
      op: 'IndexScan',
      rowsProduced: 0,
    });
    return [];
  }

  ctx.locks.acquire(
    pointer.pageId,
    'exclusive',
    `Upgrade to an exclusive lock on heap page ${String(pointer.pageId)} — DELETE is about to remove the row it holds.`,
  );
  ctx.pool.markDirty(pointer.pageId);
  emit('IndexScan finds the one row DELETE will remove.', {
    stage: 'execute',
    op: 'IndexScan',
    rowsProduced: 1,
  });
  ctx.locks.release(pointer.pageId, 'exclusive');

  return [row];
}

export function executeDelete(plan: Plan, ctx: ExecContext): DeleteOutcome {
  const matched =
    plan.op === 'IndexScan'
      ? indexScanForMatch(ctx, plan)
      : scanForMatches(ctx, plan.op === 'SeqScan' ? plan.filter : undefined);

  let produced = 0;
  for (const row of matched) {
    const indexDetail = deleteFromIndex(ctx, row);
    produced += 1;
    ctx.emit(
      `Delete removes row ${JSON.stringify(row)}.${indexDetail ? ` ${indexDetail}` : ''}`,
      { stage: 'execute', op: 'Delete', rowsProduced: produced },
    );
  }

  return { deleted: matched };
}
