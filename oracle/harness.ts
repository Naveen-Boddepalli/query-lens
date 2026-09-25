/**
 * Runs a generated session against QueryLens and SQLite and reports the first
 * disagreement as a message that carries the exact SQL, so a failing
 * `fast-check` counterexample is a paste-able reproduction.
 */

import type { DatabaseSync } from 'node:sqlite';
import { runQuery } from '../src/engine/runQuery.ts';
import { columnsOfIndex, leafChain, node, validate, valuesOf } from '../src/engine/index/index.ts';
import type { BPlusTree, LeafNode } from '../src/engine/index/index.ts';
import { DEFAULT_ENGINE_OPTIONS } from '../src/engine/types.ts';
import type { Database, EngineOptions, RunResult, Row } from '../src/engine/types.ts';
import { multisetDiff, sequenceDiff, subMultisetDiff } from './compare.ts';
import type { Tuple } from './compare.ts';
import { isWrite, outputKeys, renderQuery } from './model.ts';
import type { Query, ReadQuery, TableSpec, WriteQuery } from './model.ts';
import { sqliteRead, sqliteTable, sqliteWith, sqliteWrite, tupleOf } from './sqlite.ts';

export function toDatabase(tables: readonly TableSpec[], indexed = true): Database {
  const db: Database = { tables: {} };
  for (const t of tables) {
    db.tables[t.name] = {
      name: t.name,
      columns: t.columns.map((c) => c.name),
      rows: t.rows.map((r) => ({ ...r })),
      ...(indexed && t.indexed.length > 0 ? { indexedColumns: [...t.indexed] } : {}),
      ...(indexed && ((t.composite?.length ?? 0) > 0 || (t.unique?.length ?? 0) > 0)
        ? {
            indexes: [
              ...(t.composite ?? []).map((columns) => ({ columns: [...columns] })),
              ...(t.unique ?? []).map((column) => ({ columns: [column], unique: true })),
            ],
          }
        : {}),
    };
  }
  return db;
}

/**
 * After a write, is every index it maintained still a sound B+Tree holding exactly the values of the rows the
 * table has now? Each statement rebuilds its indexes from the rows, so a tree that was maintained *wrongly* by
 * `INSERT`/`UPDATE`/`DELETE` would otherwise never be noticed — it is thrown away before the next query reads it.
 * (Counts and values, not addresses: the executors leave a deleted row's slot in place rather than compacting.)
 */
export function checkIndexes(trees: Record<string, BPlusTree>, rows: readonly Row[]): string | null {
  for (const [name, tree] of Object.entries(trees)) {
    const columns = columnsOfIndex(name);
    const problems = validate(tree);
    if (problems.length > 0) return `the index on ${name} is not a sound B+Tree after the write: ${problems[0]}`;

    // Whole keys, not just the leading column: a composite index holds one entry per row, valued by every column.
    const held = new Map<string, number>();
    for (const id of leafChain(tree)) {
      for (const key of (node(tree, id) as LeafNode).keys) {
        const value = JSON.stringify(valuesOf(key));
        held.set(value, (held.get(value) ?? 0) + 1);
      }
    }
    const want = new Map<string, number>();
    for (const row of rows) {
      const values = columns.map((c) => row[c] ?? null);
      // A NULL leading column is never indexed; a NULL further along is an ordinary entry.
      if (values[0] !== null) want.set(JSON.stringify(values), (want.get(JSON.stringify(values)) ?? 0) + 1);
    }
    for (const value of new Set([...held.keys(), ...want.keys()])) {
      if ((held.get(value) ?? 0) !== (want.get(value) ?? 0)) {
        return `the index on ${name} holds ${String(held.get(value) ?? 0)} entries for ${value}, but the table has ${String(want.get(value) ?? 0)} such rows`;
      }
    }
  }
  return null;
}

/** QueryLens's result rows as positional tuples, in the query's SELECT-list order. */
export function qlTuples(q: ReadQuery, tables: readonly TableSpec[], rows: readonly Row[]): Tuple[] {
  const keys = outputKeys(q, tables);
  return rows.map((r) => tupleOf(r, keys));
}

export class Disagreement extends Error {
  constructor(sql: string, detail: string) {
    super(`${detail}\n  SQL: ${sql}`);
    this.name = 'Disagreement';
  }
}

export interface OracleRun {
  options?: EngineOptions;
}

const withoutLimit = (q: ReadQuery): ReadQuery => {
  const { limit: _limit, offset: _offset, ...rest } = q;
  return rest;
};

