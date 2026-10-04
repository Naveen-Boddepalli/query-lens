/**
 * plan.md §22.7: a user-authored multi-table `Database` for the Playground's
 * "Custom" data mode — the piece JOIN shipped without. `Database.tables` was
 * already `Record<string, Table>` (§22.2's note when JOIN landed), so nothing
 * in the engine needs to change; the gap was purely a UI for adding tables and
 * columns and declaring an index.
 *
 * Kept local (`localStorage`), not shareable via the URL: `urlState.ts`'s `d=`
 * rows encoding is positional against a column list *already known* from a
 * fixed `DatasetId` (plan.md §15.2's link-size budget depends on that); a
 * custom schema has no such fixed list, so encoding it too would mean sending
 * column *names* down the link as well as values — the size blowup that
 * scheme exists to avoid. A custom database is this browser's own workspace,
 * the same privacy footing as `challengeProgress.ts`/`progress.ts`.
 */
import { createJoinDemoDatabase, tokenize, uniqueViolation } from '../engine/index.ts';
import type { Database, Row, SqlValue, Table } from '../engine/index.ts';

const STORAGE_KEY = 'querylens.customDatabase.v1';

/**
 * A valid table or column name: exactly one `identifier` token and nothing
 * else. Reusing the real tokenizer (rather than a hand-written regex) means
 * this can never drift from what `runQuery` will actually accept — and a SQL
 * keyword tokenizes as `'keyword'`, not `'identifier'`, so `SELECT` or `join`
 * are rejected by this same check with no separate keyword list to maintain.
 */
export function isValidName(name: string): boolean {
  try {
    const tokens = tokenize(name);
    return tokens.length === 2 && tokens[0]?.type === 'identifier' && tokens[0].value === name;
  } catch {
    return false;
  }
}

/** The starter database "Custom" opens on: the same small, joinable pair `/tools/planner` and `/compare` already use, now editable. */
export function starterCustomDatabase(): Database {
  return createJoinDemoDatabase();
}

/** A query that actually exercises the starter's two tables, so JOIN is the very first thing a visitor to Custom sees run. */
export const CUSTOM_STARTER_SQL =
  'SELECT authors.name, posts.title FROM authors JOIN posts ON authors.id = posts.authorId';

function isPlainRow(value: unknown, sortedColumns: readonly string[]): value is Row {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  if (keys.length !== sortedColumns.length || !keys.every((k, i) => k === sortedColumns[i])) return false;
  return Object.values(value as Record<string, unknown>).every(
    (v): v is SqlValue => v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean',
  );
}

function isValidTable(key: string, value: unknown): value is Table {
  if (typeof value !== 'object' || value === null) return false;
  const t = value as Record<string, unknown>;
  if (t.name !== key || !isValidName(key)) return false;
  if (!Array.isArray(t.columns) || t.columns.length === 0) return false;
  if (!t.columns.every((c) => typeof c === 'string' && isValidName(c))) return false;
  const columns = t.columns as string[];
  if (new Set(columns).size !== columns.length) return false;
  const sortedColumns = [...columns].sort();
  if (!Array.isArray(t.rows) || !t.rows.every((r) => isPlainRow(r, sortedColumns))) return false;
  if (t.indexedColumns !== undefined) {
    if (!Array.isArray(t.indexedColumns)) return false;
    if (!t.indexedColumns.every((c) => typeof c === 'string' && columns.includes(c))) return false;
    if (new Set(t.indexedColumns).size !== t.indexedColumns.length) return false;
  }
  if (t.indexes !== undefined) {
    if (!Array.isArray(t.indexes)) return false;
    const specs = t.indexes as unknown[];
    const named = new Set<string>();
    for (const spec of specs) {
      if (typeof spec !== 'object' || spec === null) return false;
      const unique = (spec as { unique?: unknown }).unique;
      if (unique !== undefined && typeof unique !== 'boolean') return false;
      const cols = (spec as { columns?: unknown }).columns;
      if (!Array.isArray(cols) || cols.length === 0) return false;
      if (!cols.every((c) => typeof c === 'string' && columns.includes(c))) return false;
      if (new Set(cols).size !== cols.length) return false;
      const name = cols.join(', ');
      if (named.has(name)) return false;
      named.add(name);
    }
  }
  return true;
}

/** Total, defensive parse of whatever `localStorage` holds — untrusted input, same discipline `parseCsv.ts`/`traceFile.ts` apply, rejected whole on the first mismatch rather than half-applied. */
export function isValidDatabase(value: unknown): value is Database {
  if (typeof value !== 'object' || value === null) return false;
  const tables = (value as { tables?: unknown }).tables;
  if (typeof tables !== 'object' || tables === null || Array.isArray(tables)) return false;
  return Object.entries(tables as Record<string, unknown>).every(([key, table]) => isValidTable(key, table));
}

export function loadCustomDatabase(): Database {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return starterCustomDatabase();
    const parsed: unknown = JSON.parse(raw);
    return isValidDatabase(parsed) ? parsed : starterCustomDatabase();
  } catch {
    return starterCustomDatabase();
  }
}

