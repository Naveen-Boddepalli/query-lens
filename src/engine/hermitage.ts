/**
 * The isolation matrix (plan.md §25.4 D5): ten anomalies from Martin Kleppmann's Hermitage suite, each a fixed
 * schedule of three transactions run for real, at each isolation level, on each of the two engines — strict
 * two-phase locking, and versions with snapshots. A cell is not looked up. The schedule is run, and the anomaly's own
 * definition is checked against what the transactions saw and wrote.
 *
 * The published results are kept beside the computed ones so a test can hold them against each other. That is the
 * claim worth making: not that this engine is PostgreSQL, but that for these ten schedules it *behaves* as the
 * documented databases do — which is about what each level lets through, never how it is built.
 *
 * Hermitage: https://github.com/ept/hermitage. Its schedules are reproduced from its PostgreSQL results page, on the
 * same two rows; the statements are the ones this engine's SQL can run.
 */

import { ISOLATION_LABELS } from './isolation.ts';
import { runSchedule } from './schedule.ts';
import type { ScheduleResult, ScheduleStep, ScheduleStepResult } from './schedule.ts';
import type { IsolationLevel } from './transactionControl.ts';
import type { Database } from './types.ts';

/**
 * The table Hermitage's isolation tests run on (plan.md §25.4 D5): `test(id, value)` with the two rows its schedules
 * assume, (1, 10) and (2, 20). Eighteen filler rows follow, with a `value` that is never a multiple of three or thirty,
 * so no schedule's predicate picks one out. They are there for the planner, not for the tests: with two rows it scans,
 * and a scan examines every row, which would make a lock on row 1 a lock on the whole table. At twenty an `id` lookup
 * goes through the index and touches one row, as it does in the databases the published results come from.
 */
export function createHermitageDatabase(): Database {
  const filler = Array.from({ length: 18 }, (_, i) => ({ id: 101 + i, value: 1 }));
  return {
    tables: {
      test: {
        name: 'test',
        columns: ['id', 'value'],
        rows: [{ id: 1, value: 10 }, { id: 2, value: 20 }, ...filler],
        indexes: [{ columns: ['id'], unique: true }],
      },
    },
  };
}

export type AnomalyId = 'G0' | 'G1a' | 'G1b' | 'G1c' | 'OTV' | 'PMP' | 'P4' | 'G-single' | 'G2-item' | 'G2';
export type EngineKind = 'locks' | 'mvcc' | 'innodb';

/**
 * MySQL's InnoDB is neither engine alone, and what it is depends on the level: `READ UNCOMMITTED` reads the latest
 * version whatever its state, so it is the locking engine's dirty reads with write locks; `READ COMMITTED` is a
 * snapshot for each statement; `REPEATABLE READ` is a snapshot for the transaction for plain reads and a current read
 * for writes (`currentWrites`), which is how it differs from PostgreSQL's; and at `SERIALIZABLE` a plain read becomes a
 * locking one, so it is the locking engine again — with InnoDB's next-key locks (plan.md §27.5 T3) where the locks
 * engine has a predicate lock: the phantom is kept out by a lock on the gap it would go into.
 */
const INNODB_AT: Record<IsolationLevel, { mvcc: boolean; currentWrites?: boolean; nextKey?: boolean }> = {
  'read-uncommitted': { mvcc: false, nextKey: true },
  'read-committed': { mvcc: true },
  'repeatable-read': { mvcc: true, currentWrites: true },
  serializable: { mvcc: false, nextKey: true },
};

export interface HermitageTest {
  id: AnomalyId;
  name: string;
  /** What the anomaly is, in a sentence, and what in the schedule would show it. */
  means: string;
  steps: ScheduleStep[];
  /** True when the schedule, as it ran, did the anomalous thing. */
  occurred: (result: ScheduleResult) => boolean;
}

