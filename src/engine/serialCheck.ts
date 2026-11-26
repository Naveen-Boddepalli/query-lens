/**
 * Did a schedule behave as if its transactions had run one at a time (plan.md §25.4 D6)? Whatever the protocol, the
 * answer is the same question put to its record: take the transactions that committed, run them one after another on
 * a fresh database in the order a serial schedule would have put them, and compare. Two things have to agree — the
 * table that is left, and what each of those transactions *read*. The second matters: write skew leaves a table that
 * a serial run could also have left, and is only caught because each transaction saw something no serial run would
 * have shown it.
 *
 * This is a check on one run, not a proof about the protocol. It is held against fuzzed schedules in the tests.
 */

import { runQuery } from './runQuery.ts';
import { createAccountsDatabase } from './seed.ts';
import type { ScheduleResult } from './schedule.ts';
import type { Database, Row } from './types.ts';

/** What became of a transaction: it finished its own way, or the protocol ended it, or it was never ended. */
export type Fate = 'committed' | 'rolled-back' | 'aborted' | 'open';

export interface TransactionOutcome {
  session: string;
  /**
   * The statements that ran in it, in order, with the rows each returned and where in the run's record each ran.
   * Statements that failed are not here.
   */
  statements: { sql: string; rows: Row[]; write: boolean; at: number }[];
  fate: Fate;
  /** Why the protocol ended it, for `aborted`. */
  reason?: string;
  /** Where in the run's record it began (a statement outside a transaction is its own transaction), and where it ended. */
  began: number;
  ended: number;
  /** True when the session wrote `BEGIN`; false for a statement that ran on its own. */
  explicit: boolean;
  /** False for a transaction that only ever read, whatever its fate. */
  writes: boolean;
}

/** Every transaction of a run, in the order they were *decided*. A statement outside a transaction is one of its own. */
export function transactionsOf(result: ScheduleResult): TransactionOutcome[] {
  const open = new Map<string, TransactionOutcome>();
  const out: TransactionOutcome[] = [];
  const settle = (txn: TransactionOutcome, fate: Fate, at: number, reason?: string) => {
    txn.fate = fate;
    txn.ended = at;
    if (reason !== undefined) txn.reason = reason;
    out.push(txn);
  };

  result.steps.forEach((r, at) => {
    if (r.phase === 'queued' || r.phase === 'blocked') return;
    const txn = open.get(r.session);
    if (r.kind === 'begin') {
      if (r.notes.some((n) => n.includes('begins'))) {
        open.set(r.session, {
          session: r.session,
          statements: [],
          fate: 'open',
          began: at,
          ended: at,
          explicit: true,
          writes: false,
        });
      }
      return;
    }
    if (r.phase === 'victim') {
      if (txn) {
        settle(txn, 'aborted', at, r.error);
        open.delete(r.session);
      } else if (r.kind === 'statement') {
        out.push({
          session: r.session,
          statements: [],
          fate: 'aborted',
          reason: r.error ?? 'refused by the protocol',
          began: at,
          ended: at,
          explicit: false,
          writes: false,
        });
      }
      return;
    }
    if (r.kind === 'commit') {
      if (txn) {
        settle(txn, 'committed', at);
        open.delete(r.session);
      }
      return;
    }
    if (r.kind === 'rollback') {
      if (txn) {
        settle(txn, 'rolled-back', at);
        open.delete(r.session);
      }
      return;
    }
    if (r.kind === 'statement' && r.error === undefined && r.run !== undefined) {
      const done = { sql: r.sql, rows: r.rows, write: r.run.write !== undefined, at };
      if (txn) {
        txn.statements.push(done);
        if (done.write) txn.writes = true;
      } else {
        out.push({
          session: r.session,
          statements: [done],
          fate: 'committed',
          began: at,
          ended: at,
          explicit: false,
          writes: done.write,
        });
      }
    }
  });
  for (const txn of open.values()) out.push({ ...txn, fate: 'open' });
  return out;
}

export interface SerialCheck {
  /** The table a serial run of the committed transactions leaves, in the natural order asked for — `accounts`, or the start's first table. */
  rows: Row[];
  /** True when every table that is left, ignoring row order, is the one that serial run leaves. */
  sameTable: boolean;
  /** The first statement that serial run would have answered differently, if any. */
  differentRead: { session: string; sql: string; saw: Row[]; serialSaw: Row[] } | null;
  /** The committed transactions' sessions, in the natural order. */
  order: string[];
  /**
   * Whether *some* one-at-a-time order of the committed transactions explains the run: the same table is left, and
   * every statement of every one of them returned and affected what it did. The natural order is tried first, then
   * the other natural order, then a search.
   */
  serializable: boolean;
  /** The sessions in the order that worked, when one was found. */
  found: string[] | null;
  /**
   * True when `serializable: false` is a proof: the search covered every order that could have worked. False when it
   * was cut off, and the answer is only that none was found.
   */
  exhaustive: boolean;
}

