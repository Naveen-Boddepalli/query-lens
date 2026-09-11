import { describe, expect, it } from 'vitest';
import { parse } from '../parser/parser.ts';
import { evaluatePredicate, passes } from '../exec/evaluate.ts';
import { runQuery } from '../runQuery.ts';
import { createSeedDatabase } from '../seed.ts';
import { DATASETS } from '../datasets.ts';
import { DEFAULT_ENGINE_OPTIONS } from '../types.ts';
import type { Row, StepEvent } from '../types.ts';

const db = createSeedDatabase();
const users = db.tables.users!;
const run = (sql: string) => runQuery(sql, db);

function where(sql: string) {
  const out = parse(sql);
  if (!out.ok) throw new Error(out.error.message);
  return out.ast.where!;
}

/** The reference answer, computed without the engine. */
function expected(predicate: (r: Row) => boolean): Row[] {
  return users.rows.filter(predicate);
}

describe('three-valued logic', () => {
  const row: Row = { a: 5, b: null, name: 'ada' };

  it('compares numbers numerically', () => {
    expect(evaluatePredicate(where('SELECT * FROM t WHERE a = 5'), row)).toBe(true);
    expect(evaluatePredicate(where('SELECT * FROM t WHERE a > 5'), row)).toBe(false);
    expect(evaluatePredicate(where('SELECT * FROM t WHERE a < 9'), row)).toBe(true);
  });

  it('compares strings lexicographically', () => {
    expect(evaluatePredicate(where("SELECT * FROM t WHERE name = 'ada'"), row)).toBe(true);
    expect(evaluatePredicate(where("SELECT * FROM t WHERE name < 'brendan'"), row)).toBe(true);
  });

  it('yields UNKNOWN, not false, for any comparison against NULL', () => {
    expect(evaluatePredicate(where('SELECT * FROM t WHERE b = 1'), row)).toBeNull();
    expect(evaluatePredicate(where('SELECT * FROM t WHERE b > 1'), row)).toBeNull();
    expect(evaluatePredicate(where('SELECT * FROM t WHERE b = NULL'), row)).toBeNull();
  });

  it('treats a missing column as NULL', () => {
    expect(evaluatePredicate(where('SELECT * FROM t WHERE missing = 1'), row)).toBeNull();
  });

  it('lets FALSE dominate UNKNOWN in an AND', () => {
    // FALSE AND UNKNOWN is FALSE — not UNKNOWN.
    expect(evaluatePredicate(where('SELECT * FROM t WHERE a = 99 AND b = 1'), row)).toBe(false);
    expect(evaluatePredicate(where('SELECT * FROM t WHERE a = 5 AND b = 1'), row)).toBeNull();
    expect(evaluatePredicate(where(`SELECT * FROM t WHERE a = 5 AND name = 'ada'`), row)).toBe(true);
  });

  it('passes only on TRUE — UNKNOWN does not pass a WHERE clause', () => {
    expect(passes(where('SELECT * FROM t WHERE a = 5'), row)).toBe(true);
    expect(passes(where('SELECT * FROM t WHERE b = 1'), row)).toBe(false);
    expect(passes(undefined, row)).toBe(true);
  });
});

describe('execution results are correct', () => {
  it('returns every row for an unfiltered scan', () => {
    expect(run('SELECT * FROM users').rows).toEqual(users.rows);
  });

  it('returns the single row an indexed lookup points at', () => {
    const { rows } = run('SELECT * FROM users WHERE id = 5');
    expect(rows).toEqual(expected((r) => r.id === 5));
    expect(rows).toHaveLength(1);
  });

  it('returns nothing for a key that is absent', () => {
    expect(run('SELECT * FROM users WHERE id = 9999').rows).toEqual([]);
  });

  it('agrees with a plain filter for range predicates', () => {
    expect(run('SELECT * FROM users WHERE age > 30').rows).toEqual(
      expected((r) => (r.age as number) > 30),
    );
    expect(run('SELECT * FROM users WHERE age < 30').rows).toEqual(
      expected((r) => (r.age as number) < 30),
    );
  });

  it('agrees for an equality on an unindexed column', () => {
    expect(run("SELECT * FROM users WHERE name = 'ada'").rows).toEqual(
      expected((r) => r.name === 'ada'),
    );
  });

  it('applies every conjunct of an AND', () => {
    expect(run('SELECT * FROM users WHERE age > 30 AND age < 50').rows).toEqual(
      expected((r) => (r.age as number) > 30 && (r.age as number) < 50),
    );
  });

  it('rechecks the residual after an index lookup, and can return nothing', () => {
    const row5 = users.rows.find((r) => r.id === 5)!;
    const satisfied = `SELECT * FROM users WHERE id = 5 AND age = ${String(row5.age)}`;
    const violated = 'SELECT * FROM users WHERE id = 5 AND age = 999';

    expect(run(satisfied).rows).toEqual([row5]);
    expect(run(violated).rows).toEqual([]);
  });

  it('projects only the requested columns', () => {
    const rows = run('SELECT id, name FROM users WHERE id = 5').rows;
    expect(rows).toEqual([{ id: 5, name: users.rows.find((r) => r.id === 5)!.name }]);
  });

  it('gives the same answer whichever access method the optimizer picks', () => {
    // `id = 5` uses the index; `id < 6 AND id > 4` cannot, so it scans.
    expect(run('SELECT * FROM users WHERE id = 5').rows).toEqual(
      run('SELECT * FROM users WHERE id > 4 AND id < 6').rows,
    );
  });

  it('is unaffected by the replacement policy', () => {
    for (const sql of ['SELECT * FROM users WHERE age > 30', 'SELECT * FROM users WHERE id = 5']) {
      const lru = runQuery(sql, db, { ...DEFAULT_ENGINE_OPTIONS, policy: 'lru' }).rows;
      const clock = runQuery(sql, db, { ...DEFAULT_ENGINE_OPTIONS, policy: 'clock' }).rows;
      expect(clock, sql).toEqual(lru);
    }
  });

  it('is unaffected by page size or pool size', () => {
    const sql = 'SELECT * FROM users WHERE age > 30';
    const base = run(sql).rows;
    for (const over of [{ rowsPerPage: 1 }, { rowsPerPage: 64 }, { bufferFrames: 1 }]) {
      expect(runQuery(sql, db, { ...DEFAULT_ENGINE_OPTIONS, ...over }).rows).toEqual(base);
    }
  });
});

