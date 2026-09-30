import { describe, expect, it } from 'vitest';
import { parse } from '../parser/parser.ts';
import { buildPlan } from '../planner/buildPlan.ts';
import { optimize } from '../planner/optimize.ts';
import {
  boundedRangeSelectivity,
  estimateIndexLevels,
  estimatePlan,
  ndistinct,
  rootEstimate,
  selectivityOf,
} from '../planner/cost.ts';
import { toPlanDisplay } from '../planner/plan.ts';
import type { Plan } from '../planner/plan.ts';
import { runQuery } from '../runQuery.ts';
import { createSeedDatabase } from '../seed.ts';
import { analyzeTable } from '../stats.ts';
import { DEFAULT_ENGINE_OPTIONS } from '../types.ts';
import type { Row, Table } from '../types.ts';

const db = createSeedDatabase();
const users = db.tables.users!;
const RPP = DEFAULT_ENGINE_OPTIONS.rowsPerPage;

function ast(sql: string) {
  const out = parse(sql);
  if (!out.ok) throw new Error(out.error.message);
  return out.ast;
}
const canonical = (sql: string) => buildPlan(ast(sql));
const optimised = (sql: string, table: Table = users): Plan => {
  const steps = optimize(canonical(sql), table, RPP);
  return steps.at(-1)?.plan ?? canonical(sql);
};

/** The actual row count `runQuery` produces, for comparing against the estimate. */
const actualRows = (sql: string) => runQuery(sql, createSeedDatabase()).rows.length;

describe('selectivityOf', () => {
  it('an equality on a unique column is 1/ndistinct', () => {
    const s = selectivityOf(ast('SELECT * FROM users WHERE id = 5').where!, users);
    expect(s.fraction).toBeCloseTo(1 / users.rows.length);
    expect(s.basis).toMatch(/1\/48 on id/);
  });

  it('falls back to 0.1 for an equality on a column with no stats', () => {
    const s = selectivityOf(ast('SELECT * FROM users WHERE missing = 1').where!, users);
    expect(s.fraction).toBe(0.1);
  });

  it('estimates an open range by linear interpolation over the column min–max', () => {
    // age runs 20..64. `age > 30` keeps (64-30)/(64-20) ≈ 0.773 of the rows.
    const s = selectivityOf(ast('SELECT * FROM users WHERE age > 30').where!, users);
    expect(s.fraction).toBeCloseTo(34 / 44, 5);
    expect(s.basis).toMatch(/%/);
  });

  it('a below-range mirrors an above-range', () => {
    const above = selectivityOf(ast('SELECT * FROM users WHERE age > 40').where!, users).fraction;
    const below = selectivityOf(ast('SELECT * FROM users WHERE age < 40').where!, users).fraction;
    expect(above + below).toBeCloseTo(1, 5);
  });

  it('clamps an impossible range to zero', () => {
    expect(selectivityOf(ast('SELECT * FROM users WHERE age > 999').where!, users).fraction).toBe(0);
  });

  it('multiplies conjuncts and assumes independence', () => {
    const and = ast('SELECT * FROM users WHERE id = 5 AND age > 30').where!;
    const both = selectivityOf(and, users).fraction;
    const idOnly = selectivityOf(ast('SELECT * FROM users WHERE id = 5').where!, users).fraction;
    const ageOnly = selectivityOf(ast('SELECT * FROM users WHERE age > 30').where!, users).fraction;
    expect(both).toBeCloseTo(idOnly * ageOnly, 10);
  });
});

