import { describe, expect, it } from 'vitest';
import {
  createHermitageDatabase,
  DOCUMENTED,
  HERMITAGE_LEVELS,
  HERMITAGE_TESTS,
  KNOWN_DIFFERENCES,
  hermitageMatrix,
  runHermitage,
} from '../hermitage.ts';
import type { EngineKind, HermitageTest } from '../hermitage.ts';
import { runSchedule } from '../schedule.ts';
import type { ScheduleResult, ScheduleStepResult } from '../schedule.ts';

/** plan.md §25.4 D5: the Hermitage schedules, run, and held against what the project published. */

const test = (id: string): HermitageTest => HERMITAGE_TESTS.find((t) => t.id === id)!;

describe('the matrix, computed', () => {
  for (const engine of ['locks', 'mvcc', 'innodb'] as EngineKind[]) {
    it(`agrees with the published results for the ${engine} engine, cell by cell, but for the declared differences`, () => {
      const differences = hermitageMatrix(engine)
        // A cell nothing was published for is held against nothing.
        .filter((cell) => {
          const published = DOCUMENTED[engine][cell.level][cell.test];
          return published !== null && cell.occurred !== published;
        })
        .map((cell) => `${cell.engine}/${cell.level}/${cell.test}`)
        .sort();
      const declared = KNOWN_DIFFERENCES.filter((d) => d.engine === engine)
        .map((d) => `${d.engine}/${d.level}/${d.test}`)
        .sort();
      expect(differences).toEqual(declared);
    });

    it(`never lets a stricter level allow what a weaker one prevents (${engine})`, () => {
      const cells = hermitageMatrix(engine);
      for (const t of HERMITAGE_TESTS) {
        const seen = HERMITAGE_LEVELS.map((level) => cells.find((c) => c.test === t.id && c.level === level)!.occurred);
        // Once an anomaly is prevented, it stays prevented at every level above.
        const firstPrevented = seen.indexOf(false);
        if (firstPrevented >= 0) expect(seen.slice(firstPrevented).every((x) => !x)).toBe(true);
      }
    });

    it(`lets nothing through at SERIALIZABLE (${engine})`, () => {
      const cells = hermitageMatrix(engine).filter((c) => c.level === 'serializable');
      expect(cells.filter((c) => c.occurred)).toEqual([]);
    });
  }

  it('has a published result for every cell of PostgreSQL’s and SQL Server’s columns, and for 19 of the 40 of MySQL’s', () => {
    const count = (engine: EngineKind) =>
      HERMITAGE_LEVELS.flatMap((l) => HERMITAGE_TESTS.map((t) => DOCUMENTED[engine][l][t.id])).filter((v) => v !== null)
        .length;
    expect([count('locks'), count('mvcc'), count('innodb')]).toEqual([40, 40, 19]);
  });

  it('says why each difference exists', () => {
    for (const d of KNOWN_DIFFERENCES) expect(d.why.length).toBeGreaterThan(40);
  });
});

