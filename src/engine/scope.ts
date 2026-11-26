/**
 * Table aliases (plan.md §27.5 S7). A SELECT may name a table under another name — `FROM employees AS e` — so that one
 * table can appear twice (a self-join) or in its own subquery. From the parser on, the query's own names are all there
 * is: a `TableRef`'s `name` is the alias and `source` the stored table. This module is the one place that maps back.
 */

import { existsNodesIn } from './exists.ts';
import type { SelectStatement } from './parser/index.ts';
import type { Database, Table } from './types.ts';

/**
 * `db`, with every table a SELECT names by an alias (plan.md §27.5 S7) under that name as well — a copy of the stored
 * table, saying which (`source`). From here on the query's own names are all there is: the plan, the joined row's
 * keys and the column checks read the alias, and only laying out pages asks what it is a copy of. A reference whose
 * stored table does not exist is left out, so the ordinary "no table called X" reports it. Subqueries that run as
 * queries of their own (`IN`, scalar) are handed the real `db`, and scope their own names.
 */
export function scopedDatabase(ast: SelectStatement, db: Database): Database {
  const refs = [ast.from, ...(ast.joins ?? []).map((j) => j.table), ...existsNodesIn(ast.where).map((e) => e.subquery.from)];
  const aliased = refs.filter((ref) => ref.source !== undefined && db.tables[ref.source] !== undefined);
  if (aliased.length === 0) return db;
  const tables = { ...db.tables };
  for (const ref of aliased) tables[ref.name] = { ...db.tables[ref.source!]!, name: ref.name, source: ref.source! };
  return { ...db, tables };
}

/** The stored table whose pages a query's table reads — itself, or what its alias stands for (plan.md §27.5 S7). */
export const storedTable = (table: Table, db: Database): Table => (table.source === undefined ? table : (db.tables[table.source] ?? table));