export function saveCustomDatabase(db: Database): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
  } catch {
    // Quota exceeded, or storage disabled (private browsing) — the autosave
    // is lost, not the session; the in-memory database keeps working.
  }
}

/** Why a candidate table can't be added, or `null` when it's fine. */
export function validateNewTable(
  db: Database,
  spec: { name: string; columns: readonly string[] },
): string | null {
  if (spec.name.trim() === '') return 'Name the table.';
  if (!isValidName(spec.name)) {
    return `"${spec.name}" isn't a valid table name — letters, digits and underscores, starting with a letter, and not a SQL keyword.`;
  }
  if (db.tables[spec.name]) return `A table named "${spec.name}" already exists.`;
  if (spec.columns.length === 0) return 'Add at least one column.';
  const seen = new Set<string>();
  for (const column of spec.columns) {
    if (!isValidName(column)) {
      return `"${column}" isn't a valid column name — letters, digits and underscores, starting with a letter, and not a SQL keyword.`;
    }
    if (seen.has(column)) return `Column "${column}" is listed twice.`;
    seen.add(column);
  }
  return null;
}

/**
 * Composite indexes typed as `a+b, c+d+e` — each index is its columns joined by `+`, in key order, and the indexes are
 * separated by commas (plan.md §25.4 B3b). An index of one column is just the ordinary one, so it is dropped here.
 */
export function parseCompositeIndexes(raw: string): string[][] {
  return raw
    .split(',')
    .map((index) => index.split('+').map((c) => c.trim()).filter((c) => c !== ''))
    .filter((columns) => columns.length > 1);
}

/**
 * `UNIQUE` indexes typed in the same `a+b` syntax, except that one column is a valid index too
 * (`email, team+role` is one on `email` and one on the pair) — plan.md §25.4 B3c.
 */
export function parseUniqueIndexes(raw: string): string[][] {
  return raw
    .split(',')
    .map((index) => index.split('+').map((c) => c.trim()).filter((c) => c !== ''))
    .filter((columns) => columns.length > 0);
}

/** Why a set of composite indexes cannot be declared over `columns`, or `null` when they can. */
export function validateCompositeIndexes(columns: readonly string[], indexes: readonly (readonly string[])[]): string | null {
  const seen = new Set<string>();
  for (const index of indexes) {
    for (const column of index) {
      if (!columns.includes(column)) return `The composite index (${index.join(', ')}) names "${column}", which is not one of the columns.`;
    }
    if (new Set(index).size !== index.length) return `The composite index (${index.join(', ')}) lists a column twice.`;
    const name = index.join(', ');
    if (seen.has(name)) return `The composite index (${name}) is declared twice.`;
    seen.add(name);
  }
  return null;
}

/** A table's indexes in words, for the table lists: `indexed on id, title · composite (a, b)`; empty when it has none. */
export function describeIndexes(table: Pick<Table, 'indexedColumns' | 'indexes'>): string {
  const plain = table.indexedColumns ?? [];
  const uniqueColumns = new Set((table.indexes ?? []).filter((spec) => spec.unique && spec.columns.length === 1).map((spec) => spec.columns[0]!));
  const composite = (table.indexes ?? []).filter((spec) => spec.columns.length > 1 && !spec.unique);
  const unique = (table.indexes ?? []).filter((spec) => spec.unique);
  const single = (table.indexes ?? []).filter((spec) => spec.columns.length === 1 && !spec.unique).map((spec) => spec.columns[0]!);
  // A column declared both plain and unique is described once, as unique.
  const plainOnly = [...plain, ...single].filter((c) => !uniqueColumns.has(c));
  const parts = [
    ...(plainOnly.length > 0 ? [`indexed on ${plainOnly.join(', ')}`] : []),
    ...(composite.length > 0 ? [`composite ${composite.map((spec) => `(${spec.columns.join(', ')})`).join(', ')}`] : []),
    ...(unique.length > 0 ? [`unique ${unique.map((spec) => `(${spec.columns.join(', ')})`).join(', ')}`] : []),
  ];
  return parts.join(' · ');
}

/** Why `db`'s rows cannot sit under the unique indexes they are declared with, or `null` when they can. */
export function validateUniqueRows(db: Database): string | null {
  for (const table of Object.values(db.tables)) {
    const violation = uniqueViolation(table, table.rows);
    if (violation) {
      const key = violation.values.map((v) => (typeof v === 'string' ? `'${v}'` : String(v))).join(', ');
      return `Table "${table.name}" has two rows with (${violation.columns.join(', ')}) = (${key}), but its UNIQUE index on ${violation.index} allows one. Fix the rows, or drop the index.`;
    }
  }
  return null;
}

/** Splits a comma-separated column list into trimmed, non-empty names. */
export function parseColumnList(raw: string): string[] {
  return raw
    .split(',')
    .map((c) => c.trim())
    .filter((c) => c !== '');
}