const canonical = (rows: readonly Row[]): string[] => rows.map((r) => JSON.stringify(r)).sort();
const sameRows = (a: readonly Row[], b: readonly Row[]): boolean => {
  const x = canonical(a);
  const y = canonical(b);
  return x.length === y.length && x.every((v, i) => v === y[i]);
};
const stateKey = (db: Database): string =>
  JSON.stringify(Object.entries(db.tables).map(([name, table]) => [name, canonical(table.rows)]));

/**
 * Runs one transaction's statements on `db`, in order. `ok` is false once a statement answers differently from the
 * way it did in the run; with `stop` the replay ends there, otherwise it carries on applying writes so that the
 * table it leaves is still the one this order leaves.
 */
function replay(
  db: Database,
  txn: TransactionOutcome,
  stop: boolean,
): { db: Database; ok: boolean; different: SerialCheck['differentRead'] } {
  let now = db;
  let different: SerialCheck['differentRead'] = null;
  for (const statement of txn.statements) {
    const run = runQuery(statement.sql, now);
    if (different === null && !sameRows(run.rows, statement.rows)) {
      different = { session: txn.session, sql: statement.sql, saw: statement.rows, serialSaw: run.rows };
      if (stop) return { db: now, ok: false, different };
    }
    if (run.write) {
      const table = now.tables[run.write.table]!;
      now = { tables: { ...now.tables, [run.write.table]: { ...table, rows: run.write.rows } } };
    }
  }
  return { db: now, ok: different === null, different };
}

/** How many single-transaction replays the search may spend before it gives up. */
const SEARCH_BUDGET = 4000;

/**
 * Replays the committed transactions serially. `order` says which natural serial order to report on: when they
 * *committed* (what locking, validation and snapshots promise), or when they *began* (what timestamp ordering
 * promises). The verdict is wider than either: serializable if any order works.
 */
export function serialCheck(
  result: ScheduleResult,
  rows: number,
  order: 'commit' | 'begin' = 'commit',
  start: Database = createAccountsDatabase(rows),
  budget: number = SEARCH_BUDGET,
): SerialCheck {
  const committed = transactionsOf(result).filter((t) => t.fate === 'committed');
  // Every table of the database the run started from — `accounts` here, `test` for a Hermitage schedule (plan.md §27.5
  // T1 holds its precedence graph against this check on those too).
  const names = Object.keys(start.tables);
  const main = names.includes('accounts') ? 'accounts' : (names[0] ?? 'accounts');
  const sameState = (db: Database): boolean =>
    names.every((name) => sameRows(result.committed.tables[name]?.rows ?? [], db.tables[name]?.rows ?? []));
  const byCommit = [...committed].sort((a, b) => a.ended - b.ended);
  const byBegin = [...committed].sort((a, b) => a.began - b.began);

  const attempt = (txns: TransactionOutcome[]) => {
    let db = start;
    let different: SerialCheck['differentRead'] = null;
    for (const txn of txns) {
      const r = replay(db, txn, false);
      db = r.db;
      if (different === null) different = r.different;
    }
    return { db, different };
  };

  const natural = attempt(order === 'begin' ? byBegin : byCommit);
  const naturalRows = natural.db.tables[main]?.rows ?? [];
  const sameTable = sameState(natural.db);
  const base = {
    rows: naturalRows,
    sameTable,
    differentRead: natural.different,
    order: (order === 'begin' ? byBegin : byCommit).map((t) => t.session),
  };
  if (sameTable && natural.different === null) {
    return { ...base, serializable: true, found: base.order, exhaustive: true };
  }

  const other = attempt(order === 'begin' ? byCommit : byBegin);
  if (sameState(other.db) && other.different === null) {
    const found = (order === 'begin' ? byCommit : byBegin).map((t) => t.session);
    return { ...base, serializable: true, found, exhaustive: true };
  }

  // Neither natural order explains it. Look for any order, extending only prefixes whose every statement agrees, and
  // remembering (set of transactions placed, table) pairs already shown to lead nowhere.
  let left = budget;
  let exhaustive = true;
  const failed = new Set<string>();
  const place = (db: Database, placed: number[], mask: bigint): number[] | null => {
    if (placed.length === committed.length) return sameState(db) ? placed : null;
    const key = `${String(mask)}|${stateKey(db)}`;
    if (failed.has(key)) return null;
    for (let i = 0; i < committed.length; i += 1) {
      if ((mask >> BigInt(i)) & 1n) continue;
      if (left <= 0) {
        exhaustive = false;
        return null;
      }
      left -= 1;
      const r = replay(db, committed[i]!, true);
      if (!r.ok) continue;
      const found = place(r.db, [...placed, i], mask | (1n << BigInt(i)));
      if (found) return found;
      if (!exhaustive) return null;
    }
    failed.add(key);
    return null;
  };
  const found = place(start, [], 0n);
  return {
    ...base,
    serializable: found !== null,
    found: found === null ? null : found.map((i) => committed[i]!.session),
    exhaustive,
  };
}
