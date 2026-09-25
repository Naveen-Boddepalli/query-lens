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
import { fetchHeapPage, rowAt } from './operators.ts';
import { passes } from './evaluate.ts';
import { deleteKey, emitIndexLookup, entryKey } from '../index/index.ts';
import type { DeleteStep, RowPointer } from '../index/index.ts';

export interface DeleteOutcome {
  /** The rows removed — value-identical to their entry in `table.rows`. */
  deleted: Row[];
}

interface Match {
  row: Row;
  pointer: RowPointer;
}

/**
 * One clause summarising what a B+Tree delete had to do beyond the plain
 * removal. Exported: `exec/update.ts` reuses it for the "drop the old key"
 * half of a reindex.
 */
export function summarizeSteps(steps: DeleteStep[]): string {
  const rest = steps.slice(1); // steps[0] is always the leaf `remove` itself
  if (rest.length === 0) return 'the leaf stayed at least half full, so nothing else moved';
  return `the tree also had to ${rest.map((s) => s.kind.replace('-', ' ')).join(', then ')}`;
}

/**
 * Removes the entry for the row at `pointer` from every index the table declares, skipping a column whose key is
 * NULL. An entry is the value *and* the row's address, so this drops exactly this row's entry even when other rows
 * share its value.
 */
function deleteFromIndex(ctx: ExecContext, row: Row, pointer: RowPointer): string[] {
  const details: string[] = [];
  for (const column of ctx.table.indexedColumns ?? []) {
    const tree = ctx.trees[column];
    if (!tree) continue;
    const key: SqlValue = row[column] ?? null;
    if (key === null) continue; // NULLs were never indexed — nothing to remove

    const result = deleteKey(tree, entryKey([key], pointer));
    if (!result.found) continue; // defensive: every row here came from the heap this tree indexes
    details.push(
      `The \`${column}\` B+Tree drops key ${JSON.stringify(key)} from leaf ${
        result.steps[0]?.node ?? '?'
      } — ${summarizeSteps(result.steps)}.`,
    );
  }
  return details;
}

/** Every heap page, filtered by `filter` if present — the SeqScan half of a delete. */
function scanForMatches(ctx: ExecContext, filter: Expr | undefined): Match[] {
  const matched: Match[] = [];
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
    page.rows.forEach((row, slot) => {
      if (!passes(filter, row)) return;
      matched.push({ row, pointer: { pageId: page.pageId, slot } });
      touchedPage = true;
      produced += 1;
      ctx.emit(`SeqScan finds a matching row on page ${page.pageId} — DELETE will remove it.`, {
        stage: 'execute',
        op: 'SeqScan',
        rowsProduced: produced,
      });
    });
    if (touchedPage) ctx.pool.markDirty(page.pageId);

    ctx.locks.release(page.pageId, 'exclusive');
  }

  return matched;
}

/** Finds every row an equality lookup points at that passes any residual predicate — one, or one per index entry. */
function indexScanForMatch(ctx: ExecContext, plan: Extract<Plan, { op: 'IndexScan' }>): Match[] {
  const emit = ctx.emit;
  const tree = ctx.trees[plan.column];
  if (!tree) return [];

  const { pointers } = emitIndexLookup(emit, tree, plan.key, ctx.pool, plan.column, ctx.locks);
  const matched: Match[] = [];

  pointers.forEach((pointer, at) => {
    // The lookup already fetched the first match's page; the rest are read now, as their rows are examined.
    if (at > 0) fetchHeapPage(ctx, pointer);
    const row = rowAt(ctx, pointer);
    if (!row) return;

    if (!passes(plan.residual, row)) {
      emit('The row the index found fails the rest of the predicate, so DELETE leaves it alone.', {
        stage: 'execute',
        op: 'IndexScan',
        rowsProduced: matched.length,
      });
      return;
    }

    ctx.locks.acquire(
      pointer.pageId,
      'exclusive',
      `Upgrade to an exclusive lock on heap page ${String(pointer.pageId)} — DELETE is about to remove the row it holds.`,
    );
    ctx.pool.markDirty(pointer.pageId);
    matched.push({ row, pointer });
    emit(
      pointers.length === 1
        ? 'IndexScan finds the one row DELETE will remove.'
        : `IndexScan finds a row DELETE will remove — ${String(matched.length)} so far, of ${String(pointers.length)} entries for this value.`,
      { stage: 'execute', op: 'IndexScan', rowsProduced: matched.length },
    );
    ctx.locks.release(pointer.pageId, 'exclusive');
  });

  return matched;
}

export function executeDelete(plan: Plan, ctx: ExecContext): DeleteOutcome {
  const matched =
    plan.op === 'IndexScan'
      ? indexScanForMatch(ctx, plan)
      : scanForMatches(ctx, plan.op === 'SeqScan' ? plan.filter : undefined);

  let produced = 0;
  for (const { row, pointer } of matched) {
    const indexDetails = deleteFromIndex(ctx, row, pointer);
    produced += 1;
    ctx.emit(
      `Delete removes row ${JSON.stringify(row)}.${indexDetails.length > 0 ? ` ${indexDetails.join(' ')}` : ''}`,
      { stage: 'execute', op: 'Delete', rowsProduced: produced },
    );
  }

  return { deleted: matched.map((m) => m.row) };
}
