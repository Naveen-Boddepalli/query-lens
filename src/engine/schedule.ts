/**
 * Schedules (plan.md §25.4 D1): statements from several sessions, in an order the *caller* chose, run against one
 * shared database. The interleaving is an input, so the engine stays pure — the same schedule always produces the same
 * result, and a schedule is a value that can sit in a URL.
 *
 * This is the baseline with **no concurrency control at all**: every statement runs at once against whatever the
 * database holds, including another session's uncommitted writes. `ROLLBACK` is real — each transaction keeps an undo
 * log of the rows it changed and puts them back, newest first — but nothing stops a second session reading a row the
 * first has changed and not committed (a dirty read), or changing it too (a dirty write). The result *names* those
 * when they happen rather than preventing them; enforced locks (D2), isolation levels (D3) and MVCC (D4) are what
 * prevent them, and they plug into this same loop.
 *
 * A statement outside `BEGIN … COMMIT` is its own transaction (autocommit). A statement that fails changes nothing and
 * leaves the transaction open, as MySQL does; PostgreSQL would instead refuse everything until `ROLLBACK`.
 */

import { runQuery } from './runQuery.ts';
import { controlKindOf } from './transactionControl.ts';
import type { ControlKind } from './transactionControl.ts';
import { DEFAULT_ENGINE_OPTIONS } from './types.ts';
import type { Database, EngineOptions, Row, RunResult, Table } from './types.ts';

export interface ScheduleStep {
  session: string;
  sql: string;
}

export type StepKind = ControlKind | 'statement';

/** What a write did to one row, in the terms needed to put it back. Rows are identified by reference, not by value. */
export type UndoEntry =
  | { kind: 'insert'; table: string; row: Row }
  | { kind: 'delete'; table: string; row: Row; index: number }
  | { kind: 'update'; table: string; before: Row; after: Row };

export type AnomalyKind = 'dirty-read' | 'dirty-write';

export interface ScheduleAnomaly {
  kind: AnomalyKind;
  /** The session whose statement exposed it. */
  session: string;
  /** The sessions whose uncommitted changes it touched. */
  against: string[];
  message: string;
}

export interface SessionSnapshot {
  session: string;
  /** The open transaction's number, or null in autocommit. */
  transaction: number | null;
  /** Rows this session has changed and not yet committed. */
  uncommitted: number;
}

export interface ScheduleStepResult {
  index: number;
  session: string;
  sql: string;
  kind: StepKind;
  /** The engine's own run of a statement — its whole trace. Absent for BEGIN, COMMIT and ROLLBACK. */
  run?: RunResult;
  /** What the statement returned (a `SELECT`) or wrote. */
  rows: Row[];
  error?: string;
  /** What this step did to the schedule, in words. */
  notes: string[];
  anomalies: ScheduleAnomaly[];
  /** The shared database after this step, uncommitted changes included. */
  after: Database;
  /** Every session's state after this step. */
  sessions: SessionSnapshot[];
}

export interface ScheduleResult {
  steps: ScheduleStepResult[];
  /** The database as the last step left it, uncommitted changes included. */
  final: Database;
  /** The database with every still-open transaction undone — what would survive a crash. */
  committed: Database;
  /** Sessions whose transaction was never committed or rolled back. */
  open: string[];
  /** True when the schedule was longer than `MAX_SCHEDULE_STEPS` and the rest was ignored. */
  truncated: boolean;
}

/** A hostile or pasted schedule should not hang the tab. Not a security boundary — a size limit. */
export const MAX_SCHEDULE_STEPS = 40;

interface Logged {
  step: number;
  session: string;
  entry: UndoEntry;
}

interface Transaction {
  number: number;
  log: Logged[];
}

const plural = (n: number, word: string) => `${String(n)} ${word}${n === 1 ? '' : 's'}`;

function rowText(row: Row): string {
  return JSON.stringify(row);
}

function withRows(db: Database, table: string, rows: Row[]): Database {
  const target = db.tables[table];
  if (!target) return db;
  const replaced: Table = { ...target, rows };
  return { tables: { ...db.tables, [table]: replaced } };
}

