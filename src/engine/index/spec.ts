/**
 * What indexes a table has, as one list (plan.md §25.4 B3).
 *
 * A table declares them two ways: `indexedColumns`, the shorthand for one plain single-column index per name, and
 * `indexes`, for anything richer — today a composite index over several columns. Everything downstream (building
 * the trees, maintaining them on a write, choosing one in the optimizer, pricing a scan of it) wants a single list of
 * indexes, each with a stable name to find its tree by, so this is the one place that reads the two.
 *
 * An index's **name** is its columns joined with `, ` — `id` for a plain one, `lastName, firstName` for a composite
 * one. Column names are identifiers, so the name is unambiguous, and it is what a `Plan` node and `ExecContext.trees`
 * use to say *which* index.
 */

import type { IndexSpec, Table } from '../types.ts';

export const INDEX_NAME_SEPARATOR = ', ';

export const indexNameOf = (columns: readonly string[]): string => columns.join(INDEX_NAME_SEPARATOR);

/** The columns an index name stands for, in key order. */
export const columnsOfIndex = (name: string): string[] => name.split(INDEX_NAME_SEPARATOR);

/** Every index `table` declares: the single-column shorthand first, in declared order, then the richer ones. */
export function indexSpecsOf(table: Pick<Table, 'indexedColumns' | 'indexes'>): IndexSpec[] {
  const byName = new Map<string, IndexSpec>();
  for (const column of table.indexedColumns ?? []) byName.set(column, { columns: [column] });
  for (const spec of table.indexes ?? []) byName.set(indexNameOf(spec.columns), { columns: [...spec.columns] });
  return [...byName.values()];
}

export function findIndexSpec(table: Pick<Table, 'indexedColumns' | 'indexes'>, name: string): IndexSpec | undefined {
  return indexSpecsOf(table).find((spec) => indexNameOf(spec.columns) === name);
}

/**
 * The index a `JOIN` can probe for its inner side's join column: one whose *leading* column is that column — a plain
 * index on it, or a composite one that starts with it (a leftmost prefix of one column is enough to enter it).
 * A plain index wins over a composite one, since its entries are narrower.
 */
export function joinIndexFor(table: Pick<Table, 'indexedColumns' | 'indexes'>, column: string): IndexSpec | undefined {
  const specs = indexSpecsOf(table).filter((spec) => spec.columns[0] === column);
  return specs.find((spec) => spec.columns.length === 1) ?? specs[0];
}