describe('InnoDB: a snapshot for plain reads, the latest row for writes', () => {
  const update = (value: number) => `UPDATE test SET value = ${String(value)} WHERE id = 1`;

  it('P4: the second writer waits for the row lock and then goes on top of the first’s change, and both commit', () => {
    const cell = runHermitage(test('P4'), 'repeatable-read', 'innodb');
    expect(cell.occurred).toBe(true);
    const t2 = cell.result.steps.filter((s) => s.session === 'T2');
    expect(t2.some((s) => s.phase === 'blocked')).toBe(true);
    expect(cell.result.steps.some((s) => s.phase === 'victim')).toBe(false);
    // The same schedule under versions-and-snapshots refuses it, which is the difference between the two.
    expect(runHermitage(test('P4'), 'repeatable-read', 'mvcc').occurred).toBe(false);
  });

  it('a write works from the row as it is now, not as the snapshot saw it, while a plain read keeps the snapshot', () => {
    const run = (currentWrites: boolean) =>
      runSchedule(
        [
          { session: 'T1', sql: 'BEGIN' },
          { session: 'T1', sql: 'SELECT * FROM test WHERE id = 1' },
          { session: 'T2', sql: update(11) },
          { session: 'T1', sql: 'UPDATE test SET value = value + 5 WHERE id = 1' },
          { session: 'T1', sql: 'SELECT * FROM test WHERE id = 1' },
          { session: 'T1', sql: 'COMMIT' },
        ],
        createHermitageDatabase(),
        undefined,
        { granularity: 'row', isolation: 'repeatable-read', mvcc: true, ...(currentWrites ? { currentWrites: true } : {}) },
      );
    const innodb = run(true);
    const reads = innodb.steps.filter((s) => s.session === 'T1' && s.kind === 'statement' && s.run?.write === undefined);
    expect(reads[0]!.rows.find((r) => r.id === 1)?.value).toBe(10); // the snapshot, before
    expect(reads[1]!.rows.find((r) => r.id === 1)?.value).toBe(16); // its own write, on 11 not on 10
    expect(innodb.steps.some((s) => s.phase === 'victim')).toBe(false);
    // Without it, the same write is refused: a row it can see has been replaced since the snapshot.
    const postgres = run(false);
    expect(postgres.steps.find((s) => s.phase === 'victim')?.session).toBe('T1');
  });

  it('the option is for REPEATABLE READ alone: under snapshots at SERIALIZABLE a stale write is still refused', () => {
    const result = runSchedule(
      [
        { session: 'T1', sql: 'BEGIN' },
        { session: 'T1', sql: 'SELECT * FROM test WHERE id = 1' },
        { session: 'T2', sql: update(11) },
        { session: 'T1', sql: update(12) },
        { session: 'T1', sql: 'COMMIT' },
      ],
      createHermitageDatabase(),
      undefined,
      { granularity: 'row', isolation: 'serializable', mvcc: true, currentWrites: true },
    );
    // Refused at the write, as under any snapshot, not left to be caught at COMMIT.
    const refused = result.steps.find((s) => s.phase === 'victim')!;
    expect(refused.session).toBe('T1');
    expect(refused.kind).toBe('statement');
    expect(refused.error).toContain('concurrent update');
  });

  it('a transaction that writes a row twice, or inserts and deletes one, sees exactly what it left', () => {
    const run = (currentWrites: boolean) =>
      runSchedule(
        [
          { session: 'T1', sql: 'BEGIN' },
          { session: 'T1', sql: update(11) },
          { session: 'T1', sql: update(12) },
          { session: 'T1', sql: 'INSERT INTO test VALUES (3, 30)' },
          { session: 'T1', sql: 'DELETE FROM test WHERE id = 3' },
          { session: 'T1', sql: 'SELECT * FROM test WHERE id <= 3' },
          { session: 'T1', sql: 'COMMIT' },
        ],
        createHermitageDatabase(),
        undefined,
        { granularity: 'row', isolation: 'repeatable-read', mvcc: true, ...(currentWrites ? { currentWrites: true } : {}) },
      );
    for (const currentWrites of [false, true]) {
      const read = run(currentWrites).steps.filter((s) => s.session === 'T1' && s.kind === 'statement' && s.run?.write === undefined).at(-1)!;
      expect(read.rows.map((r) => [r.id, r.value])).toEqual([
        [1, 12],
        [2, 20],
      ]);
    }
  });

  it('plain reads at READ COMMITTED do not wait on anyone, so the readers of G1c do not deadlock as they do under locks', () => {
    expect(runHermitage(test('G1c'), 'read-committed', 'locks').result.deadlocks).toBe(1);
    expect(runHermitage(test('G1c'), 'read-committed', 'innodb').result.deadlocks).toBe(0);
  });

  it('READ COMMITTED and below match the engines it is built from: a snapshot for each statement, and dirty reads under locks', () => {
    for (const id of ['G1a', 'PMP', 'G-single']) {
      expect(runHermitage(test(id), 'read-committed', 'innodb').occurred).toBe(
        runHermitage(test(id), 'read-committed', 'mvcc').occurred,
      );
      expect(runHermitage(test(id), 'read-uncommitted', 'innodb').occurred).toBe(
        runHermitage(test(id), 'read-uncommitted', 'locks').occurred,
      );
    }
  });

  it('SERIALIZABLE turns plain reads into locking ones: write skew and the phantom both end in a deadlock', () => {
    for (const id of ['G2-item', 'G2']) {
      const cell = runHermitage(test(id), 'serializable', 'innodb');
      expect(cell.occurred).toBe(false);
      expect(cell.result.deadlocks).toBe(1);
    }
  });

  it('REPEATABLE READ keeps what a snapshot keeps — no phantom to a re-read, no read skew — and loses what first-committer-wins keeps', () => {
    const rr = (id: string) => runHermitage(test(id), 'repeatable-read', 'innodb').occurred;
    expect([rr('PMP'), rr('G-single'), rr('G1a'), rr('OTV')]).toEqual([false, false, false, false]);
    expect([rr('P4'), rr('G2-item'), rr('G2')]).toEqual([true, true, true]);
  });
});

