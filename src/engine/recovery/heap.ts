/**
 * The SQL engine's tables as the write-ahead-log machine's pages (plan.md §25.4 E4). The engine holds a table as an
 * array of rows and nothing between calls; the machine holds pages of cells with LSNs. This is the bridge between
 * them, and nothing else: a row is one cell, as its JSON text, on the page the engine's own heap layout puts it on
 * (`rowsPerPage` rows to a page, in table order), and a slot with no row in it is `null`.
 *
 * A row keeps its slot — its *rid* — for as long as the table is the same table, so a delete leaves a tombstone, not a
 * hole the later rows slide into, and an update changes one cell. An insert takes the next spare slot, and a table has a
 * handful of those: the machine's pages are fixed when it starts, so a heap cannot grow a page it did not begin with.
 *
 * Imports types only, so the Playground can carry it without carrying the machine.
 */

import type { Database, Row } from '../types.ts';
import type { Cell, PageId, WalStep } from './wal.ts';

/** Empty slots after each table's last row, for `INSERT`s. */
export const SPARE_SLOTS = 8;

/** The most steps one statement may cost the log: a statement that changes more rows than this is refused. */
export const MAX_ROWS_PER_STATEMENT = 60;

export interface HeapTable {
  /** The first page of this table's heap. */
  base: PageId;
  /** Slots in all: the rows the table began with and the spare ones. */
  slots: number;
  /** The slot of each row the table has now, in table order. */
  rids: number[];
  /** The slot the next insert takes. */
  nextRid: number;
}

export interface DurableHeap {
  rowsPerPage: number;
  tables: Record<string, HeapTable>;
}

export const cellKey = (table: string, rid: number): string => `${table}#${String(rid)}`;

export function pageOf(heap: DurableHeap, table: string, rid: number): PageId {
  return heap.tables[table]!.base + Math.floor(rid / heap.rowsPerPage);
}

/** Which table a page belongs to, or null for a page that is not in the heap. */
export function tableOfPage(heap: DurableHeap, page: PageId): string | null {
  for (const [name, t] of Object.entries(heap.tables)) {
    const pages = Math.ceil(t.slots / heap.rowsPerPage);
    if (page >= t.base && page < t.base + pages) return name;
  }
  return null;
}

/** Lays the database out: the heap's shape and the pages the machine starts with, every row on disk. */
export function openHeap(
  db: Database,
  rowsPerPage: number,
): { heap: DurableHeap; pages: Record<PageId, Record<string, Cell>> } {
  const perPage = Math.max(1, Math.floor(rowsPerPage));
  const heap: DurableHeap = { rowsPerPage: perPage, tables: {} };
  const pages: Record<PageId, Record<string, Cell>> = {};
  let next = 1;
  for (const name of Object.keys(db.tables).sort()) {
    const rows = db.tables[name]!.rows;
    const slots = rows.length + SPARE_SLOTS;
    heap.tables[name] = { base: next, slots, rids: rows.map((_, i) => i), nextRid: rows.length };
    for (let rid = 0; rid < slots; rid += 1) {
      const page = next + Math.floor(rid / perPage);
      (pages[page] ??= {})[cellKey(name, rid)] = rid < rows.length ? JSON.stringify(rows[rid]) : null;
    }
    next += Math.ceil(slots / perPage);
  }
  return { heap, pages };
}

const sameRow = (a: Row | undefined, b: Row | undefined): boolean =>
  a === b || (a !== undefined && b !== undefined && JSON.stringify(a) === JSON.stringify(b));

export type WriteKind = 'insert' | 'update' | 'delete';

export type WriteSteps =
  | { ok: true; steps: WalStep[]; heap: DurableHeap; changed: number }
  | { ok: false; error: string };

/**
 * The log steps for one statement run as transaction `txn`: a `begin` and a `set` for each row it changed. `before`
 * and `after` are the table's rows around the statement, which is all the engine reports of a write.
 */
