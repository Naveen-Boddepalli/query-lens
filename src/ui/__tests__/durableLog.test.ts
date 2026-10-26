import { describe, expect, it } from 'vitest';
import { databaseFromCells } from '../../engine/recovery/heap.ts';
import { databaseCells, runWal } from '../../engine/recovery/wal.ts';
import { runQuery } from '../../engine/runQuery.ts';
import { createAccountsDatabase } from '../../engine/seed.ts';
import type { Database } from '../../engine/types.ts';
import { LOG_MAX_STEPS, appendStep, carryOn, inSync, openLog, recordWrite } from '../durableLog.ts';
import type { DurableLog } from '../durableLog.ts';

/** Runs `sql` against `db` the way the Playground does, and records what it wrote. */
function play(log: DurableLog, db: Database, sql: string): { log: DurableLog; db: Database } {
  const r = runQuery(sql, db);
  if (!r.write) throw new Error(`not a write: ${sql}`);
  const next = recordWrite(log, db, sql, { table: r.write.table, kind: r.write.kind, rows: r.write.rows });
  return {
    log: next,
    db: { tables: { ...db.tables, [r.write.table]: { ...db.tables[r.write.table]!, rows: r.write.rows } } },
  };
}

describe('the Playground’s durability log', () => {
  it('keeps each write statement as a transaction of its own, in order', () => {
    let db = createAccountsDatabase(10);
    let log = openLog(db, 4);
    ({ log, db } = play(log, db, 'UPDATE accounts SET balance = 0 WHERE id = 1'));
    ({ log, db } = play(log, db, 'DELETE FROM accounts WHERE id = 2'));
    ({ log, db } = play(log, db, "INSERT INTO accounts VALUES (50, 'zed', 7)"));
    expect(log.statements.map((s) => `${s.txn}:${s.kind}:${String(s.rows)}`)).toEqual(['Q1:update:1', 'Q2:delete:1', 'Q3:insert:1']);
    expect(log.refused).toBeNull();
    expect(inSync(log, db)).toBe(true);
  });

  it('notices a database changed some other way, and starts again from it', () => {
    const db = createAccountsDatabase(10);
    let log = openLog(db, 4);
    log = play(log, db, 'UPDATE accounts SET balance = 0 WHERE id = 1').log;
    const other = createAccountsDatabase(20);
    expect(inSync(log, other)).toBe(false);
    const again = play(log, other, 'UPDATE accounts SET balance = 5 WHERE id = 1');
    // The log of the old database is gone; this is the first statement of a new one.
    expect(again.log.statements).toHaveLength(1);
    expect(again.log.statements[0]!.txn).toBe('Q1');
    expect(inSync(again.log, again.db)).toBe(true);
  });

  it('says why a statement is not in the log, and still follows the database', () => {
    let db = createAccountsDatabase(100);
    let log = openLog(db, 4);
    ({ log, db } = play(log, db, 'UPDATE accounts SET balance = balance + 1'));
    expect(log.refused).toContain('keeps up to');
    expect(log.statements).toEqual([]);
    expect(inSync(log, db)).toBe(true);
  });

  it('refuses steps past its limit', () => {
    let log = openLog(createAccountsDatabase(3), 4);
    for (let i = 0; i < LOG_MAX_STEPS + 3; i += 1) log = appendStep(log, { op: 'flush-log' });
    expect(log.steps).toHaveLength(LOG_MAX_STEPS);
    expect(log.refused).toContain('keeps up to');
  });

  it('commit, crash and recovery give back exactly the statements that committed', () => {
    let db = createAccountsDatabase(10);
    let log = openLog(db, 4);
    ({ log, db } = play(log, db, 'UPDATE accounts SET balance = 1 WHERE id = 2'));
    log = appendStep(log, { op: 'commit', txn: 'Q1' });
    ({ log, db } = play(log, db, 'DELETE FROM accounts WHERE id = 5'));
    ({ log, db } = play(log, db, "INSERT INTO accounts VALUES (77, 'new', 9)"));
    log = appendStep(log, { op: 'commit', txn: 'Q3' });
    log = appendStep(log, { op: 'write-page', page: 2 });
    log = appendStep(log, { op: 'crash' });
    log = appendStep(log, { op: 'recover' });
    const run = runWal(log.steps, { pages: log.pages, frames: 4, maxSteps: LOG_MAX_STEPS });
    expect(run.steps.every((s) => s.error === undefined)).toBe(true);
    const recovered = databaseFromCells(log.base, log.heap, databaseCells(run.final));
    const rows = recovered.tables.accounts!.rows;
    // Q1 and Q3 committed; Q2's delete of id 5 did not, so row 5 is back and the new row is in.
    expect(rows.find((r) => r.id === 2)!.balance).toBe(1);
    expect(rows.some((r) => r.id === 5)).toBe(true);
    expect(rows.some((r) => r.id === 77)).toBe(true);
    expect(rows).toHaveLength(11);
    // The Playground, before the crash, had row 5 gone.
    expect(db.tables.accounts!.rows.some((r) => r.id === 5)).toBe(false);
  });

  it('carries on from a recovered database', () => {
    const db = createAccountsDatabase(4);
    const log = openLog(db, 4);
    const next = carryOn(log, db, log.heap);
    expect(inSync(next, db)).toBe(true);
  });
});