describe('LIMIT — the Volcano short-circuit', () => {
  it('caps the row count', () => {
    expect(run('SELECT * FROM users LIMIT 5').rows).toHaveLength(5);
    expect(run('SELECT * FROM users LIMIT 5').rows).toEqual(users.rows.slice(0, 5));
  });

  it('LIMIT 0 returns nothing', () => {
    expect(run('SELECT * FROM users LIMIT 0').rows).toEqual([]);
  });

  it('a LIMIT past the row count returns everything, not an error', () => {
    expect(run('SELECT * FROM users LIMIT 9999').rows).toEqual(users.rows);
  });

  it('applies after WHERE, on the filtered rows', () => {
    const filtered = expected((r) => (r.age as number) > 30);
    expect(run('SELECT * FROM users WHERE age > 30 LIMIT 3').rows).toEqual(filtered.slice(0, 3));
  });

  it('composes with an indexed lookup, which already returns at most one row', () => {
    expect(run('SELECT * FROM users WHERE id = 5 LIMIT 1').rows).toEqual(
      run('SELECT * FROM users WHERE id = 5').rows,
    );
  });

  it('is the visible short-circuit: fewer pages load than an unbounded scan', () => {
    const diskReads = (sql: string) =>
      run(sql).events.filter((e) => e.stage === 'buffer' && e.action === 'load').length;
    expect(diskReads('SELECT * FROM users LIMIT 1')).toBeLessThan(diskReads('SELECT * FROM users'));
  });

  it('the scan never produces more rows than the cap, even though more exist', () => {
    const { events } = run('SELECT * FROM users LIMIT 3');
    const seqScanRows = events.filter((e) => e.stage === 'execute' && e.op === 'SeqScan');
    expect(seqScanRows.length).toBeLessThanOrEqual(3);
    const last = seqScanRows.at(-1);
    expect(last?.stage === 'execute' && last.rowsProduced).toBe(3);
  });

  it('releases the lock it was holding when the cap cuts the scan off', () => {
    const { events } = run('SELECT * FROM users LIMIT 1');
    let held = 0;
    for (const e of events) {
      if (e.stage !== 'lock') continue;
      held += e.action === 'acquire' ? 1 : -1;
    }
    expect(held).toBe(0);
  });
});