const t = (session: 'T1' | 'T2' | 'T3', sql: string): ScheduleStep => ({ session, sql });
const BEGIN = (session: 'T1' | 'T2' | 'T3'): ScheduleStep => t(session, 'BEGIN');
const COMMIT = (session: 'T1' | 'T2' | 'T3'): ScheduleStep => t(session, 'COMMIT');

/** What a session's statements returned, in the order they actually ran, for the ones that read. */
function readsOf(result: ScheduleResult, session: string): ScheduleStepResult[] {
  return result.steps.filter(
    (s) =>
      s.session === session &&
      s.kind === 'statement' &&
      s.phase !== 'blocked' &&
      s.phase !== 'queued' &&
      s.phase !== 'victim' &&
      s.error === undefined &&
      s.run !== undefined &&
      s.run.write === undefined,
  );
}

const valueOf = (step: ScheduleStepResult | undefined, id: number): number | undefined =>
  step?.rows.find((row) => row.id === id)?.value as number | undefined;

/** Did the session's own `COMMIT` go through, rather than be refused or never run? */
function committedOk(result: ScheduleResult, session: string): boolean {
  return result.steps.some(
    (s) => s.session === session && s.kind === 'commit' && s.phase !== 'victim' && s.notes.some((n) => n.includes('commits')),
  );
}

const finalValue = (result: ScheduleResult, id: number): number | undefined =>
  result.final.tables.test?.rows.find((row) => row.id === id)?.value as number | undefined;

const ids = (result: ScheduleResult): number[] => (result.final.tables.test?.rows ?? []).map((row) => row.id as number);

