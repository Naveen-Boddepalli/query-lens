/**
 * The Playground's durability log (plan.md §25.4 E4): every write statement run in the Playground, as the log steps a
 * write-ahead log would have made of it, in the order they were run. The Playground keeps this value and nothing runs
 * it until the Durability dialog is opened, so a visitor who never opens it pays only for recording a handful of
 * steps per statement.
 *
 * A statement is a transaction of its own, left open: the Playground shows its own changes at once, as a session sees
 * its own uncommitted work. What becomes of it — commit, roll back, or be lost in a crash — is chosen in the dialog.
 */

import { openHeap, writeSteps } from '../engine/recovery/heap.ts';
import type { DurableHeap, WriteKind } from '../engine/recovery/heap.ts';
import type { Cell, PageId, WalStep } from '../engine/recovery/wal.ts';
import type { Database } from '../engine/types.ts';

/** The most steps the log keeps. The machine runs the whole script each time it is shown, so this is a cost bound. */
export const LOG_MAX_STEPS = 400;

export interface LoggedStatement {
  txn: string;
  sql: string;
  table: string;
  kind: WriteKind;
  /** Rows the statement changed. */
  rows: number;
}

export interface DurableLog {
  /** The database the log began with: its pages are what is on disk before the first statement. */
  base: Database;
  pages: Record<PageId, Record<string, Cell>>;
  heap: DurableHeap;
  steps: WalStep[];
  statements: LoggedStatement[];
  /** The tables as the log believes the Playground holds them: a different database means the log is stale. */
  expected: Database;
  counter: number;
  /** Why the newest write was not logged, if it was not. */
  refused: string | null;
}

export function openLog(db: Database, rowsPerPage: number): DurableLog {
  const { heap, pages } = openHeap(db, rowsPerPage);
  return { base: db, pages, heap, steps: [], statements: [], expected: db, counter: 0, refused: null };
}

const sameRows = (a: Database['tables'][string] | undefined, b: Database['tables'][string] | undefined): boolean =>
  a === b || (a !== undefined && b !== undefined && (a.rows === b.rows || JSON.stringify(a.rows) === JSON.stringify(b.rows)));

/** Whether the Playground still holds the database the log last knew of. */
export function inSync(log: DurableLog, db: Database): boolean {
  const names = Object.keys(log.expected.tables);
  return (
    names.length === Object.keys(db.tables).length &&
    names.every((name) => sameRows(log.expected.tables[name], db.tables[name]))
  );
}

/**
 * Records a write the engine has just made. `before` is the database the statement ran against and `write` what it
 * reported. If the Playground's database was changed some other way since the log last saw it — another dataset, an
 * edit to the data — the log starts again from `before`, because a log of a different database says nothing about
 * this one.
 */
export function recordWrite(
  log: DurableLog,
  before: Database,
  sql: string,
  write: { table: string; kind: WriteKind; rows: Database['tables'][string]['rows'] },
): DurableLog {
  const current = inSync(log, before) ? log : openLog(before, log.heap.rowsPerPage);
  const after: Database = {
    tables: { ...before.tables, [write.table]: { ...before.tables[write.table]!, rows: write.rows } },
  };
  const txn = `Q${String(current.counter + 1)}`;
  const table = before.tables[write.table];
  if (!table) return { ...current, expected: after, refused: `There is no table ${write.table}.` };
  const out = writeSteps(current.heap, txn, write.table, write.kind, table.rows, write.rows);
  if (!out.ok) return { ...current, expected: after, refused: out.error };
  if (current.steps.length + out.steps.length > LOG_MAX_STEPS) {
    return {
      ...current,
      expected: after,
      refused: `The log keeps up to ${String(LOG_MAX_STEPS)} steps and this statement would pass that. Start over from the dialog.`,
    };
  }
  return {
    ...current,
    heap: out.heap,
    steps: [...current.steps, ...out.steps],
    statements: [...current.statements, { txn, sql, table: write.table, kind: write.kind, rows: out.changed }],
    expected: after,
    counter: current.counter + 1,
    refused: null,
  };
}

/** What a visitor decides about the statements: commit one, flush the log, crash, recover. */
export function appendStep(log: DurableLog, step: WalStep): DurableLog {
  if (log.steps.length >= LOG_MAX_STEPS) return { ...log, refused: `The log keeps up to ${String(LOG_MAX_STEPS)} steps.` };
  return { ...log, steps: [...log.steps, step], refused: null };
}

/** The Playground has taken the recovered database as its own: the log goes on from it. */
export function carryOn(log: DurableLog, recovered: Database, heap: DurableHeap): DurableLog {
  return { ...log, expected: recovered, heap };
}