describe('ORDER BY — a real external merge sort', () => {
  it('sorts ascending, matching a plain JS sort of the same rows', () => {
    const reference = [...users.rows].sort((a, b) => (a.age as number) - (b.age as number));
    expect(run('SELECT * FROM users ORDER BY age').rows).toEqual(reference);
  });

  it('sorts descending', () => {
    const reference = [...users.rows].sort((a, b) => (b.age as number) - (a.age as number));
    expect(run('SELECT * FROM users ORDER BY age DESC').rows).toEqual(reference);
  });

  it('is stable: two rows with the same age keep their table order', () => {
    // Two seed rows share age 20 (`ada`, id 1, and `turing`, id 46) — ada
    // comes first in the table, and should stay first in the tie.
    const rows = run('SELECT * FROM users ORDER BY age').rows;
    const tied = rows.filter((r) => r.age === 20).map((r) => r.id);
    expect(tied).toEqual([1, 46]);
  });

  it('sorts a string column lexicographically', () => {
    const reference = [...users.rows].sort((a, b) => ((a.name as string) < (b.name as string) ? -1 : 1));
    expect(run('SELECT * FROM users ORDER BY name').rows).toEqual(reference);
  });

  it('composes with WHERE — sorts only the filtered rows', () => {
    const reference = users.rows
      .filter((r) => (r.age as number) > 30)
      .sort((a, b) => (a.age as number) - (b.age as number));
    expect(run('SELECT * FROM users WHERE age > 30 ORDER BY age').rows).toEqual(reference);
  });

  it('composes with LIMIT — caps the fully-sorted output, not a partial scan', () => {
    const reference = [...users.rows].sort((a, b) => (b.age as number) - (a.age as number)).slice(0, 3);
    expect(run('SELECT * FROM users ORDER BY age DESC LIMIT 3').rows).toEqual(reference);
  });

  it('projects after sorting — a narrowed SELECT list still sorts correctly', () => {
    const reference = [...users.rows]
      .sort((a, b) => (a.age as number) - (b.age as number))
      .map((r) => ({ name: r.name }));
    expect(run('SELECT name FROM users ORDER BY age').rows).toEqual(reference);
  });

  it('composes with an indexed equality — one row, trivially "sorted"', () => {
    expect(run('SELECT * FROM users WHERE id = 5 ORDER BY age').rows).toEqual(
      run('SELECT * FROM users WHERE id = 5').rows,
    );
  });

  it('rejects an unknown ORDER BY column, pointing at it', () => {
    const out = run('SELECT * FROM users ORDER BY nope');
    expect(out.error?.message).toMatch(/no column called `nope`/);
    expect(out.error?.hint).toMatch(/id, name, email, age/);
  });

  it('is a real spill: buffer write events appear, and only when ORDER BY is used', () => {
    const writes = (events: StepEvent[]) =>
      events.filter((e) => e.stage === 'buffer' && e.action === 'write');
    expect(writes(run('SELECT * FROM users ORDER BY age').events).length).toBeGreaterThan(0);
    expect(writes(run('SELECT * FROM users').events)).toHaveLength(0);
  });

  it('the Sort operator produces nothing while it is still spilling, then streams every row once', () => {
    const { events } = run('SELECT * FROM users ORDER BY age');
    const counts = events.flatMap((e) =>
      e.stage === 'execute' && e.op === 'Sort' ? [e.rowsProduced] : [],
    );
    // Materialising and spilling narrates as a run of `rowsProduced: 0`
    // events — Sort has nothing to show yet — then streaming climbs by one
    // per row, ending at the row count.
    const firstNonZero = counts.findIndex((n) => n > 0);
    expect(firstNonZero).toBeGreaterThan(0);
    expect(counts.slice(0, firstNonZero).every((n) => n === 0)).toBe(true);
    expect(counts.slice(firstNonZero)).toEqual(
      Array.from({ length: users.rows.length }, (_, i) => i + 1),
    );
  });

  it('handles NULLs: last ascending, first descending, over a constructed table', () => {
    const withNulls = {
      tables: {
        t: {
          name: 't',
          columns: ['id', 'v'],
          rows: [
            { id: 1, v: 3 },
            { id: 2, v: null },
            { id: 3, v: 1 },
          ],
        },
      },
    };
    expect(runQuery('SELECT * FROM t ORDER BY v', withNulls).rows.map((r) => r.id)).toEqual([3, 1, 2]);
    expect(runQuery('SELECT * FROM t ORDER BY v DESC', withNulls).rows.map((r) => r.id)).toEqual([
      2, 1, 3,
    ]);
  });

  it('works on a larger table too — the reserved spill space is enough', () => {
    const orders = DATASETS.orders.make();
    const { rows, error } = runQuery('SELECT * FROM orders ORDER BY total DESC', orders);
    expect(error).toBeUndefined();
    expect(rows).toEqual(
      [...orders.tables.orders!.rows].sort((a, b) => (b.total as number) - (a.total as number)),
    );
  });
});

describe('execution events', () => {
  const executeEvents = (events: StepEvent[]) =>
    events.flatMap((e) => (e.stage === 'execute' ? [e] : []));

  it('reports cumulative row counts that end at the true total', () => {
    const { events, rows } = run('SELECT * FROM users WHERE age > 30');
    const project = executeEvents(events).filter((e) => e.op === 'Project');
    expect(project[project.length - 1]?.rowsProduced).toBe(rows.length);
  });

  it('counts up by one per row, never backwards', () => {
    const { events } = run('SELECT * FROM users WHERE age > 30');
    const counts = executeEvents(events)
      .filter((e) => e.op === 'SeqScan')
      .map((e) => e.rowsProduced);
    expect(counts).toEqual(counts.map((_, i) => i + 1));
  });

  it('ends with exactly one result event carrying the rows', () => {
    const { events, rows } = run('SELECT * FROM users WHERE id = 5');
    const results = events.filter((e) => e.stage === 'result');
    expect(results).toHaveLength(1);
    expect(events[events.length - 1]).toBe(results[0]);
    expect(results[0]?.stage === 'result' && results[0].rows).toEqual(rows);
  });

  it('names one operator per node in the chosen plan', () => {
    const ops = new Set(executeEvents(run('SELECT id FROM users WHERE age > 30').events).map((e) => e.op));
    expect(ops).toEqual(new Set(['SeqScan', 'Project']));
  });
});