export const HERMITAGE_TESTS: HermitageTest[] = [
  {
    id: 'G0',
    name: 'Write cycles',
    means: 'Two transactions overwrite each other’s uncommitted writes, so the table ends up with one’s value in one row and the other’s in the other.',
    steps: [
      BEGIN('T1'),
      BEGIN('T2'),
      t('T1', 'UPDATE test SET value = 11 WHERE id = 1'),
      t('T2', 'UPDATE test SET value = 12 WHERE id = 1'),
      t('T1', 'UPDATE test SET value = 21 WHERE id = 2'),
      COMMIT('T1'),
      t('T2', 'UPDATE test SET value = 22 WHERE id = 2'),
      COMMIT('T2'),
    ],
    // A dirty write is exactly a write over a row someone else has changed and not committed.
    occurred: (r) => r.steps.some((s) => s.anomalies.some((a) => a.kind === 'dirty-write')),
  },
  {
    id: 'G1a',
    name: 'Aborted reads',
    means: 'T2 reads a value T1 wrote and then rolled back.',
    steps: [
      BEGIN('T1'),
      BEGIN('T2'),
      t('T1', 'UPDATE test SET value = 101 WHERE id = 1'),
      t('T2', 'SELECT * FROM test'),
      t('T1', 'ROLLBACK'),
      t('T2', 'SELECT * FROM test'),
      COMMIT('T2'),
    ],
    occurred: (r) => readsOf(r, 'T2').some((s) => valueOf(s, 1) === 101),
  },
  {
    id: 'G1b',
    name: 'Intermediate reads',
    means: 'T2 reads a value T1 wrote part-way through, before it wrote the value it committed.',
    steps: [
      BEGIN('T1'),
      BEGIN('T2'),
      t('T1', 'UPDATE test SET value = 101 WHERE id = 1'),
      t('T2', 'SELECT * FROM test'),
      t('T1', 'UPDATE test SET value = 11 WHERE id = 1'),
      COMMIT('T1'),
      t('T2', 'SELECT * FROM test'),
      COMMIT('T2'),
    ],
    occurred: (r) => readsOf(r, 'T2').some((s) => valueOf(s, 1) === 101),
  },
  {
    id: 'G1c',
    name: 'Circular information flow',
    means: 'Each of two transactions reads what the other has written and not committed.',
    steps: [
      BEGIN('T1'),
      BEGIN('T2'),
      t('T1', 'UPDATE test SET value = 11 WHERE id = 1'),
      t('T2', 'UPDATE test SET value = 22 WHERE id = 2'),
      t('T1', 'SELECT * FROM test WHERE id = 2'),
      t('T2', 'SELECT * FROM test WHERE id = 1'),
      COMMIT('T1'),
      COMMIT('T2'),
    ],
    occurred: (r) =>
      readsOf(r, 'T1').some((s) => valueOf(s, 2) === 22) && readsOf(r, 'T2').some((s) => valueOf(s, 1) === 11),
  },
  {
    id: 'OTV',
    name: 'Observed transaction vanishes',
    means: 'T3 sees part of what T2 wrote, and then, reading another row, sees the value from before T2.',
    steps: [
      BEGIN('T1'),
      BEGIN('T2'),
      BEGIN('T3'),
      t('T1', 'UPDATE test SET value = 11 WHERE id = 1'),
      t('T1', 'UPDATE test SET value = 19 WHERE id = 2'),
      t('T2', 'UPDATE test SET value = 12 WHERE id = 1'),
      COMMIT('T1'),
      t('T3', 'SELECT * FROM test WHERE id = 1'),
      t('T2', 'UPDATE test SET value = 18 WHERE id = 2'),
      t('T3', 'SELECT * FROM test WHERE id = 2'),
      COMMIT('T2'),
      t('T3', 'SELECT * FROM test WHERE id = 2'),
      t('T3', 'SELECT * FROM test WHERE id = 1'),
      COMMIT('T3'),
    ],
    occurred: (r) => {
      const reads = readsOf(r, 'T3');
      // After T3 has seen T2's value for row 2, it must not see anything older than T2's value for row 1.
      const sawT2 = reads.findIndex((s) => valueOf(s, 2) === 18);
      if (sawT2 < 0) return false;
      return reads.slice(sawT2 + 1).some((s) => valueOf(s, 1) === 11);
    },
  },
  {
    id: 'PMP',
    name: 'Predicate-many-preceders',
    means: 'A transaction runs a query, another commits a row that matches it, and the first runs a matching query again and gets the new row.',
    steps: [
      BEGIN('T1'),
      BEGIN('T2'),
      t('T1', 'SELECT * FROM test WHERE value = 30'),
      t('T2', 'INSERT INTO test VALUES (3, 30)'),
      COMMIT('T2'),
      t('T1', 'SELECT * FROM test WHERE value % 3 = 0'),
      COMMIT('T1'),
    ],
    occurred: (r) => readsOf(r, 'T1').some((s) => s.rows.some((row) => row.id === 3)),
  },
  {
    id: 'P4',
    name: 'Lost update',
    means: 'Both transactions read a row and then write it; the second to write replaces the first’s change without having seen it.',
    steps: [
      BEGIN('T1'),
      BEGIN('T2'),
      t('T1', 'SELECT * FROM test WHERE id = 1'),
      t('T2', 'SELECT * FROM test WHERE id = 1'),
      t('T1', 'UPDATE test SET value = 11 WHERE id = 1'),
      t('T2', 'UPDATE test SET value = 11 WHERE id = 1'),
      COMMIT('T1'),
      COMMIT('T2'),
    ],
    // Both read the row and both wrote it, so serially the second would have worked from the first's value: if both
    // commit, one of the two writes was made without seeing the other. Judged by the outcome, not by the engine's own
    // flag for it, which a broken engine could fail to raise.
    occurred: (r) => committedOk(r, 'T1') && committedOk(r, 'T2'),
  },
  {
    id: 'G-single',
    name: 'Read skew',
    means: 'T1 reads one row, T2 changes both rows and commits, and T1 reads the other row, so it sees a state that never existed.',
    steps: [
      BEGIN('T1'),
      BEGIN('T2'),
      t('T1', 'SELECT * FROM test WHERE id = 1'),
      t('T2', 'SELECT * FROM test'),
      t('T2', 'UPDATE test SET value = 12 WHERE id = 1'),
      t('T2', 'UPDATE test SET value = 18 WHERE id = 2'),
      COMMIT('T2'),
      t('T1', 'SELECT * FROM test WHERE id = 2'),
      COMMIT('T1'),
    ],
    occurred: (r) => readsOf(r, 'T1').some((s) => valueOf(s, 2) === 18),
  },
  {
    id: 'G2-item',
    name: 'Write skew',
    means: 'Two transactions read the same rows and each writes a different one; each was valid alone, and together they are not.',
    steps: [
      BEGIN('T1'),
      BEGIN('T2'),
      t('T1', 'SELECT * FROM test WHERE id IN (1, 2)'),
      t('T2', 'SELECT * FROM test WHERE id IN (1, 2)'),
      t('T1', 'UPDATE test SET value = 11 WHERE id = 1'),
      t('T2', 'UPDATE test SET value = 21 WHERE id = 2'),
      COMMIT('T1'),
      COMMIT('T2'),
    ],
    occurred: (r) => committedOk(r, 'T1') && committedOk(r, 'T2') && finalValue(r, 1) === 11 && finalValue(r, 2) === 21,
  },
  {
    id: 'G2',
    name: 'Anti-dependency cycles',
    means: 'Write skew on a predicate: both transactions read the rows matching a predicate and each inserts a row that matches it.',
    steps: [
      BEGIN('T1'),
      BEGIN('T2'),
      t('T1', 'SELECT * FROM test WHERE value % 3 = 0'),
      t('T2', 'SELECT * FROM test WHERE value % 3 = 0'),
      t('T1', 'INSERT INTO test VALUES (3, 30)'),
      t('T2', 'INSERT INTO test VALUES (4, 42)'),
      COMMIT('T1'),
      COMMIT('T2'),
    ],
    occurred: (r) => committedOk(r, 'T1') && committedOk(r, 'T2') && ids(r).includes(3) && ids(r).includes(4),
  },
];