describe('boundedRangeSelectivity (plan.md §23.1 — IndexRangeScan)', () => {
  // age runs 20..64 across the 48 seed rows (the same fact selectivityOf's
  // own tests above use).
  it('a low bound only agrees with rangeSelectivity for the same predicate', () => {
    const bounded = boundedRangeSelectivity('age', 30, null, users).fraction;
    const viaSelectivityOf = selectivityOf(ast('SELECT * FROM users WHERE age > 30').where!, users).fraction;
    expect(bounded).toBeCloseTo(viaSelectivityOf, 10);
  });

  it('a high bound only agrees with rangeSelectivity for the same predicate', () => {
    const bounded = boundedRangeSelectivity('age', null, 30, users).fraction;
    const viaSelectivityOf = selectivityOf(ast('SELECT * FROM users WHERE age < 30').where!, users).fraction;
    expect(bounded).toBeCloseTo(viaSelectivityOf, 10);
  });

  it('both bounds compute the true interval overlap directly, not the product of two independent fractions', () => {
    // The honest number: (40-30)/(64-20).
    const direct = boundedRangeSelectivity('age', 30, 40, users).fraction;
    expect(direct).toBeCloseTo(10 / 44, 5);

    // What multiplying two independent rangeSelectivity fractions would give
    // instead — a real, different (and double-discounted) number, proving
    // this function does not take that shortcut.
    const above30 = boundedRangeSelectivity('age', 30, null, users).fraction;
    const below40 = boundedRangeSelectivity('age', null, 40, users).fraction;
    expect(direct).not.toBeCloseTo(above30 * below40, 5);
  });

  it('with neither bound and known stats, the whole column span is in range', () => {
    expect(boundedRangeSelectivity('age', null, null, users).fraction).toBeCloseTo(1, 10);
  });

  it('clamps an impossible bound order to zero rather than a negative fraction', () => {
    expect(boundedRangeSelectivity('age', 999, 0, users).fraction).toBe(0);
  });

  it('falls back to a labelled default with no numeric stats — ⅓ for one bound, ⅓×⅓ for both', () => {
    expect(boundedRangeSelectivity('missing', 5, null, users).fraction).toBeCloseTo(1 / 3, 10);
    expect(boundedRangeSelectivity('missing', 5, 10, users).fraction).toBeCloseTo(1 / 9, 10);
  });
});

describe('estimateIndexLevels', () => {
  it('grows with the row count and never drops below one', () => {
    expect(estimateIndexLevels(1)).toBe(1);
    expect(estimateIndexLevels(48)).toBeGreaterThanOrEqual(2);
    let last = 0;
    for (const n of [1, 10, 48, 120, 500, 5000, 100000]) {
      const levels = estimateIndexLevels(n);
      expect(levels).toBeGreaterThanOrEqual(last);
      last = levels;
    }
  });
});

describe('estimatePlan', () => {
  it('annotates every node in the tree', () => {
    const plan = canonical('SELECT id FROM users WHERE age > 30');
    const cost = estimatePlan(plan, users, RPP);
    let node: Plan | undefined = plan;
    while (node) {
      expect(cost.get(node), node.op).toBeDefined();
      node = node.op === 'Project' || node.op === 'Filter' ? node.child : undefined;
    }
  });

  it('every estimate is a non-negative integer row count and a page count of at least one', () => {
    for (const sql of [
      'SELECT * FROM users',
      'SELECT * FROM users WHERE id = 5',
      'SELECT * FROM users WHERE age > 30',
      'SELECT * FROM users WHERE id = 5 AND age > 30',
      "SELECT * FROM users WHERE name = 'ada'",
      'SELECT * FROM users WHERE age > 999',
      'SELECT * FROM users ORDER BY age',
      'SELECT * FROM users WHERE id = 5 ORDER BY age DESC LIMIT 1',
    ]) {
      for (const est of estimatePlan(optimised(sql), users, RPP).values()) {
        expect(Number.isInteger(est.estRows)).toBe(true);
        expect(est.estRows).toBeGreaterThanOrEqual(0);
        expect(est.estPages).toBeGreaterThanOrEqual(1);
        expect(est.basis.length).toBeGreaterThan(0);
      }
    }
  });

  it('Sort keeps the row estimate but adds its own spill page cost', () => {
    const unsorted = rootEstimate(optimised('SELECT * FROM users WHERE age > 30'), users, RPP);
    const sorted = rootEstimate(
      optimised('SELECT * FROM users WHERE age > 30 ORDER BY age'),
      users,
      RPP,
    );
    expect(sorted.estRows).toBe(unsorted.estRows);
    // A Sort's own I/O is real disk activity a Filter alone never adds.
    expect(sorted.estPages).toBeGreaterThan(unsorted.estPages);
  });

  it('LIMIT estimates the smaller of the child estimate and the cap', () => {
    const under = rootEstimate(optimised('SELECT * FROM users LIMIT 3'), users, RPP);
    expect(under.estRows).toBe(3);
    const over = rootEstimate(optimised('SELECT * FROM users LIMIT 9999'), users, RPP);
    expect(over.estRows).toBe(users.rows.length);
  });

  it('a bare scan estimates the whole table, every page', () => {
    const est = rootEstimate(canonical('SELECT * FROM users'), users, RPP);
    expect(est.estRows).toBe(users.rows.length);
    expect(est.estPages).toBe(Math.ceil(users.rows.length / RPP));
  });

  it('an index lookup estimates one row and far fewer pages than a scan', () => {
    const scan = rootEstimate(canonical('SELECT * FROM users'), users, RPP);
    const lookup = rootEstimate(optimised('SELECT * FROM users WHERE id = 5'), users, RPP);
    expect(lookup.estRows).toBe(1);
    expect(lookup.estPages).toBeLessThan(scan.estPages / 2);
    expect(lookup.estPages).toBe(estimateIndexLevels(users.rows.length) + 1);
  });

  it('lands within a few rows of the count the executor actually produces', () => {
    for (const sql of [
      'SELECT * FROM users WHERE id = 5',
      'SELECT * FROM users WHERE age > 30',
      'SELECT * FROM users WHERE age > 50',
      'SELECT * FROM users',
    ]) {
      const est = rootEstimate(optimised(sql), users, RPP).estRows;
      expect(Math.abs(est - actualRows(sql)), sql).toBeLessThanOrEqual(4);
    }
  });

  it('is deterministic', () => {
    const a = rootEstimate(optimised('SELECT * FROM users WHERE age > 30'), users, RPP);
    const b = rootEstimate(optimised('SELECT * FROM users WHERE age > 30'), users, RPP);
    expect(a).toEqual(b);
  });

  it('rootEstimate matches the root entry of estimatePlan', () => {
    const plan = optimised('SELECT * FROM users WHERE id = 5 AND age > 30');
    expect(rootEstimate(plan, users, RPP)).toEqual(estimatePlan(plan, users, RPP).get(plan));
  });
});