/** Puts `entries` back, in the order given (newest first). Returns what could not be restored, in words. */
function undo(db: Database, entries: readonly Logged[]): { db: Database; notes: string[]; restored: number } {
  let next = db;
  const notes: string[] = [];
  let restored = 0;
  for (const { entry, session: owner } of entries) {
    const table = next.tables[entry.table];
    if (!table) continue;
    const rows = [...table.rows];
    if (entry.kind === 'insert') {
      const at = rows.indexOf(entry.row);
      if (at < 0) {
        notes.push(`${owner}'s inserted row ${rowText(entry.row)} is already gone from ${entry.table}.`);
        continue;
      }
      rows.splice(at, 1);
    } else if (entry.kind === 'delete') {
      rows.splice(Math.min(entry.index, rows.length), 0, entry.row);
    } else {
      const at = rows.indexOf(entry.after);
      if (at < 0) {
        notes.push(
          `${owner}'s change to ${rowText(entry.before)} could not be put back: the row has been changed again since, ` +
            `so there is no longer a row to restore.`,
        );
        continue;
      }
      rows[at] = entry.before;
    }
    next = withRows(next, entry.table, rows);
    restored += 1;
  }
  return { db: next, notes, restored };
}

/** Which of `entries` produced `row`, if it is a row some uncommitted write left behind. */
function producedBy(entries: readonly Logged[], row: Row): Logged | undefined {
  return entries.find(
    ({ entry }) => (entry.kind === 'insert' && entry.row === row) || (entry.kind === 'update' && entry.after === row),
  );
}

/** What a successful write did to `table`, as undo entries — found by comparing the rows before and after. */
function entriesOf(kind: 'insert' | 'delete' | 'update', table: string, before: Row[], after: Row[]): UndoEntry[] {
  const kept = new Set(after);
  const had = new Set(before);
  if (kind === 'insert') {
    return after.filter((row) => !had.has(row)).map((row) => ({ kind: 'insert', table, row }));
  }
  if (kind === 'delete') {
    const entries: UndoEntry[] = [];
    before.forEach((row, index) => {
      if (!kept.has(row)) entries.push({ kind: 'delete', table, row, index });
    });
    return entries;
  }
  const entries: UndoEntry[] = [];
  before.forEach((row, index) => {
    const now = after[index];
    if (now !== undefined && now !== row) entries.push({ kind: 'update', table, before: row, after: now });
  });
  return entries;
}

