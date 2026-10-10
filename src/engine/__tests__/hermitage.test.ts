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
  for (const engine of ['locks', 'mvcc'] as EngineKind[]) {
    it(`agrees with the published results for the ${engine} engine, cell by cell, but for the declared differences`, () => {
      const differences = hermitageMatrix(engine)
        .filter((cell) => cell.occurred !== DOCUMENTED[engine][cell.level][cell.test])
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

  it('says why each difference exists', () => {
    for (const d of KNOWN_DIFFERENCES) expect(d.why.length).toBeGreaterThan(40);
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
