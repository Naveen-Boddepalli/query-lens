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

import type { Row, SqlValue } from '../types.ts';
import type { Expr, UpdateAssignment } from '../parser/index.ts';
import type { Plan } from '../planner/index.ts';
import type { ExecContext } from './operators.ts';
import { passes } from './evaluate.ts';
import { deleteKey, emitIndexLookup, height, insert } from '../index/index.ts';
import type { RowPointer } from '../index/index.ts';
import { summarizeSteps } from './delete.ts';
import { summarizeInsert } from './insert.ts';

export interface UpdateOutcome {
  /** The matched rows before the update — value-identical to their entry in `table.rows`. */
  before: Row[];
  /** The same rows, in the same order, after the SET assignments applied. */
  after: Row[];
}

interface Match {
  row: Row;
  pointer: RowPointer;
}

/** `row` with every SET assignment applied — a new object; `row` itself is untouched. */
function applyAssignments(row: Row, assignments: UpdateAssignment[]): Row {
  const next: Row = { ...row };
  for (const a of assignments) next[a.column] = a.value.value;
  return next;
}

/**
 * Moves `pointer`'s key from `beforeKey` to `afterKey` in each index whose
 * own column actually changed. NULLs are never indexed, so a key on either
 * side that is NULL just drops the delete or the insert half. A table can
 * have several indexes; an assignment only reindexes the ones whose column
 * it touched, one sentence each.
 */
function reindexRow(ctx: ExecContext, before: Row, after: Row, pointer: RowPointer): string | null {
  const sentences: string[] = [];

  for (const column of ctx.table.indexedColumns ?? []) {
    const tree = ctx.trees[column];
    if (!tree) continue;
    const beforeKey: SqlValue = before[column] ?? null;
    const afterKey: SqlValue = after[column] ?? null;
    if (beforeKey === afterKey) continue; // this index's own column did not change

    const parts: string[] = [];

    if (beforeKey !== null) {
      const removed = deleteKey(tree, beforeKey);
      if (removed.found) {
        parts.push(`drops key ${JSON.stringify(beforeKey)} — ${summarizeSteps(removed.steps)}`);
      }
    }

    if (afterKey !== null) {
      const nodesBefore = Object.keys(tree.nodes).length;
      const heightBefore = height(tree);
      insert(tree, afterKey, pointer);
      const nodesAfter = Object.keys(tree.nodes).length;
      const heightAfter = height(tree);
      parts.push(
        `adds key ${JSON.stringify(afterKey)} — ${summarizeInsert(nodesBefore, nodesAfter, heightBefore, heightAfter)}`,
      );
    }

    if (parts.length > 0) {
      sentences.push(`Because \`${column}\` changed, its B+Tree ${parts.join(', then ')}.`);
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

/** Finds the one row an equality lookup points at, if it passes any residual predicate. */
function indexScanForMatch(ctx: ExecContext, plan: Extract<Plan, { op: 'IndexScan' }>): Match[] {
  const emit = ctx.emit;
  const tree = ctx.trees[plan.column];
  if (!tree) return [];

  const { pointer } = emitIndexLookup(emit, tree, plan.key, ctx.pool, plan.column, ctx.locks);
  if (!pointer) return [];

  const page = ctx.heap.pages.find((p) => p.pageId === pointer.pageId);
  const row = page?.rows[pointer.slot];
  if (!row) return [];

  if (!passes(plan.residual, row)) {
    emit('The row the index found fails the rest of the predicate, so UPDATE leaves it alone.', {
      stage: 'execute',
      op: 'IndexScan',
      rowsProduced: 0,
    });
    return [];
  }

  ctx.locks.acquire(
    pointer.pageId,
    'exclusive',
    `Upgrade to an exclusive lock on heap page ${String(pointer.pageId)} — UPDATE is about to modify the row it holds.`,
  );
  ctx.pool.markDirty(pointer.pageId);
  emit('IndexScan finds the one row UPDATE will modify.', {
    stage: 'execute',
    op: 'IndexScan',
    rowsProduced: 1,
  });
  ctx.locks.release(pointer.pageId, 'exclusive');

  return [{ row, pointer }];
}

export function executeUpdate(plan: Plan, assignments: UpdateAssignment[], ctx: ExecContext): UpdateOutcome {
  const matches =
    plan.op === 'IndexScan'
      ? indexScanForMatch(ctx, plan)
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
