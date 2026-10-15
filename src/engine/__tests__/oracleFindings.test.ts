/**
 * Regressions for the bugs the SQLite oracle found (`oracle/`, plan.md §25.4
 * A1). Each is the *minimal* statement, written from SQL's own rules rather
 * than from SQLite's output, so it keeps guarding the engine even if the
 * oracle is never run.
 */

import { describe, expect, it } from 'vitest';
import { runQuery } from '../runQuery.ts';
import type { Database, StepEvent } from '../types.ts';

/** `id` is indexed; `k` is nullable — NULLs are never in an index (`buildIndex`). */
const db = (): Database => ({
  tables: {
    t: {
      name: 't',
      columns: ['id', 'k'],
      rows: [
        { id: 1, k: 10 },
        { id: 2, k: null },
        { id: 3, k: 30 },
        { id: 4, k: null },
      ],
      indexedColumns: ['id'],
    },
  },
});

const rules = (events: StepEvent[]): string[] =>
  events.flatMap((e) => (e.stage === 'optimize' ? [e.rule] : []));

describe('a comparison with NULL is UNKNOWN — it matches nothing, and never becomes an index scan', () => {
  it.each(['id > NULL', 'id >= NULL', 'id < NULL', 'id <= NULL', 'NULL < id', 'id BETWEEN NULL AND 3', 'id BETWEEN 1 AND NULL'])(
    'WHERE %s returns no rows',
    (predicate) => {
      const { rows, error } = runQuery(`SELECT id FROM t WHERE ${predicate}`, db());
      expect(error).toBeUndefined();
      expect(rows).toEqual([]);
    },
  );

  it('WHERE id = NULL returns no rows and is not an index lookup for the key NULL', () => {
    const { rows, events } = runQuery('SELECT * FROM t WHERE id = NULL', db());
    expect(rows).toEqual([]);
    expect(rules(events)).not.toContain('index-selection');
  });

  it('a NULL bound does not turn a range into an IndexRangeScan', () => {
    const { events } = runQuery('SELECT id FROM t WHERE id > NULL', db());
    expect(rules(events)).not.toContain('range-index-selection');
  });

  it('a real bound beside a NULL one still matches nothing (UNKNOWN AND x is never TRUE)', () => {
    expect(runQuery('SELECT id FROM t WHERE id > 1 AND id < NULL', db()).rows).toEqual([]);
  });

  it('a range with real bounds still uses the index', () => {
    const { rows, events } = runQuery('SELECT id FROM t WHERE id > 1 AND id <= 3', db());
    expect(rows.map((r) => r.id)).toEqual([2, 3]);
    expect(rules(events)).toContain('range-index-selection');
  });
});

describe('a column compared with itself is not "always true" — it is UNKNOWN where the column is NULL', () => {
  it('SELECT … WHERE k = k leaves out the rows where k is NULL', () => {
    const { rows } = runQuery('SELECT id FROM t WHERE k = k', db());
    expect(rows.map((r) => r.id)).toEqual([1, 3]);
  });

  it('DELETE … WHERE k = k deletes only the rows it selects — the NULL-k rows survive', () => {
    const result = runQuery('DELETE FROM t WHERE k = k', db());
    expect(result.write).toMatchObject({ kind: 'delete', deletedCount: 2 });
    expect(result.write?.rows.map((r) => r.id)).toEqual([2, 4]);
  });

  it('k <= k and k >= k behave the same way; k < k and k > k match nothing', () => {
    expect(runQuery('SELECT id FROM t WHERE k <= k', db()).rows.map((r) => r.id)).toEqual([1, 3]);
    expect(runQuery('SELECT id FROM t WHERE k >= k', db()).rows.map((r) => r.id)).toEqual([1, 3]);
    expect(runQuery('SELECT id FROM t WHERE k < k', db()).rows).toEqual([]);
    expect(runQuery('SELECT id FROM t WHERE k > k', db()).rows).toEqual([]);
  });

  it('constant-folding still drops a comparison of two literals', () => {
    const { events } = runQuery('SELECT id FROM t WHERE 1 = 1', db());
    expect(rules(events)).toContain('constant-folding');
  });
});

describe('an empty IN list is FALSE for every value, a NULL one included (found 2026-10-14)', () => {
  // `k` is NULL on ids 2 and 4. With a non-empty list a NULL operand is UNKNOWN; with an empty one there is nothing
  // for it to be unknown against, so `NULL IN (∅)` is FALSE and `NULL NOT IN (∅)` is TRUE. Only a subquery can be
  // empty — here, one over `t` itself that no row satisfies.
  const EMPTY = '(SELECT id FROM t WHERE id < 0)';

  it('NOT IN keeps every row, and IN none', () => {
    expect(runQuery(`SELECT id FROM t WHERE k NOT IN ${EMPTY}`, db()).rows.map((r) => r.id)).toEqual([1, 2, 3, 4]);
    expect(runQuery(`SELECT id FROM t WHERE k IN ${EMPTY}`, db()).rows).toEqual([]);
  });

  it('DELETE … WHERE k NOT IN (∅) deletes the NULL-k rows too', () => {
    expect(runQuery(`DELETE FROM t WHERE k NOT IN ${EMPTY}`, db()).write).toMatchObject({ kind: 'delete', deletedCount: 4 });
  });
});

describe('an IN subquery is resolved wherever the grammar lets it stand, not only under AND/OR/NOT (found 2026-10-14)', () => {
  // k IN (SELECT k FROM t) is TRUE for 10 and 30 and UNKNOWN for the NULLs. Left unresolved it read as an empty
  // list, FALSE everywhere, so the IS NULL below found nothing and HAVING kept no group.
  it('under IS NULL', () => {
    expect(runQuery('SELECT id FROM t WHERE (k IN (SELECT k FROM t)) IS NULL', db()).rows.map((r) => r.id)).toEqual([2, 4]);
  });

  it('in HAVING', () => {
    expect(runQuery('SELECT k, COUNT(*) FROM t GROUP BY k HAVING k IN (SELECT k FROM t WHERE id = 1)', db()).rows).toEqual([
      { k: 10, 'COUNT(*)': 1 },
    ]);
  });
});
