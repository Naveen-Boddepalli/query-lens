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

import type { Row } from '../types.ts';
import type { Expr } from '../parser/index.ts';
import type { Plan } from '../planner/index.ts';
import type { ExecContext } from './operators.ts';
import { indexLookupMatches, indexRangeMatches } from './writeScan.ts';
import type { Match, WriteVerb } from './writeScan.ts';
import { passes } from './evaluate.ts';
import { ridOf } from './operators.ts';
import { deleteKey, entryFor, indexNameOf, indexSpecsOf, keyText, keyValuesOf } from '../index/index.ts';
import type { DeleteStep, RowPointer } from '../index/index.ts';

const DELETE: WriteVerb = { name: 'DELETE', does: 'remove' };

export interface DeleteOutcome {
  /** The rows removed — value-identical to their entry in `table.rows`. */
  deleted: Row[];
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
 * Removes the entry for the row at `pointer` from every index the table declares, skipping one whose leading column
 * is NULL. An entry is the values *and* the row's address, so this drops exactly this row's entry even when other
 * rows share its values.
 */
function deleteFromIndex(ctx: ExecContext, row: Row, pointer: RowPointer): string[] {
  const details: string[] = [];
  for (const spec of indexSpecsOf(ctx.table)) {
    const name = indexNameOf(spec.columns);
    const tree = ctx.trees[name];
    if (!tree) continue;
    const values = keyValuesOf(row, spec.columns);
    if (values[0] === null) continue; // a NULL leading column was never indexed — nothing to remove

    const { key } = entryFor(spec.columns, row, pointer, ctx.table.clusteredKey);
    const result = deleteKey(tree, key);
    if (!result.found) continue; // defensive: every row here came from the heap this tree indexes
    details.push(
      `The \`${name}\` B+Tree drops key ${keyText(values)} from leaf ${
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

export function executeDelete(plan: Plan, ctx: ExecContext): DeleteOutcome {
  const matched =
    plan.op === 'IndexScan'
      ? indexLookupMatches(ctx, plan, DELETE)
      : plan.op === 'IndexRangeScan'
        ? indexRangeMatches(ctx, plan, DELETE)
        : scanForMatches(ctx, plan.op === 'SeqScan' ? plan.filter : undefined);

  let produced = 0;
  for (const { row, pointer } of matched) {
    ctx.log?.change(pointer.pageId, ridOf(ctx, pointer), row, null);
    const indexDetails = deleteFromIndex(ctx, row, pointer);
    produced += 1;
    ctx.emit(
      `Delete removes row ${JSON.stringify(row)}.${indexDetails.length > 0 ? ` ${indexDetails.join(' ')}` : ''}`,
      { stage: 'execute', op: 'Delete', rowsProduced: produced },
    );
  }

  return { deleted: matched.map((m) => m.row) };
}