describe('estimatePlan — IndexOnlyScan', () => {
  it('estimates one row, and fewer pages than an ordinary index lookup', () => {
    const lookup = rootEstimate(optimised('SELECT id, name FROM users WHERE id = 5'), users, RPP);
    const indexOnly = rootEstimate(optimised('SELECT id FROM users WHERE id = 5'), users, RPP);
    expect(indexOnly.estRows).toBe(1);
    expect(indexOnly.estPages).toBeLessThan(lookup.estPages);
  });

  it('the page difference is exactly the one heap page an ordinary lookup fetches', () => {
    const lookup = rootEstimate(optimised('SELECT id, name FROM users WHERE id = 5'), users, RPP);
    const indexOnly = rootEstimate(optimised('SELECT id FROM users WHERE id = 5'), users, RPP);
    expect(lookup.estPages - indexOnly.estPages).toBe(1);
  });
});

describe('estimatePlan — IndexRangeScan', () => {
  it('a narrow range prices more pages than an equality IndexScan but still fewer than a full SeqScan', () => {
    const equality = rootEstimate(optimised('SELECT * FROM users WHERE id = 5'), users, RPP);
    // Narrow on purpose (48 rows, id 1..48): a wide range's per-row heap
    // touch can legitimately cost more than a full scan's page-sharing read
    // does (the honest reason a real optimizer sometimes prefers a table
    // scan) — that comparison belongs to the test right below this one, not
    // this one, which is about a range small enough to stay a clear win.
    const range = rootEstimate(optimised('SELECT * FROM users WHERE id > 44'), users, RPP);
    const fullScan = rootEstimate(canonical('SELECT * FROM users WHERE age > 30'), users, RPP);
    expect(range.estPages).toBeGreaterThan(equality.estPages);
    expect(range.estPages).toBeLessThan(fullScan.estPages);
  });

  it('a wide range can honestly cost more than a full scan — one heap touch per row, no page-sharing credit', () => {
    // The same simplification IndexScan's own single-row cost already makes,
    // just repeated per row: real page-sharing among rows on the same heap
    // page is not modelled, so a range wide enough to return many rows can
    // legitimately look pricier than reading every heap page once. A
    // genuine finding about the model, not a bug — matching how a real
    // optimizer sometimes prefers a table scan over a non-clustered index
    // range. `range-index-selection` now acts on exactly this finding
    // (plan.md §25.4 C5), so `id > 5` no longer optimises *into* this
    // plan — it is built directly here, the same shape the rule declined.
    const wideRange = rootEstimate({ op: 'IndexRangeScan', table: 'users', column: 'id', low: { value: 5, inclusive: false } }, users, RPP);
    const fullScan = rootEstimate(canonical('SELECT * FROM users WHERE age > 30'), users, RPP);
    expect(wideRange.estPages).toBeGreaterThan(fullScan.estPages);
  });

  it('a tighter BETWEEN estimates fewer rows than a single open bound', () => {
    const open = rootEstimate(optimised('SELECT * FROM users WHERE id > 10'), users, RPP);
    const between = rootEstimate(optimised('SELECT * FROM users WHERE id BETWEEN 10 AND 20'), users, RPP);
    expect(between.estRows).toBeLessThan(open.estRows);
  });

  it('a residual conjunct is folded into the estimate, same as IndexScan', () => {
    const withResidual = rootEstimate(
      optimised("SELECT * FROM users WHERE id > 10 AND name = 'ada'"),
      users,
      RPP,
    );
    const withoutResidual = rootEstimate(optimised('SELECT * FROM users WHERE id > 10'), users, RPP);
    expect(withResidual.estRows).toBeLessThanOrEqual(withoutResidual.estRows);
    expect(withResidual.basis).toMatch(/recheck/);
  });
});

