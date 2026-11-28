// @vitest-environment node
/**
 * `BEGIN`, `COMMIT` and `ROLLBACK` in the Playground against SQLite (plan.md §28.5 I3). A script of writes, reads and
 * transaction-control statements runs on QueryLens with the write-ahead log on — the Playground's one session — and on
 * SQLite with the same statements. They must accept and refuse the same statements, give every read the same answer
 * (a transaction sees its own changes), and hold the same table after every step: in particular after a `ROLLBACK`,
 * which QueryLens does by undoing the transaction's log records newest first, and SQLite in its own way.
 *
 * A write outside `BEGIN` is, in the Playground, a transaction of its own left open for the *Durability* dialog to
 * decide; SQLite commits it at once. The script commits each such write from the dialog straight after it, which is the
 * one decision that makes the two the same — and leaves every transaction `BEGIN` opens to the script itself.
 */

import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { runQuery } from '../src/engine/runQuery.ts';
import { inSync } from '../src/engine/recovery/engineLog.ts';
import type { EngineLog } from '../src/engine/recovery/engineLog.ts';
import { applyLogOp, loggedRun, openEngineLog } from '../src/engine/recovery/engineLogOps.ts';
import type { Database, EngineOptions } from '../src/engine/types.ts';
import { multisetDiff } from './compare.ts';
import { ORACLE_TIMEOUT, oracleParams } from './config.ts';
import { aliasAwarePool, deleteArb, insertArb, optionsArb, poolOf, selectArb, subSources, tablesArb, updateArb } from './generate.ts';
import { Disagreement, checkRead, qlTuples, toDatabase } from './harness.ts';
import { isWrite, renderQuery } from './model.ts';
import type { Query, ReadQuery, TableSpec } from './model.ts';
import { sqliteTable, sqliteWith, tupleOf } from './sqlite.ts';

vi.setConfig({ testTimeout: ORACLE_TIMEOUT });

type Step = { kind: 'statement'; q: Query } | { kind: 'control'; sql: 'BEGIN' | 'COMMIT' | 'ROLLBACK' };

const control = fc.constantFrom<Step>(
  { kind: 'control', sql: 'BEGIN' },
  { kind: 'control', sql: 'COMMIT' },
  { kind: 'control', sql: 'ROLLBACK' },
);

/** The tables, a physical configuration, a force choice and a script on `t`: about one step in three is control. */
const scriptArb = tablesArb.chain(([t, u, w]) => {
  const pool = aliasAwarePool(poolOf([t, u, w]), t.name);
  const subs = subSources([u, w, t], pool);
  const statement = fc.oneof(
    { weight: 2, arbitrary: insertArb(t) },
    { weight: 3, arbitrary: updateArb(t, pool, subs) },
    { weight: 2, arbitrary: deleteArb(t, pool, subs) },
    { weight: 2, arbitrary: selectArb(t, pool, subs) },
  ).map((q): Step => ({ kind: 'statement', q }));
  return fc.record({
    tables: fc.constant<TableSpec[]>([t, u, w]),
    options: optionsArb,
    force: fc.boolean(),
    // Mostly whole transactions — BEGIN, a few statements, then COMMIT, ROLLBACK or neither — among lone statements
    // and stray control statements, which one session must refuse as SQLite does.
    steps: fc
      .array(
        fc.oneof(
          { weight: 3, arbitrary: fc.tuple(fc.array(statement, { minLength: 1, maxLength: 4 }), fc.constantFrom('COMMIT', 'ROLLBACK', 'ROLLBACK', null)).map(([body, end]): Step[] => [{ kind: 'control', sql: 'BEGIN' }, ...body, ...(end ? [{ kind: 'control' as const, sql: end }] : [])]) },
          { weight: 2, arbitrary: statement.map((x) => [x]) },
          { weight: 1, arbitrary: control.map((x) => [x]) },
        ),
        { minLength: 1, maxLength: 4 },
      )
      .map((blocks) => blocks.flat()),
  });
});

/** Fresh `id` and `k` for every insert, as the differential gives them, so an insert is refused only by design. */
function numbered(steps: Step[]): Step[] {
  return steps.map((s, i) => {
    if (s.kind !== 'statement' || s.q.kind !== 'insert') return s;
    const names = s.q.columns ?? ['id', 'k', 'n', 's', 'r'];
    return { ...s, q: { ...s.q, values: s.q.values.map((v, j) => (names[j] === 'id' ? 100 + i : names[j] === 'k' ? 200 + i : v)) } };
  });
}

