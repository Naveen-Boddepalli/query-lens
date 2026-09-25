/**
 * SQLite as the external oracle (plan.md §25.4 A1).
 *
 * `node:sqlite` ships in Node ≥ 22.13 without a flag, so this adds no
 * dependency and no bundle bytes — it is never imported by `src/`.
 */

import { DatabaseSync } from 'node:sqlite';
import type { Row } from '../src/engine/types.ts';
import { cell } from './compare.ts';
import type { Tuple } from './compare.ts';
import type { TableSpec } from './model.ts';

const SQL_TYPE = { int: 'INTEGER', text: 'TEXT', real: 'REAL' } as const;

export function sqliteWith(tables: readonly TableSpec[]): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  for (const t of tables) {
    db.exec(`CREATE TABLE ${t.name} (${t.columns.map((c) => `${c.name} ${SQL_TYPE[c.type]}`).join(', ')})`);
    const insert = db.prepare(`INSERT INTO ${t.name} VALUES (${t.columns.map(() => '?').join(', ')})`);
    for (const row of t.rows) insert.run(...t.columns.map((c) => cell(row[c.name])));
  }
  return db;
}

/** Runs a read and returns positional tuples — SQLite names two `a.id`/`b.id` columns identically, so positions are the only safe key. */
export function sqliteRead(db: DatabaseSync, sql: string): Tuple[] {
  const statement = db.prepare(sql);
  if (typeof statement.setReturnArrays !== 'function') {
    throw new Error('The oracle needs Node ≥ 22.16 (node:sqlite `setReturnArrays`).');
  }
  statement.setReturnArrays(true);
  // `setReturnArrays(true)` makes each row an array at runtime; the typings still say Record.
  return (statement.all() as unknown as unknown[][]).map((r) => r.map((v) => cell(v as never)));
}

/** Runs a write and returns how many rows it changed. */
export function sqliteWrite(db: DatabaseSync, sql: string): number {
  return Number(db.prepare(sql).run().changes);
}

/** The table's full contents in `columns` order — for comparing a write's outcome. */
export function sqliteTable(db: DatabaseSync, table: TableSpec): Tuple[] {
  return sqliteRead(db, `SELECT ${table.columns.map((c) => c.name).join(', ')} FROM ${table.name}`);
}

export function tupleOf(row: Row, columns: readonly string[]): Tuple {
  return columns.map((c) => cell(row[c]));
}