describe('estimatePlan — HashAggregate', () => {
  it('with no GROUP BY, estimates exactly one row — the whole input is one group', () => {
    const est = rootEstimate(optimised('SELECT COUNT(*) FROM users'), users, RPP);
    expect(est.estRows).toBe(1);
  });

  it('with a GROUP BY, estimates the product of each column\'s distinct-value count, capped at the input', () => {
    const est = rootEstimate(optimised('SELECT age, COUNT(*) FROM users GROUP BY age'), users, RPP);
    expect(est.estRows).toBeGreaterThan(0);
    expect(est.estRows).toBeLessThanOrEqual(users.rows.length);
  });

  it('lands close to the actual distinct-group count the executor produces', () => {
    const est = rootEstimate(optimised('SELECT age, COUNT(*) FROM users GROUP BY age'), users, RPP).estRows;
    const actual = actualRows('SELECT age, COUNT(*) FROM users GROUP BY age');
    expect(Math.abs(est - actual)).toBeLessThanOrEqual(4);
  });

  it('is deterministic', () => {
    const a = rootEstimate(optimised('SELECT age, COUNT(*) FROM users GROUP BY age'), users, RPP);
    const b = rootEstimate(optimised('SELECT age, COUNT(*) FROM users GROUP BY age'), users, RPP);
    expect(a).toEqual(b);
  });
});

describe('toPlanDisplay with estimates', () => {
  it('carries estRows and estBasis as plain primitives', () => {
    const plan = canonical('SELECT * FROM users WHERE age > 30');
    const node = toPlanDisplay(plan, new Set(), estimatePlan(plan, users, RPP));
    expect(typeof node.estRows).toBe('number');
    expect(typeof node.estBasis).toBe('string');
    expect(structuredClone(node)).toEqual(node);
  });

  it('omits the fields entirely when no estimates are passed', () => {
    const node = toPlanDisplay(canonical('SELECT * FROM users WHERE age > 30'));
    expect('estRows' in node).toBe(false);
    expect('estBasis' in node).toBe(false);
  });
});

describe('the cost model in the trace', () => {
  it('puts an estimate on every plan-stage node', () => {
    const { events } = runQuery('SELECT * FROM users WHERE id = 5', db);
    const planEvents = events.filter((e) => e.stage === 'plan');
    expect(planEvents.length).toBeGreaterThan(0);
    for (const e of planEvents) {
      if (e.stage !== 'plan') continue;
      expect(e.planTree.estRows).toBeTypeOf('number');
    }
  });

  it('reconciles the estimate against the real count in the result narration', () => {
    expect(runQuery('SELECT * FROM users WHERE id = 5', db).events.at(-1)?.label).toMatch(
      /cost model guessed ~1/i,
    );
    expect(runQuery('SELECT * FROM users WHERE age > 30', db).events.at(-1)?.label).toMatch(
      /cost model guessed ~\d+/i,
    );
  });

  it('justifies index selection with a scan-vs-lookup page comparison', () => {
    const { events } = runQuery('SELECT * FROM users WHERE id = 5', db);
    const step = events.find((e) => e.stage === 'optimize' && e.rule === 'index-selection');
    expect(step?.label).toMatch(/Estimated cost agrees/);
    expect(step?.label).toMatch(/reads all \d+ pages/);
  });
});