export function runSchedule(
  schedule: readonly ScheduleStep[],
  db: Database,
  options: EngineOptions = DEFAULT_ENGINE_OPTIONS,
): ScheduleResult {
  const steps = schedule.slice(0, MAX_SCHEDULE_STEPS);
  const transactions = new Map<string, Transaction>();
  const sessionOrder: string[] = [];
  let nextNumber = 1;
  let current = db;
  const results: ScheduleStepResult[] = [];

  const othersOpenLog = (session: string): Logged[] =>
    [...transactions.entries()].filter(([name]) => name !== session).flatMap(([, t]) => t.log);

  const snapshots = (): SessionSnapshot[] =>
    sessionOrder.map((session) => {
      const txn = transactions.get(session);
      return { session, transaction: txn?.number ?? null, uncommitted: txn?.log.length ?? 0 };
    });

  steps.forEach((step, index) => {
    if (!sessionOrder.includes(step.session)) sessionOrder.push(step.session);
    const { session, sql } = step;
    const notes: string[] = [];
    const anomalies: ScheduleAnomaly[] = [];
    let kind: StepKind = 'statement';
    let run: RunResult | undefined;
    let rows: Row[] = [];
    let error: string | undefined;

    const control = controlKindOf(sql);
    const txn = transactions.get(session);

    if (control === 'malformed') {
      kind = 'statement';
      error = 'Transaction control here is BEGIN, COMMIT and ROLLBACK, with nothing after them.';
      notes.push('No effect.');
    } else if (control === 'begin') {
      kind = 'begin';
      if (txn) {
        notes.push(`${session} already has transaction T${String(txn.number)} open — BEGIN changes nothing (PostgreSQL warns the same).`);
      } else {
        const number = nextNumber;
        nextNumber += 1;
        transactions.set(session, { number, log: [] });
        notes.push(`${session} begins transaction T${String(number)}.`);
      }
    } else if (control === 'commit') {
      kind = 'commit';
      if (!txn) {
        notes.push(`${session} has no transaction open — COMMIT changes nothing.`);
      } else {
        notes.push(
          `${session} commits T${String(txn.number)}: its ${plural(txn.log.length, 'change')} ${
            txn.log.length === 1 ? 'is' : 'are'
          } now permanent, and visible to everyone.`,
        );
        transactions.delete(session);
      }
    } else if (control === 'rollback') {
      kind = 'rollback';
      if (!txn) {
        notes.push(`${session} has no transaction open — ROLLBACK changes nothing.`);
      } else {
        const newestFirst = [...txn.log].sort((a, b) => b.step - a.step);
        const undone = undo(current, newestFirst);
        current = undone.db;
        const whole = undone.restored === txn.log.length;
        notes.push(
          `${session} rolls back T${String(txn.number)}: ${
            whole
              ? `${plural(txn.log.length, 'change')} undone`
              : `${String(undone.restored)} of ${plural(txn.log.length, 'change')} could be undone`
          }, newest first.`,
          ...undone.notes,
        );
        transactions.delete(session);
      }
    } else {
      // An ordinary statement. What it *sees* is the shared database exactly as it stands.
      run = runQuery(sql, current, options);
      rows = run.rows;
      if (run.error) {
        error = run.error.message;
        notes.push(
          txn
            ? `No effect, and T${String(txn.number)} stays open.`
            : 'No effect.',
        );
      } else {
        if (run.write) {
          const { table, rows: written } = run.write;
          const before = current.tables[table]?.rows ?? [];
          const entries = entriesOf(run.write.kind, table, before, written);

          // A write to a row somebody else has changed and not committed.
          const others = othersOpenLog(session);
          const clobbered = new Set<string>();
          for (const entry of entries) {
            const touched = entry.kind === 'insert' ? undefined : entry.kind === 'delete' ? entry.row : entry.before;
            const owner = touched ? producedBy(others, touched) : undefined;
            if (owner) clobbered.add(owner.session);
          }
          if (clobbered.size > 0) {
            const against = [...clobbered];
            anomalies.push({
              kind: 'dirty-write',
              session,
              against,
              message: `Dirty write: ${session} changed a row that ${against.join(' and ')} has changed and not committed. Nothing stopped it, and if ${against.join(' or ')} rolls back, there may be nothing left to restore.`,
            });
          }

          current = withRows(current, table, written);
          const verb = run.write.kind === 'insert' ? 'inserted' : run.write.kind === 'delete' ? 'deleted' : 'updated';
          if (txn) {
            for (const entry of entries) txn.log.push({ step: index, session, entry });
            notes.push(`${plural(entries.length, 'row')} ${verb} in ${table}; ${session} has ${plural(txn.log.length, 'uncommitted change')}.`);
          } else {
            notes.push(`${plural(entries.length, 'row')} ${verb} in ${table}, committed at once (autocommit).`);
          }
        } else if (run.analyze) {
          const target = current.tables[run.analyze.table];
          if (target) {
            current = { tables: { ...current.tables, [run.analyze.table]: { ...target, stats: run.analyze.stats } } };
          }
          notes.push(`Statistics for ${run.analyze.table} recorded.`);
        } else {
          notes.push(`${plural(rows.length, 'row')} returned.`);
        }

        // A read that would have returned something else without another session's uncommitted changes.
        const others = othersOpenLog(session);
        if (!run.write && !run.analyze && others.length > 0) {
          const committedView = undo(current, [...others].sort((a, b) => b.step - a.step)).db;
          const clean = runQuery(sql, committedView, options);
          if (!clean.error && JSON.stringify(clean.rows) !== JSON.stringify(rows)) {
            const against = [...new Set(others.map((l) => l.session))];
            anomalies.push({
              kind: 'dirty-read',
              session,
              against,
              message: `Dirty read: ${session} saw changes ${against.join(' and ')} has not committed. Without them this query returns ${
                clean.rows.length === 0 ? 'no rows' : clean.rows.map(rowText).join(', ')
              }; if ${against.join(' or ')} rolls back, ${session} has read data that never existed.`,
            });
          }
        }
      }
    }

    results.push({
      index,
      session,
      sql,
      kind,
      ...(run ? { run } : {}),
      rows,
      ...(error === undefined ? {} : { error }),
      notes,
      anomalies,
      after: current,
      sessions: snapshots(),
    });
  });

  // What would survive a crash: the database with every still-open transaction undone.
  const stillOpen = [...transactions.keys()];
  const allOpen = [...transactions.values()].flatMap((t) => t.log).sort((a, b) => b.step - a.step);
  const committed = undo(current, allOpen).db;

  return {
    steps: results,
    final: current,
    committed,
    open: stillOpen,
    truncated: schedule.length > MAX_SCHEDULE_STEPS,
  };
}
