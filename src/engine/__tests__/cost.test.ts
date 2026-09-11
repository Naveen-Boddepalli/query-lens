import { describe, expect, it } from 'vitest';
import { parse } from '../parser/parser.ts';
import { buildPlan } from '../planner/buildPlan.ts';
import { optimize } from '../planner/optimize.ts';
import {
  estimateIndexLevels,
  estimatePlan,
  rootEstimate,
  selectivityOf,
} from '../planner/cost.ts';
import { toPlanDisplay } from '../planner/plan.ts';
import type { Plan } from '../planner/plan.ts';
import { runQuery } from '../runQuery.ts';
import { createSeedDatabase } from '../seed.ts';
import { DEFAULT_ENGINE_OPTIONS } from '../types.ts';
import type { Table } from '../types.ts';

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
  const steps = optimize(canonical(sql), table);
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
    ]) {
      for (const est of estimatePlan(optimised(sql), users, RPP).values()) {
        expect(Number.isInteger(est.estRows)).toBe(true);
        expect(est.estRows).toBeGreaterThanOrEqual(0);
        expect(est.estPages).toBeGreaterThanOrEqual(1);
        expect(est.basis.length).toBeGreaterThan(0);
      }
    }
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
    expect(step?.label).toMatch(/Estimated cost decides it/);
    expect(step?.label).toMatch(/reads all \d+ pages/);
  });
});
