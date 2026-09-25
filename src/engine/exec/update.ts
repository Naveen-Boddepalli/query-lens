/**
 * Executes an `UPDATE`'s access plan (`SeqScan` or `IndexScan`, from
 * `emitUpdatePlanEvents`) against the real heap and index: finds every
 * matching row exactly the way `DELETE` does, applies the SET assignments to
 * produce its replacement, and — if any assignment touches the indexed
 * column — drops the old key and adds the new one through the real
 * `deleteKey`/`insert` algorithms. Delete-then-reinsert is the only honest
 * way to keep a B+Tree's keys in order when the value they index changes;
 * there is no in-place "rekey" (plan.md §22.2, the write path's last
 * statement).
 *
 * Like `DELETE`, this finds every match before it changes anything — a
 * `SELECT`'s Volcano operators pull one row at a time, but an update mid-scan
 * could shift what a later step reads. It narrates through the same
 * `execute`-stage shape (`SeqScan`/`IndexScan` while finding, then `Update`
 * while applying) that `DELETE` and `INSERT` already use.
 */

import type { Row } from '../types.ts';
import type { Expr, UpdateAssignment } from '../parser/index.ts';
import type { Plan } from '../planner/index.ts';
import type { ExecContext } from './operators.ts';
import { indexLookupMatches, indexRangeMatches } from './writeScan.ts';
import type { Match, WriteVerb } from './writeScan.ts';
import { evaluateValue, passes } from './evaluate.ts';
import { deleteKey, entryKey, height, indexNameOf, indexSpecsOf, insert, keyText, keyValuesOf } from '../index/index.ts';
import type { RowPointer } from '../index/index.ts';
import { summarizeSteps } from './delete.ts';
import { summarizeInsert } from './insert.ts';

const UPDATE: WriteVerb = { name: 'UPDATE', does: 'modify' };

export interface UpdateOutcome {
  /** The matched rows before the update — value-identical to their entry in `table.rows`. */
  before: Row[];
  /** The same rows, in the same order, after the SET assignments applied. */
  after: Row[];
}


/**
 * `row` with every SET assignment applied — a new object; `row` itself is
 * untouched. Every value is evaluated against the row *as it was*, so
 * `SET a = b, b = a` swaps the two rather than copying one over the other
 * (standard SQL, and what plan.md §25.4 B1b's `SET n = n + 1` relies on).
 */
function applyAssignments(row: Row, assignments: UpdateAssignment[]): Row {
  const next: Row = { ...row };
  for (const a of assignments) next[a.column] = evaluateValue(a.value, row);
  return next;
}

/**
 * Moves the row's entry from its old values to its new ones in each index whose own columns actually changed.
 * A NULL leading column is never indexed, so on either side it just drops the delete or the insert half. A table
 * can have several indexes; an assignment only reindexes the ones whose columns it touched, one sentence each.
 */
function reindexRow(ctx: ExecContext, before: Row, after: Row, pointer: RowPointer): string | null {
  const sentences: string[] = [];

  for (const spec of indexSpecsOf(ctx.table)) {
    const name = indexNameOf(spec.columns);
    const tree = ctx.trees[name];
    if (!tree) continue;
    const beforeValues = keyValuesOf(before, spec.columns);
    const afterValues = keyValuesOf(after, spec.columns);
    if (beforeValues.every((v, i) => v === afterValues[i])) continue; // none of this index's columns changed

    const parts: string[] = [];

    if (beforeValues[0] !== null) {
      const removed = deleteKey(tree, entryKey(beforeValues, pointer));
      if (removed.found) {
        parts.push(`drops key ${keyText(beforeValues)} — ${summarizeSteps(removed.steps)}`);
      }
    }

    if (afterValues[0] !== null) {
      const nodesBefore = Object.keys(tree.nodes).length;
      const heightBefore = height(tree);
      insert(tree, entryKey(afterValues, pointer), pointer);
      const nodesAfter = Object.keys(tree.nodes).length;
      const heightAfter = height(tree);
      parts.push(
        `adds key ${keyText(afterValues)} — ${summarizeInsert(nodesBefore, nodesAfter, heightBefore, heightAfter)}`,
      );
    }

    if (parts.length > 0) {
      sentences.push(`Because \`${name}\` changed, its B+Tree ${parts.join(', then ')}.`);
    }
  }

  return sentences.length > 0 ? sentences.join(' ') : null;
}

/** Every heap page, filtered by `filter` if present — the SeqScan half of an update. */
function scanForMatches(ctx: ExecContext, filter: Expr | undefined): Match[] {
  const matched: Match[] = [];
  let produced = 0;

  for (const page of ctx.heap.pages) {
    ctx.locks.acquire(
      page.pageId,
      'exclusive',
      `Take an exclusive lock on page ${String(page.pageId)} — UPDATE may modify a row on it, so a shared lock is not enough.`,
    );
    const fetched = ctx.pool.fetch(page.pageId);
    if (fetched) ctx.pool.unpin(fetched.frameId);

    let touchedPage = false;
    page.rows.forEach((row, slot) => {
      if (!passes(filter, row)) return;
      matched.push({ row, pointer: { pageId: page.pageId, slot } });
      touchedPage = true;
      produced += 1;
      ctx.emit(`SeqScan finds a matching row on page ${page.pageId} — UPDATE will modify it.`, {
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

export function executeUpdate(plan: Plan, assignments: UpdateAssignment[], ctx: ExecContext): UpdateOutcome {
  const matches =
    plan.op === 'IndexScan'
      ? indexLookupMatches(ctx, plan, UPDATE)
      : plan.op === 'IndexRangeScan'
        ? indexRangeMatches(ctx, plan, UPDATE)
        : scanForMatches(ctx, plan.op === 'SeqScan' ? plan.filter : undefined);

  const before: Row[] = [];
  const after: Row[] = [];
  let produced = 0;

  for (const { row, pointer } of matches) {
    const updated = applyAssignments(row, assignments);
    before.push(row);
    after.push(updated);
    produced += 1;

    const indexDetail = reindexRow(ctx, row, updated, pointer);
    ctx.emit(
      `Update changes row ${JSON.stringify(row)} to ${JSON.stringify(updated)}.${
        indexDetail ? ` ${indexDetail}` : ''
      }`,
      { stage: 'execute', op: 'Update', rowsProduced: produced },
    );
  }

  return { before, after };
}