export function writeSteps(
  heap: DurableHeap,
  txn: string,
  table: string,
  kind: WriteKind,
  before: readonly Row[],
  after: readonly Row[],
): WriteSteps {
  const t = heap.tables[table];
  if (!t) return { ok: false, error: `There is no table ${table} in the durable heap.` };
  if (before.length !== t.rids.length) {
    return { ok: false, error: `The heap has ${String(t.rids.length)} rows of ${table} and the statement saw ${String(before.length)}.` };
  }
  const sets: { rid: number; value: Cell }[] = [];
  const rids = [...t.rids];
  let nextRid = t.nextRid;

  if (kind === 'update') {
    if (after.length !== before.length) return { ok: false, error: 'An update changed the number of rows.' };
    after.forEach((row, i) => {
      if (!sameRow(before[i], row)) sets.push({ rid: t.rids[i]!, value: JSON.stringify(row) });
    });
  } else if (kind === 'delete') {
    const kept: number[] = [];
    let j = 0;
    for (let i = 0; i < before.length; i += 1) {
      if (j < after.length && sameRow(before[i], after[j])) {
        kept.push(t.rids[i]!);
        j += 1;
      } else {
        sets.push({ rid: t.rids[i]!, value: null });
      }
    }
    if (j !== after.length) return { ok: false, error: 'A delete left rows the heap could not match to its own.' };
    rids.length = 0;
    rids.push(...kept);
  } else {
    if (after.length < before.length || !before.every((row, i) => sameRow(row, after[i]))) {
      return { ok: false, error: 'An insert changed rows that were already there.' };
    }
    for (const row of after.slice(before.length)) {
      if (nextRid >= t.slots) {
        return {
          ok: false,
          error: `The durable heap of ${table} has room for ${String(SPARE_SLOTS)} inserted rows, and they are used. It cannot grow a page it did not start with.`,
        };
      }
      sets.push({ rid: nextRid, value: JSON.stringify(row) });
      rids.push(nextRid);
      nextRid += 1;
    }
  }

  if (sets.length > MAX_ROWS_PER_STATEMENT) {
    return {
      ok: false,
      error: `This statement changes ${String(sets.length)} rows, and the log keeps up to ${String(MAX_ROWS_PER_STATEMENT)} per statement.`,
    };
  }
  const steps: WalStep[] = [
    { op: 'begin', txn },
    ...sets.map((s): WalStep => ({ op: 'set', txn, key: cellKey(table, s.rid), value: s.value })),
  ];
  return {
    ok: true,
    steps,
    heap: { ...heap, tables: { ...heap.tables, [table]: { ...t, rids, nextRid } } },
    changed: sets.length,
  };
}

/** The database the cells say: each table's live slots, in slot order, as rows. */
export function databaseFromCells(
  template: Database,
  heap: DurableHeap,
  cells: Record<string, Cell>,
): Database {
  const tables: Database['tables'] = {};
  for (const [name, table] of Object.entries(template.tables)) {
    const t = heap.tables[name];
    if (!t) {
      tables[name] = table;
      continue;
    }
    const rows: Row[] = [];
    for (let rid = 0; rid < t.slots; rid += 1) {
      const cell = cells[cellKey(name, rid)];
      if (typeof cell === 'string') rows.push(JSON.parse(cell) as Row);
    }
    tables[name] = { ...table, rows };
  }
  return { tables };
}

/** The heap's shape for a database whose rows are the cells' live slots: what to carry on with after a recovery. */
export function heapFromCells(heap: DurableHeap, cells: Record<string, Cell>): DurableHeap {
  const tables: DurableHeap['tables'] = {};
  for (const [name, t] of Object.entries(heap.tables)) {
    const rids: number[] = [];
    for (let rid = 0; rid < t.slots; rid += 1) if (typeof cells[cellKey(name, rid)] === 'string') rids.push(rid);
    tables[name] = { ...t, rids, nextRid: rids.length === 0 ? 0 : rids[rids.length - 1]! + 1 };
  }
  return { ...heap, tables };
}