/** The levels the matrix runs, in order of what they promise. */
export const HERMITAGE_LEVELS: readonly IsolationLevel[] = [
  'read-uncommitted',
  'read-committed',
  'repeatable-read',
  'serializable',
];

export const HERMITAGE_LEVEL_LABELS = ISOLATION_LABELS;

export interface MatrixCell {
  test: AnomalyId;
  level: IsolationLevel;
  engine: EngineKind;
  /** True when the schedule showed the anomaly: it can occur at this level. */
  occurred: boolean;
  result: ScheduleResult;
}

/** Runs one schedule at one level on one engine. */
export function runHermitage(test: HermitageTest, level: IsolationLevel, engine: EngineKind): MatrixCell {
  const how = engine === 'innodb' ? INNODB_AT[level] : { mvcc: engine === 'mvcc' };
  const result = runSchedule(test.steps, createHermitageDatabase(), undefined, {
    granularity: 'row',
    isolation: level,
    ...(how.mvcc ? { mvcc: true } : {}),
    ...('currentWrites' in how && how.currentWrites ? { currentWrites: true } : {}),
    ...('nextKey' in how && how.nextKey ? { nextKey: true } : {}),
  });
  return { test: test.id, level, engine, occurred: test.occurred(result), result };
}

/** Every test at every level on one engine: the matrix, computed. */
export function hermitageMatrix(engine: EngineKind): MatrixCell[] {
  return HERMITAGE_TESTS.flatMap((test) => HERMITAGE_LEVELS.map((level) => runHermitage(test, level, engine)));
}

