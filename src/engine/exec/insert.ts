/**
 * Executes an `INSERT`: writes the new row onto the heap page it lands on —
 * the last page, if it has room, or a fresh one otherwise — and, if the
 * table is indexed, adds its key to the B+Tree with the real `insert`
 * algorithm, real leaf/internal splits included (plan.md §22.2, the write
 * path's second statement).
 *
 * There is no scan and nothing to find, so unlike `DELETE` this needs no
 * find-then-mutate pass: one row, one page, at most one tree insert.
 */

import type { Row, SqlValue } from '../types.ts';
import type { ExecContext } from './operators.ts';
import { height, insert, pageCountFor } from '../index/index.ts';
import type { RowPointer } from '../index/index.ts';

export interface InsertOutcome {
  row: Row;
}

/** Where the new row lands: the last heap page, if it has room, or a fresh one. */
function targetPage(ctx: ExecContext): { pageId: number; slot: number; isNewPage: boolean } {
  const lastPage = ctx.heap.pages[ctx.heap.pages.length - 1]!;
  const hasRoom = lastPage.rows.length < ctx.options.rowsPerPage;
  return hasRoom
    ? { pageId: lastPage.pageId, slot: lastPage.rows.length, isNewPage: false }
    : { pageId: pageCountFor(ctx.heap, ctx.trees), slot: 0, isNewPage: true };
}

/**
 * One clause summarising what the B+Tree insert had to do beyond the plain
 * add. Exported: `exec/update.ts` reuses it for the "add the new key" half
 * of a reindex.
 */
export function summarizeInsert(nodesBefore: number, nodesAfter: number, heightBefore: number, heightAfter: number): string {
  if (nodesAfter === nodesBefore) return 'the leaf had room, so no split was needed';
  const added = nodesAfter - nodesBefore;
  return `a split added ${added} node${added === 1 ? '' : 's'}${
    heightAfter > heightBefore ? `, and the tree grew to height ${heightAfter}` : ''
  }`;
}

/** Adds `row`'s key to every index the table declares, skipping a column whose key is NULL. */
function insertIntoIndex(ctx: ExecContext, row: Row, pointer: RowPointer): void {
  for (const column of ctx.table.indexedColumns ?? []) {
    const tree = ctx.trees[column];
    if (!tree) continue;
    const key: SqlValue = row[column] ?? null;
    if (key === null) continue; // NULLs are never indexed — nothing to add

    const nodesBefore = Object.keys(tree.nodes).length;
    const heightBefore = height(tree);
    insert(tree, key, pointer);
    const nodesAfter = Object.keys(tree.nodes).length;
    const heightAfter = height(tree);

    ctx.emit(
      `The \`${column}\` B+Tree gets key ${JSON.stringify(key)} — ${summarizeInsert(nodesBefore, nodesAfter, heightBefore, heightAfter)}.`,
      { stage: 'execute', op: 'Insert', rowsProduced: 1 },
    );
  }
}

export function executeInsert(row: Row, ctx: ExecContext): InsertOutcome {
  const { pageId, slot, isNewPage } = targetPage(ctx);

  ctx.locks.acquire(
    pageId,
    'exclusive',
    isNewPage
      ? `Take an exclusive lock on page ${pageId} — a fresh page for the new row, since the last one is full.`
      : `Take an exclusive lock on page ${pageId} — INSERT is about to add a row to it.`,
  );

  if (isNewPage) {
    const written = ctx.pool.write(pageId);
    if (written) ctx.pool.unpin(written.frameId);
  } else {
    const fetched = ctx.pool.fetch(pageId);
    if (fetched) ctx.pool.unpin(fetched.frameId);
    ctx.pool.markDirty(pageId);
  }

  ctx.emit(
    isNewPage
      ? `Insert writes the new row onto a fresh page, ${pageId} — the last page was full.`
      : `Insert writes the new row onto page ${pageId}, which had room for it.`,
    { stage: 'execute', op: 'Insert', rowsProduced: 1 },
  );
  ctx.locks.release(pageId, 'exclusive');

  insertIntoIndex(ctx, row, { pageId, slot });

  return { row };
}