/** What the run exercised: an oracle that never rolls a change back proves nothing about rolling back. */
const seen = { rollbacksThatUndid: 0, commitsOfWrites: 0, refusedControl: 0, readsInside: 0 };

function runScript(tablesIn: TableSpec[], options: EngineOptions, force: boolean, steps: Step[]): void {
  const t = tablesIn[0];
  const lite = sqliteWith(tablesIn);
  // The unique indexes QueryLens builds, so that both refuse the same writes.
  (t.unique ?? []).forEach((c, i) => { lite.exec(`CREATE UNIQUE INDEX u${String(i)} ON ${t.name} (${c})`); });
  let db: Database = toDatabase(tablesIn);
  let log: EngineLog = openEngineLog(db, options, { steal: true, force });
  const cols = t.columns.map((c) => c.name);
  let changedInside = 0;
  try {
    for (const step of steps) {
      const sql = step.kind === 'control' ? step.sql : renderQuery(step.q);
      const liteSql = step.kind === 'control' ? step.sql : renderQuery(step.q, 'sqlite');
      const result = runQuery(sql, db, options, { engineLog: loggedRun(log) });
      let liteError: string | null = null;
      let changes = 0;
      try {
        // A read goes through the harness below, which runs it on SQLite itself.
        if (step.kind === 'control' || isWrite(step.q)) changes = Number(lite.prepare(liteSql).run().changes);
      } catch (e) {
        liteError = (e as Error).message;
      }
      if ((result.error === undefined) !== (liteError === null)) {
        throw new Disagreement(sql, `QueryLens ${result.error ? `refused it: ${result.error.message}` : 'accepted it'}; SQLite ${liteError ? `refused it: ${liteError}` : 'accepted it'}`);
      }

      if (result.error) {
        if (step.kind === 'control') seen.refusedControl += 1;
      } else if (step.kind === 'control') {
        if (step.sql === 'ROLLBACK' && changedInside > 0) seen.rollbacksThatUndid += 1;
        if (step.sql === 'COMMIT' && changedInside > 0) seen.commitsOfWrites += 1;
        if (step.sql !== 'BEGIN') changedInside = 0;
        log = result.engineLog!;
        if (result.transaction?.database) db = result.transaction.database;
      } else if (result.write) {
        const count = result.write.kind === 'insert' ? result.write.insertedCount : result.write.kind === 'delete' ? result.write.deletedCount : result.write.updatedCount;
        if (count !== changes) throw new Disagreement(sql, `QueryLens changed ${String(count)} rows, SQLite ${String(changes)}`);
        db = { tables: { ...db.tables, [t.name]: { ...db.tables[t.name], rows: result.write.rows } } };
        log = result.engineLog!;
        if (log.session === null) {
          // Outside BEGIN: SQLite has committed it, so the dialog commits it here.
          const txn = log.statements.at(-1)?.txn;
          if (txn && log.txns.some((x) => x.txn === txn && x.status === 'active')) log = applyLogOp(log, { op: 'commit', txn }, options).log;
        } else {
          changedInside += count;
        }
      } else {
        const q = step.q as ReadQuery;
        const specs = tablesIn.map((s) => (s.name === t.name ? { ...s, rows: db.tables[t.name].rows } : s));
        const why = checkRead(q, specs, qlTuples(q, specs, result.rows), lite);
        if (why) throw new Disagreement(sql, why);
        if (log.session !== null) seen.readsInside += 1;
      }

      if (!inSync(log, db)) throw new Disagreement(sql, 'the log no longer holds the database the Playground does');
      const diff = multisetDiff(db.tables[t.name].rows.map((r) => tupleOf(r, cols)), sqliteTable(lite, t));
      if (diff) throw new Disagreement(sql, `the table after it: ${diff}`);
    }
  } finally {
    lite.close();
  }
}

describe('transactions in the Playground agree with SQLite (plan.md §28.5 I3)', () => {
  it('accept and refuse the same statements, read the same rows, and hold the same table after every step', () => {
    fc.assert(
      fc.property(scriptArb, ({ tables, options, force, steps }) => {
        runScript(tables, options, force, numbered(steps));
      }),
      oracleParams(),
    );
    // Measured at 1,000 scripts on three seeds: 485–508 rollbacks that undid something, 228–261 commits of writes,
    // 387–409 refused control statements, 676–739 reads inside a transaction.
    expect(seen.rollbacksThatUndid).toBeGreaterThan(300);
    expect(seen.commitsOfWrites).toBeGreaterThan(150);
    expect(seen.refusedControl).toBeGreaterThan(250);
    expect(seen.readsInside).toBeGreaterThan(400);
  });
});