/**
 * What the Hermitage project published: `true` where the anomaly *can occur*, `false` where it is prevented, and
 * `null` where nothing was published for that cell. PostgreSQL's is the reference for the versions engine: its READ
 * UNCOMMITTED is READ COMMITTED, and its REPEATABLE READ is snapshot isolation. SQL Server's locking levels are the
 * reference for the locks engine. MySQL's InnoDB is the third column, `innodb`, and its published results are
 * *partial*: its page runs most anomalies at some of the levels, not all, and each of `PMP` and `G-single` in a read
 * predicate and a write predicate variant — the matrix's schedules are the read variants, which is what is recorded
 * here.
 */
export type Published = boolean | null;

export const DOCUMENTED: Record<EngineKind, Record<IsolationLevel, Record<AnomalyId, Published>>> = (() => {
  const all: AnomalyId[] = ['G0', 'G1a', 'G1b', 'G1c', 'OTV', 'PMP', 'P4', 'G-single', 'G2-item', 'G2'];
  const row = (...occur: AnomalyId[]): Record<AnomalyId, Published> =>
    Object.fromEntries(all.map((id) => [id, occur.includes(id)])) as Record<AnomalyId, Published>;
  /** Only the cells a page published; every other is `null`. */
  const partial = (known: Partial<Record<AnomalyId, boolean>>): Record<AnomalyId, Published> =>
    Object.fromEntries(all.map((id) => [id, known[id] ?? null])) as Record<AnomalyId, Published>;
  const postgresRC = row('PMP', 'P4', 'G-single', 'G2-item', 'G2');
  return {
    mvcc: {
      'read-uncommitted': postgresRC,
      'read-committed': postgresRC,
      'repeatable-read': row('G2-item', 'G2'),
      serializable: row(),
    },
    locks: {
      'read-uncommitted': row('G1a', 'G1b', 'G1c', 'OTV', 'PMP', 'P4', 'G-single', 'G2-item', 'G2'),
      'read-committed': row('PMP', 'P4', 'G-single', 'G2-item', 'G2'),
      'repeatable-read': row('PMP', 'G2'),
      serializable: row(),
    },
    // MySQL 5.6.21, InnoDB (Hermitage's mysql.md).
    innodb: {
      'read-uncommitted': partial({ G0: false, G1a: true, G1b: true, G1c: true, OTV: true }),
      'read-committed': partial({ G1a: false, G1b: false, G1c: false, OTV: false, PMP: true, 'G-single': true }),
      // Read predicates and read-only skew are prevented by the snapshot; a lost update and both write skews are not.
      'repeatable-read': partial({ PMP: false, P4: true, 'G-single': false, 'G2-item': true, G2: true }),
      // PMP and G-single are published here only for their write-predicate variants, which the matrix does not run.
      serializable: partial({ P4: false, 'G2-item': false, G2: false }),
    },
  };
})();

/**
 * Where the computed matrix and the published one differ, and why. A test holds the two together and fails on any
 * difference not listed, so this is the whole of the gap, not a sample of it.
 */
export const KNOWN_DIFFERENCES: { engine: EngineKind; level: IsolationLevel; test: AnomalyId; why: string }[] = [
  {
    engine: 'innodb',
    level: 'read-uncommitted',
    test: 'OTV',
    why:
      'MySQL’s page marks OTV as able to occur at READ UNCOMMITTED, where a reader sees whatever is latest. In this ' +
      'schedule T2 commits, and T3 reads 12 and 19 and then 12 and 18 — the same consistent values the locking engine ' +
      'gives above — so the anomaly is not exhibited here, though a dirty reader can in principle observe it.',
  },
  {
    engine: 'locks',
    level: 'read-uncommitted',
    test: 'OTV',
    why:
      'SQL Server marks every read-based anomaly as able to occur at READ UNCOMMITTED, because a dirty reader may observe a ' +
      'transaction that later rolls back. In this schedule T2 commits, and T3 reads 12 and 19 and then 12 and 18 — the same ' +
      'consistent values SQL Server’s own run of it shows — so the schedule does not exhibit the anomaly here.',
  },
];