describe('ANALYZE-aware selectivity (plan.md §25.4 C1)', () => {
  // `age` runs 20..64 across the seed's 48 rows and has three repeated values — the same table every other
  // describe block above uses, `ANALYZE`d once here so its estimates can be compared with and without stats.
  const analyzed: Table = { ...users, stats: analyzeTable(users) };

  it('an equality on a most-common value reads its real frequency, not a blanket 1/ndistinct guess', () => {
    // age = 34 is one of the three repeated ages (frequency 2) — the live 1/ndistinct guess would say ~1.07.
    const withStats = selectivityOf(ast('SELECT * FROM users WHERE age = 34').where!, analyzed);
    expect(withStats.fraction).toBeCloseTo(2 / 48, 10);
    expect(withStats.basis).toMatch(/most common value, ANALYZE/);

    const withoutStats = selectivityOf(ast('SELECT * FROM users WHERE age = 34').where!, users);
    expect(withoutStats.fraction).not.toBeCloseTo(2 / 48, 5);
  });

  it('an equality on a value that is not most-common still improves on a blanket guess', () => {
    const s = selectivityOf(ast('SELECT * FROM users WHERE age = 25').where!, analyzed);
    expect(s.basis).toMatch(/of the rest on age \(ANALYZE\)/);
    // The three repeated ages account for 6 of 48 rows; the other 42 rows spread over 42 distinct values.
    expect(s.fraction).toBeCloseTo((1 - 6 / 48) / 42, 10);
  });

  it('a range reads the real histogram instead of a linear min–max guess, and the two need not agree', () => {
    const withStats = boundedRangeSelectivity('age', 30, null, analyzed);
    expect(withStats.basis).toMatch(/histogram.*ANALYZE/);
    const withoutStats = boundedRangeSelectivity('age', 30, null, users);
    expect(withoutStats.basis).toMatch(/by range/);
    // Both estimate the same real fact (34 of 44 rows, ≈0.773) closely, but by a different, named method.
    expect(withStats.fraction).toBeCloseTo(34 / 44, 1);
  });

  it('ndistinct reads the stored count rather than rescanning the rows', () => {
    expect(ndistinct(analyzed, 'age')).toBe(analyzed.stats!.columns.age!.nDistinct);
    expect(ndistinct(users, 'age')).toBe(ndistinct(analyzed, 'age')); // freshly analyzed, so they still agree
  });

  it('null fraction is read from the snapshot, not counted live', () => {
    const rows = [{ a: 1 }, { a: null }, { a: null }, { a: 3 }];
    const table: Table = { name: 't', columns: ['a'], rows, stats: analyzeTable({ name: 't', columns: ['a'], rows }) };
    const s = selectivityOf(ast('SELECT * FROM t WHERE a IS NULL').where!, table);
    expect(s.fraction).toBeCloseTo(0.5, 10);
    expect(s.basis).toMatch(/ANALYZE/);
  });

  it('a stale snapshot keeps its old answer even after the table changes underneath it', () => {
    // ANALYZE saw the original 48 rows; imagine 20 more rows land with a since-common age it never saw.
    const grown: Row[] = [...users.rows, ...Array.from({ length: 20 }, (_, i) => ({ id: 100 + i, name: `x${String(i)}`, email: `x${String(i)}@x.org`, age: 99 }))];
    const stale: Table = { ...users, rows: grown, stats: analyzeTable(users) }; // stats from BEFORE the growth
    const fresh: Table = { ...users, rows: grown, stats: analyzeTable({ ...users, rows: grown }) };

    const staleEstimate = selectivityOf(ast('SELECT * FROM users WHERE age = 99').where!, stale);
    const freshEstimate = selectivityOf(ast('SELECT * FROM users WHERE age = 99').where!, fresh);

    expect(staleEstimate.fraction * grown.length).toBeLessThan(2); // the stale snapshot never saw age 99 at all
    expect(freshEstimate.fraction * grown.length).toBeCloseTo(20, 5); // the fresh one reads its real frequency
  });
});