describe('what each schedule is built to show', () => {
  it('with no concurrency control at all, nine of the ten happen', () => {
    // OTV is the exception: it needs a reader to see part of a transaction, which no control at all never does.
    const happened = HERMITAGE_TESTS.filter((t) => t.occurred(runSchedule(t.steps, createHermitageDatabase())));
    expect(happened.map((t) => t.id)).toEqual(['G0', 'G1a', 'G1b', 'G1c', 'PMP', 'P4', 'G-single', 'G2-item', 'G2']);
  });

  it('G1a: a reader without read locks sees the value that is then rolled back; read committed waits for it', () => {
    const dirty = runHermitage(test('G1a'), 'read-uncommitted', 'locks');
    expect(dirty.occurred).toBe(true);
    const waited = runHermitage(test('G1a'), 'read-committed', 'locks');
    expect(waited.occurred).toBe(false);
    expect(waited.result.steps.some((s) => s.phase === 'blocked' && s.session === 'T2')).toBe(true);
  });

  it('G1c: the readers each wait for the other, which is a deadlock, and one of them is rolled back', () => {
    const cell = runHermitage(test('G1c'), 'read-committed', 'locks');
    expect(cell.occurred).toBe(false);
    expect(cell.result.deadlocks).toBe(1);
  });

  it('G-single: a snapshot keeps both reads of one state, and read committed does not', () => {
    expect(runHermitage(test('G-single'), 'read-committed', 'mvcc').occurred).toBe(true);
    const snapshot = runHermitage(test('G-single'), 'repeatable-read', 'mvcc');
    expect(snapshot.occurred).toBe(false);
    const read = snapshot.result.steps.filter((s) => s.session === 'T1' && s.kind === 'statement').at(-1)!;
    expect(read.rows.find((r) => r.id === 2)?.value).toBe(20);
  });

  it('P4: first committer wins under a snapshot, and the loser is refused at its write', () => {
    const cell = runHermitage(test('P4'), 'repeatable-read', 'mvcc');
    expect(cell.occurred).toBe(false);
    const refused = cell.result.steps.find((s) => s.phase === 'victim')!;
    expect(refused.session).toBe('T2');
    expect(refused.error).toContain('concurrent update');
  });

  it('G2-item and G2: a snapshot lets both commit, and serializable refuses the second', () => {
    for (const id of ['G2-item', 'G2']) {
      expect(runHermitage(test(id), 'repeatable-read', 'mvcc').occurred).toBe(true);
      const strict = runHermitage(test(id), 'serializable', 'mvcc');
      expect(strict.occurred).toBe(false);
      expect(strict.result.steps.find((s) => s.phase === 'victim')?.session).toBe('T2');
    }
  });

  it('PMP: only a predicate lock stops the new row, by making the insert wait', () => {
    expect(runHermitage(test('PMP'), 'repeatable-read', 'locks').occurred).toBe(true);
    const strict = runHermitage(test('PMP'), 'serializable', 'locks');
    expect(strict.occurred).toBe(false);
    expect(strict.result.steps.some((s) => s.session === 'T2' && s.phase === 'blocked')).toBe(true);
  });

  it('G2 under locks: a predicate lock each, and the inserts deadlock', () => {
    const cell = runHermitage(test('G2'), 'serializable', 'locks');
    expect(cell.occurred).toBe(false);
    expect(cell.result.deadlocks).toBe(1);
  });

  it('OTV: reads the sequence it is defined by, on a result built to show it', () => {
    const read = (id: number, value: number): ScheduleStepResult =>
      ({
        session: 'T3',
        kind: 'statement',
        phase: 'ran',
        run: { events: [], rows: [] },
        rows: [{ id, value }],
      }) as unknown as ScheduleStepResult;
    const result = (...reads: ScheduleStepResult[]) => ({ steps: reads }) as unknown as ScheduleResult;
    // T3 sees T2's 18, and then T1's 11 where T2's 12 should be: T2 has vanished.
    expect(test('OTV').occurred(result(read(1, 11), read(2, 19), read(2, 18), read(1, 11)))).toBe(true);
    // T3 sees T2's 18 and then T2's 12: no anomaly.
    expect(test('OTV').occurred(result(read(1, 11), read(2, 19), read(2, 18), read(1, 12)))).toBe(false);
    // T3 never sees T2's 18 at all.
    expect(test('OTV').occurred(result(read(1, 11), read(2, 19), read(1, 11)))).toBe(false);
  });
});