/** Index of the ORDER BY column within the SELECT list, or -1 when it is not projected (or there is no ORDER BY). */
function orderKeyIndex(q: ReadQuery, tables: readonly TableSpec[]): number {
  if (q.kind !== 'select' || !q.order) return -1;
  return outputKeys(q, tables).indexOf(q.order.ref.name);
}

/** `null` when QueryLens's answer to a read agrees with SQLite's; otherwise why not. */
export function checkRead(q: ReadQuery, tables: readonly TableSpec[], ql: readonly Tuple[], lite: DatabaseSync): string | null {
  const limited = sqliteRead(lite, renderQuery(q, 'sqlite'));
  const keyAt = orderKeyIndex(q, tables);

  if (q.limit === undefined) {
    const bag = multisetDiff(ql, limited);
    if (bag) return bag;
    if (keyAt >= 0) {
      const seq = sequenceDiff(ql.map((t) => t[keyAt]!), limited.map((t) => t[keyAt]!));
      if (seq) return `ORDER BY ${q.kind === 'select' ? q.order!.ref.name : ''}: ${seq}`;
    }
    return null;
  }

  // A LIMIT picks *some* rows of the full result unless an ORDER BY fixes which: the count is
  // always defined, the rows must come from the unlimited result, and — when ordered and the
  // key is visible — the *keys* of the first n rows are defined even where ties make the rows not.
  if (ql.length !== limited.length) return `LIMIT ${q.limit} returned ${ql.length} rows, expected ${limited.length}`;
  const unlimited = sqliteRead(lite, renderQuery(withoutLimit(q), 'sqlite'));
  const sub = subMultisetDiff(ql, unlimited);
  if (sub) return sub;
  if (keyAt >= 0) {
    const seq = sequenceDiff(ql.map((t) => t[keyAt]!), limited.map((t) => t[keyAt]!));
    if (seq) return `ORDER BY … LIMIT: ${seq}`;
  }
  return null;
}

function writeCount(result: RunResult): number {
  const w = result.write;
  if (!w) return -1;
  return w.kind === 'insert' ? w.insertedCount : w.kind === 'delete' ? w.deletedCount : w.updatedCount;
}

/** `null` when a write's effect on the table (and its reported row count) agrees with SQLite's. */
export function checkWrite(q: WriteQuery, table: TableSpec, result: RunResult, lite: DatabaseSync): string | null {
  const changes = sqliteWrite(lite, renderQuery(q, 'sqlite'));
  if (writeCount(result) !== changes) return `${q.kind} touched ${writeCount(result)} rows in QueryLens, ${changes} in SQLite`;
  const cols = table.columns.map((c) => c.name);
  const after = (result.write?.rows ?? []).map((r) => tupleOf(r, cols));
  const diff = multisetDiff(after, sqliteTable(lite, table));
  return diff ? `table contents after the ${q.kind}: ${diff}` : null;
}

/** Applies a write's outcome to the running specs — the same "caller persists `write.rows`" the UI does. */
export function applyWrite(tables: TableSpec[], q: WriteQuery, result: RunResult): TableSpec[] {
  return tables.map((t) => (t.name === q.table && result.write ? { ...t, rows: result.write.rows } : t));
}

/** Runs every step of a session against both engines, throwing a `Disagreement` on the first mismatch. */
export function runSession(tablesIn: readonly TableSpec[], steps: readonly Query[], options: EngineOptions = DEFAULT_ENGINE_OPTIONS): void {
  let tables = [...tablesIn];
  const lite = sqliteWith(tables);
  try {
    for (const q of steps) {
      const sql = renderQuery(q);
      let left: Record<string, BPlusTree> = {};
      const result = runQuery(sql, toDatabase(tables), options, { afterWrite: (trees) => { left = trees; } });
      if (result.error) throw new Disagreement(sql, `QueryLens rejected a statement SQLite accepts: ${result.error.message}`);

      if (isWrite(q)) {
        const table = tables.find((t) => t.name === q.table)!;
        const why = checkWrite(q, table, result, lite);
        if (why) throw new Disagreement(sql, why);
        const broken = checkIndexes(left, result.write!.rows);
        if (broken) throw new Disagreement(sql, broken);
        tables = applyWrite(tables, q, result);
      } else {
        const why = checkRead(q, tables, qlTuples(q, tables, result.rows), lite);
        if (why) throw new Disagreement(sql, why);
      }
    }
  } finally {
    lite.close();
  }
}
