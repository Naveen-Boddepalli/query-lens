import { describe, expect, it } from 'vitest';
import { parse } from '../parser/parser.ts';
import { buildPlan } from '../planner/buildPlan.ts';
import { optimize, OPTIMIZER_RULES, scanPredicate } from '../planner/optimize.ts';
import { conjoin, conjuncts, equalityOn, exprToSql } from '../planner/plan.ts';
import type { Plan } from '../planner/plan.ts';
import { createSeedDatabase } from '../seed.ts';
import { DEFAULT_ENGINE_OPTIONS } from '../types.ts';
import type { Table } from '../types.ts';

const db = createSeedDatabase();
const users = db.tables.users!;
const noIndex: Table = { ...users, indexedColumns: [] };
const ROWS_PER_PAGE = DEFAULT_ENGINE_OPTIONS.rowsPerPage;

function ast(sql: string) {
  const out = parse(sql);
  if (!out.ok) throw new Error(out.error.message);
  return out.ast;
}

const plan = (sql: string) => buildPlan(ast(sql));

/** The chain of ops from root to leaf. */
function shape(p: Plan): string[] {
  const ops = [p.op];
  let node = p;
  while (
    node.op === 'Filter' ||
    node.op === 'HashAggregate' ||
    node.op === 'Sort' ||
    node.op === 'Project' ||
    node.op === 'Limit'
  ) {
    node = node.child;
    ops.push(node.op);
  }
  return ops;
}

function final(sql: string, table: Table = users): Plan {
  const canonical = plan(sql);
  const steps = optimize(canonical, table, ROWS_PER_PAGE);
  return steps.length === 0 ? canonical : steps[steps.length - 1]!.plan;
}

describe('predicate helpers', () => {
  it('flattens and rebuilds an AND chain', () => {
    const where = ast('SELECT * FROM users WHERE a = 1 AND b = 2 AND c = 3').where!;
    const parts = conjuncts(where);
    expect(parts).toHaveLength(3);
    expect(parts.map(exprToSql)).toEqual(['a = 1', 'b = 2', 'c = 3']);
    expect(exprToSql(conjoin(parts)!)).toBe('a = 1 AND b = 2 AND c = 3');
  });

  it('conjoin returns undefined for nothing', () => {
    expect(conjoin([])).toBeUndefined();
  });

  it('matches an equality in either operand order', () => {
    expect(equalityOn(ast('SELECT * FROM t WHERE id = 5').where!, 'id')).toBe(5);
    expect(equalityOn(ast('SELECT * FROM t WHERE 5 = id').where!, 'id')).toBe(5);
  });

  it('does not match a different column or a non-equality', () => {
    expect(equalityOn(ast('SELECT * FROM t WHERE age = 5').where!, 'id')).toBeUndefined();
    expect(equalityOn(ast('SELECT * FROM t WHERE id > 5').where!, 'id')).toBeUndefined();
  });
});

describe('buildPlan — the canonical shape', () => {
  it('is Project → Filter → SeqScan when there is a WHERE', () => {
    expect(shape(plan('SELECT * FROM users WHERE id = 5'))).toEqual([
      'Project',
      'Filter',
      'SeqScan',
    ]);
  });

  it('omits the Filter when there is no WHERE', () => {
    expect(shape(plan('SELECT * FROM users'))).toEqual(['Project', 'SeqScan']);
  });

  it('carries the projection list', () => {
    const p = plan('SELECT id, name FROM users');
    expect(p.op === 'Project' && p.columns).toEqual({ kind: 'columns', names: ['id', 'name'] });
  });

  it('leaves the scan unfiltered — pushing it down is the optimizer\'s job', () => {
    const p = plan('SELECT * FROM users WHERE id = 5');
    const scan = p.op === 'Project' && p.child.op === 'Filter' ? p.child.child : null;
    expect(scan).toMatchObject({ op: 'SeqScan' });
    expect(scan).not.toHaveProperty('filter');
  });

  it('wraps everything in a Limit, outermost, when there is a LIMIT', () => {
    expect(shape(plan('SELECT * FROM users WHERE id = 5 LIMIT 3'))).toEqual([
      'Limit',
      'Project',
      'Filter',
      'SeqScan',
    ]);
    const p = plan('SELECT * FROM users LIMIT 3');
    expect(p).toMatchObject({ op: 'Limit', count: 3 });
  });

  it('omits the Limit when there is no LIMIT', () => {
    expect(shape(plan('SELECT * FROM users'))).not.toContain('Limit');
  });

  it('inserts a Sort between Filter and Project when there is an ORDER BY', () => {
    expect(shape(plan('SELECT * FROM users WHERE id = 5 ORDER BY age'))).toEqual([
      'Project',
      'Sort',
      'Filter',
      'SeqScan',
    ]);
    const p = plan('SELECT * FROM users ORDER BY age DESC');
    expect(shape(p)).toEqual(['Project', 'Sort', 'SeqScan']);
    expect(p).toMatchObject({ op: 'Project', child: { op: 'Sort', column: 'age', direction: 'desc' } });
  });

  it('every clause together: Limit → Project → Sort → Filter → SeqScan', () => {
    expect(shape(plan('SELECT * FROM users WHERE id = 5 ORDER BY age DESC LIMIT 3'))).toEqual([
      'Limit',
      'Project',
      'Sort',
      'Filter',
      'SeqScan',
    ]);
  });

  it('omits the Sort when there is no ORDER BY', () => {
    expect(shape(plan('SELECT * FROM users'))).not.toContain('Sort');
  });
});

describe('buildPlan — HashAggregate', () => {
  it('inserts a HashAggregate between Project and the scan for a GROUP BY', () => {
    expect(shape(plan('SELECT age, COUNT(*) FROM users GROUP BY age'))).toEqual([
      'Project',
      'HashAggregate',
      'SeqScan',
    ]);
  });

  it('inserts a HashAggregate for a bare aggregate with no GROUP BY too', () => {
    expect(shape(plan('SELECT COUNT(*) FROM users'))).toEqual(['Project', 'HashAggregate', 'SeqScan']);
  });

  it('sits above Filter when there is also a WHERE', () => {
    expect(shape(plan('SELECT age, COUNT(*) FROM users WHERE age > 30 GROUP BY age'))).toEqual([
      'Project',
      'HashAggregate',
      'Filter',
      'SeqScan',
    ]);
  });

  it('carries the group columns and the aggregate specs', () => {
    const p = plan('SELECT age, SUM(id) FROM users GROUP BY age');
    const agg = p.op === 'Project' ? p.child : null;
    expect(agg).toMatchObject({
      op: 'HashAggregate',
      groupBy: ['age'],
      aggregates: [{ key: 'SUM(id)', fn: 'SUM', column: 'id' }],
    });
  });

  it('COUNT(*) carries a null column, not the string "*"', () => {
    const p = plan('SELECT COUNT(*) FROM users');
    const agg = p.op === 'Project' ? p.child : null;
    expect(agg).toMatchObject({ op: 'HashAggregate', aggregates: [{ fn: 'COUNT', column: null }] });
  });

  it('omits the HashAggregate for an ordinary SELECT with neither GROUP BY nor an aggregate', () => {
    expect(shape(plan('SELECT * FROM users'))).not.toContain('HashAggregate');
  });

  it("Project's columns are each item's canonical key, in SELECT-list order", () => {
    const p = plan('SELECT COUNT(*), age FROM users GROUP BY age');
    expect(p).toMatchObject({ op: 'Project', columns: { kind: 'columns', names: ['COUNT(*)', 'age'] } });
  });
});

describe('optimize — constant folding', () => {
  it('drops an always-true literal comparison, keeping the rest of the predicate', () => {
    const steps = optimize(plan('SELECT * FROM users WHERE 1 = 1 AND id = 5'), users, ROWS_PER_PAGE);
    const folded = steps.find((s) => s.rule === 'constant-folding');
    expect(folded).toBeDefined();
    // constant-folding runs before predicate-pushdown, so the predicate still
    // sits on a Filter node here, not yet pushed into the scan.
    const root = folded!.plan;
    const filterNode = root.op === 'Project' && root.child.op === 'Filter' ? root.child : null;
    expect(filterNode && exprToSql(filterNode.predicate)).toBe('id = 5');
  });

  it('does NOT fold a self-comparison (col = col): it is UNKNOWN, not TRUE, where the column is NULL', () => {
    const p = final('SELECT * FROM users WHERE age = age');
    expect(shape(p)).toEqual(['Project', 'SeqScan']);
    expect(exprToSql(scanPredicate(p)!)).toBe('age = age');
  });

  it('removes the Filter entirely when nothing else is left', () => {
    const p = final('SELECT * FROM users WHERE 5 > 3');
    expect(shape(p)).toEqual(['Project', 'SeqScan']);
    expect(scanPredicate(p)).toBeUndefined();
  });

  it('still lets a later rule pick up what folding left behind', () => {
    const p = final('SELECT * FROM users WHERE 1 = 1 AND id = 5');
    expect(shape(p)).toEqual(['Project', 'IndexScan']);
  });

  it('does not fold an always-false comparison — v0 has no "no rows" plan shape', () => {
    const p = final('SELECT * FROM users WHERE 1 = 2');
    expect(shape(p)).toEqual(['Project', 'SeqScan']);
    expect(exprToSql(scanPredicate(p)!)).toBe('1 = 2');
  });

  it('does not fold a column against a literal, or two different columns', () => {
    expect(
      optimize(plan('SELECT * FROM users WHERE age > 30'), users, ROWS_PER_PAGE).some((s) => s.rule === 'constant-folding'),
    ).toBe(false);
    expect(
      optimize(plan('SELECT * FROM users WHERE id = age'), users, ROWS_PER_PAGE).some((s) => s.rule === 'constant-folding'),
    ).toBe(false);
  });

  it('does not fold a comparison against NULL — UNKNOWN, not foldable', () => {
    const steps = optimize(plan('SELECT * FROM users WHERE NULL = NULL AND id = 5'), users, ROWS_PER_PAGE);
    expect(steps.some((s) => s.rule === 'constant-folding')).toBe(false);
  });

  it('does not fire when there is no WHERE, or nothing foldable', () => {
    expect(optimize(plan('SELECT * FROM users'), users, ROWS_PER_PAGE)).toHaveLength(0);
    expect(optimize(plan('SELECT * FROM users WHERE age > 30'), users, ROWS_PER_PAGE).map((s) => s.rule)).toEqual([
      'predicate-pushdown',
    ]);
  });
});

describe('optimize — predicate pushdown', () => {
  it('folds the Filter into the scan', () => {
    const steps = optimize(plan('SELECT * FROM users WHERE age > 30'), users, ROWS_PER_PAGE);
    const pushdown = steps.find((s) => s.rule === 'predicate-pushdown');
    expect(pushdown).toBeDefined();
    expect(shape(pushdown!.plan)).toEqual(['Project', 'SeqScan']);
    expect(exprToSql(scanPredicate(pushdown!.plan)!)).toBe('age > 30');
  });

  it('does not fire when there is no WHERE', () => {
    expect(optimize(plan('SELECT * FROM users'), users, ROWS_PER_PAGE)).toHaveLength(0);
  });

  it('preserves the predicate exactly', () => {
    const p = final('SELECT * FROM users WHERE age > 30 AND name = \'ada\'', noIndex);
    expect(exprToSql(scanPredicate(p)!)).toBe("age > 30 AND name = 'ada'");
  });
});

describe('optimize — index selection', () => {
  it('turns an equality on the indexed column into an IndexScan', () => {
    const p = final('SELECT * FROM users WHERE id = 5');
    expect(shape(p)).toEqual(['Project', 'IndexScan']);
    const scan = p.op === 'Project' ? p.child : null;
    expect(scan).toMatchObject({ op: 'IndexScan', column: 'id', key: 5 });
    // No recheck: the index fully answers this predicate.
    expect(scan).not.toHaveProperty('residual');
  });

  it('keeps unmatched conjuncts as a recheck — the index does not verify them', () => {
    const p = final('SELECT * FROM users WHERE id = 5 AND age > 30');
    const scan = p.op === 'Project' ? p.child : null;
    expect(scan).toMatchObject({ op: 'IndexScan', key: 5 });
    expect(scan && scan.op === 'IndexScan' && exprToSql(scan.residual!)).toBe('age > 30');
  });

  it('stays a SeqScan for a range predicate on an unindexed column', () => {
    expect(shape(final('SELECT * FROM users WHERE age > 30'))).toEqual(['Project', 'SeqScan']);
  });

  it('a range predicate on the indexed column becomes an IndexRangeScan instead (range-index-selection, plan.md §23.1)', () => {
    expect(shape(final('SELECT * FROM users WHERE id > 44'))).toEqual(['Project', 'IndexRangeScan']);
  });

  it('stays a SeqScan when the equality is on an unindexed column', () => {
    expect(shape(final("SELECT * FROM users WHERE name = 'ada'"))).toEqual([
      'Project',
      'SeqScan',
    ]);
  });

  it('stays a SeqScan when the table has no index at all', () => {
    expect(shape(final('SELECT * FROM users WHERE id = 5', noIndex))).toEqual([
      'Project',
      'SeqScan',
    ]);
  });
});

describe('optimize — index selection with two candidate indexes (plan.md §22.2)', () => {
  // `id` is unique (100 distinct of 100 rows); `category` is not (10 distinct, 10 rows each — plan.md §25.4 C5
  // needs enough rows for a B+Tree's own overhead to honestly pay for itself, which the original 4-row table never
  // gave either index a chance to prove). `id` is declared *second* — the choice has to be about selectivity, not
  // declaration order, or this table would prove nothing.
  const things: Table = {
    name: 'things',
    columns: ['id', 'category'],
    rows: Array.from({ length: 100 }, (_, i) => ({ id: i + 1, category: String.fromCharCode(97 + Math.floor(i / 10)) })),
    indexedColumns: ['category', 'id'],
  };

  it('with only one matching conjunct, behaves exactly as a single-index table would', () => {
    const p = final('SELECT * FROM things WHERE category = \'a\'', things);
    expect(p).toMatchObject({ op: 'Project', child: { op: 'IndexScan', column: 'category', key: 'a' } });
  });

  it('with two matching conjuncts, picks the more selective index and rechecks the other', () => {
    const p = final("SELECT * FROM things WHERE category = 'a' AND id = 2", things);
    const scan = p.op === 'Project' ? p.child : null;
    // id (100 distinct) beats category (10 distinct) — chosen even though it
    // was declared second in indexedColumns.
    expect(scan).toMatchObject({ op: 'IndexScan', column: 'id', key: 2 });
    expect(scan && scan.op === 'IndexScan' && exprToSql(scan.residual!)).toBe("category = 'a'");
  });

  it('names the runner-up and the selectivity numbers in the narration', () => {
    const steps = optimize(plan("SELECT * FROM things WHERE category = 'a' AND id = 2"), things, ROWS_PER_PAGE);
    const step = steps.find((s) => s.rule === 'index-selection')!;
    expect(step.label).toMatch(/`id` is indexed \(chosen over `category` — 100 distinct values beats 10/);
  });

  it('a table with two indexes but only one matching conjunct needs no choice, and says nothing about one', () => {
    const steps = optimize(plan("SELECT * FROM things WHERE category = 'a'"), things, ROWS_PER_PAGE);
    const step = steps.find((s) => s.rule === 'index-selection')!;
    expect(step.label).not.toMatch(/chosen over/);
  });

  // Both indexed columns are fully unique — real data does this too (a
  // table's `id` and its `title`, say), and the narration must not claim one
  // "beats" the other when the true fact is a tie broken by declaration
  // order. Caught live in `/tools/planner` against the shipped `posts`
  // fixture (`id`/`title`, plan.md §22.2) before this test existed. 30 rows,
  // not 3 (plan.md §25.4 C5) — see `things`'s own comment above for why.
  const tied: Table = {
    name: 'tied',
    columns: ['id', 'slug'],
    rows: Array.from({ length: 30 }, (_, i) => ({ id: i + 1, slug: `s${String(i)}` })),
    indexedColumns: ['id', 'slug'],
  };

  it('never claims one index "beats" another when both are equally selective', () => {
    const steps = optimize(plan("SELECT * FROM tied WHERE id = 2 AND slug = 's1'"), tied, ROWS_PER_PAGE);
    const step = steps.find((s) => s.rule === 'index-selection')!;
    expect(step.label).not.toMatch(/beats/);
    expect(step.label).toMatch(/`id` is indexed \(tied with `slug` at 30 distinct values each/);
    expect(step.label).toMatch(/declared first/);
  });

  it('still picks a real IndexScan on a tie — declaration order, not an error', () => {
    const p = final("SELECT * FROM tied WHERE id = 2 AND slug = 's1'", tied);
    expect(p).toMatchObject({ op: 'Project', child: { op: 'IndexScan', column: 'id', key: 2 } });
  });
});

describe('optimize — range-index-selection (leaf-chaining range scans, plan.md §23.1)', () => {
  it('a single lower bound becomes an IndexRangeScan with only a low bound', () => {
    const p = final('SELECT * FROM users WHERE id > 44', users);
    const scan = p.op === 'Project' ? p.child : null;
    expect(scan).toMatchObject({ op: 'IndexRangeScan', column: 'id', low: { value: 44, inclusive: false } });
    expect(scan).not.toHaveProperty('high');
  });

  it('>= sets inclusive: true on the low bound', () => {
    const p = final('SELECT * FROM users WHERE id >= 44', users);
    const scan = p.op === 'Project' ? p.child : null;
    expect(scan).toMatchObject({ op: 'IndexRangeScan', low: { value: 44, inclusive: true } });
  });

  it('a single upper bound becomes an IndexRangeScan with only a high bound', () => {
    const p = final('SELECT * FROM users WHERE id < 6', users);
    const scan = p.op === 'Project' ? p.child : null;
    expect(scan).toMatchObject({ op: 'IndexRangeScan', column: 'id', high: { value: 6, inclusive: false } });
    expect(scan).not.toHaveProperty('low');
  });

  it('a BETWEEN (desugared to two conjuncts) sets both bounds, inclusive on each end', () => {
    const p = final('SELECT * FROM users WHERE id BETWEEN 40 AND 44', users);
    const scan = p.op === 'Project' ? p.child : null;
    expect(scan).toMatchObject({
      op: 'IndexRangeScan',
      column: 'id',
      low: { value: 40, inclusive: true },
      high: { value: 44, inclusive: true },
    });
  });

  it('a conjunct the range cannot answer stays a residual recheck', () => {
    const p = final("SELECT * FROM users WHERE id > 10 AND name = 'ada'", users);
    const scan = p.op === 'Project' ? p.child : null;
    expect(scan).toMatchObject({ op: 'IndexRangeScan', column: 'id' });
    expect(scan && scan.op === 'IndexRangeScan' && exprToSql(scan.residual!)).toBe("name = 'ada'");
  });

  it('stays a SeqScan when the range is on an unindexed column', () => {
    expect(shape(final('SELECT * FROM users WHERE age > 30'))).toEqual(['Project', 'SeqScan']);
  });

  it('an equality on the same table always wins over a range — index-selection fires first, this rule never touches an IndexScan', () => {
    // `id` is the only index; an equality on it always beats any range on
    // any column, by rule order alone, never a cost-model comparison.
    const p = final('SELECT * FROM users WHERE id = 5 AND age > 10', users);
    expect(shape(p)).toEqual(['Project', 'IndexScan']);
  });

  // 40 rows, not 4 (plan.md §25.4 C5) — see `things`'s own comment above for why.
  const spans: Table = {
    name: 'spans',
    columns: ['id', 'ord'],
    rows: Array.from({ length: 40 }, (_, i) => ({ id: i + 1, ord: (i + 1) * 10 })),
    indexedColumns: ['id', 'ord'],
  };

  it('with two range-indexable columns, picks the narrower estimated range and rechecks the other', () => {
    // `id`'s own min/max is 1..40, so `id > 37` is a narrow slice of its span; `ord`'s
    // min/max is 10..400, and its own bound (10) sits exactly at that min, so
    // `ord > 10` spans the column's *entire* range — id is the narrower
    // fraction, and should win on that basis.
    const p = final('SELECT * FROM spans WHERE id > 37 AND ord > 10', spans);
    const scan = p.op === 'Project' ? p.child : null;
    expect(scan).toMatchObject({ op: 'IndexRangeScan', column: 'id' });
    expect(scan && scan.op === 'IndexRangeScan' && exprToSql(scan.residual!)).toBe('ord > 10');
  });

  it('names the runner-up in the narration when there is a choice to make', () => {
    const steps = optimize(plan('SELECT * FROM spans WHERE id > 37 AND ord > 10'), spans, ROWS_PER_PAGE);
    const step = steps.find((s) => s.rule === 'range-index-selection')!;
    expect(step.label).toMatch(/`id` is indexed and.*chosen over `ord`/);
  });

  // 40 rows, not 4 (plan.md §25.4 C5) — see `things`'s own comment above for why.
  const tiedSpans: Table = {
    name: 'tiedSpans',
    columns: ['id', 'ord'],
    rows: Array.from({ length: 40 }, (_, i) => ({ id: i + 1, ord: i + 1 })),
    indexedColumns: ['id', 'ord'],
  };

  it('never claims one range "beats" another when both are equally selective', () => {
    // id and ord run over the exact same 1..40 values, so `> 36` on either is
    // an identical fraction — an honest tie, not a false "narrower" claim.
    const steps = optimize(plan('SELECT * FROM tiedSpans WHERE id > 36 AND ord > 36'), tiedSpans, ROWS_PER_PAGE);
    const step = steps.find((s) => s.rule === 'range-index-selection')!;
    expect(step.label).not.toMatch(/chosen over/);
    expect(step.label).toMatch(/tied with `ord`/);
    expect(step.label).toMatch(/declared first/);
  });
});

describe('optimize — chosen by cost, not just by shape (plan.md §25.4 C5)', () => {
  // Only two distinct values, so even the uniform 1/ndistinct estimate reads either one as matching about half the
  // table — a low-selectivity index in the shape of `logins.status`, plan.md §25.4 C5's own worked example.
  const logins: Table = {
    name: 'logins',
    columns: ['id', 'status'],
    rows: Array.from({ length: 50 }, (_, i) => ({ id: i + 1, status: i < 45 ? 'ok' : 'error' })),
    indexedColumns: ['id', 'status'],
  };

  it('an equality that matches the predicate is declined once the index would cost more than the scan', () => {
    expect(shape(final("SELECT * FROM logins WHERE status = 'ok'", logins))).toEqual(['Project', 'SeqScan']);
    const steps = optimize(plan("SELECT * FROM logins WHERE status = 'ok'"), logins, ROWS_PER_PAGE);
    const step = steps.find((s) => s.rule === 'index-selection')!;
    expect(step.changed.size).toBe(0);
    expect(step.label).toMatch(/estimated cost disagrees/);
    expect(step.label).toMatch(/no cheaper/);
  });

  it('a selective equality on the same table is still accepted — the gate compares cost, it does not just refuse', () => {
    // `id` is unique on the same 50-row table `status` just lost on: the difference is the cost, not the table.
    expect(shape(final('SELECT * FROM logins WHERE id = 5', logins))).toEqual(['Project', 'IndexScan']);
  });

  it('a wide range that matches the predicate is declined the same way', () => {
    const steps = optimize(plan('SELECT * FROM users WHERE id > 20'), users, ROWS_PER_PAGE);
    const step = steps.find((s) => s.rule === 'range-index-selection')!;
    expect(step.changed.size).toBe(0);
    expect(step.label).toMatch(/estimated cost disagrees/);
    expect(shape(final('SELECT * FROM users WHERE id > 20'))).toEqual(['Project', 'SeqScan']);
  });
});

describe('optimize — index-only scan', () => {
  it('rewrites an IndexScan to IndexOnlyScan when the SELECT list is only the indexed column', () => {
    const p = final('SELECT id FROM users WHERE id = 5');
    expect(shape(p)).toEqual(['Project', 'IndexOnlyScan']);
    const scan = p.op === 'Project' ? p.child : null;
    expect(scan).toMatchObject({ op: 'IndexOnlyScan', column: 'id', key: 5 });
  });

  it('fires for repeats of the same column too — SELECT id, id', () => {
    expect(shape(final('SELECT id, id FROM users WHERE id = 5'))).toEqual(['Project', 'IndexOnlyScan']);
  });

  it('does not fire when the SELECT list needs any other column', () => {
    expect(shape(final('SELECT id, name FROM users WHERE id = 5'))).toEqual(['Project', 'IndexScan']);
  });

  it('does not fire for SELECT *', () => {
    expect(shape(final('SELECT * FROM users WHERE id = 5'))).toEqual(['Project', 'IndexScan']);
  });

  it('does not fire when a residual conjunct is left over — the recheck needs the row', () => {
    expect(shape(final('SELECT id FROM users WHERE id = 5 AND age > 30'))).toEqual(['Project', 'IndexScan']);
  });

  it('does not fire on a plain SeqScan, or when the table has no index', () => {
    expect(shape(final('SELECT age FROM users WHERE age > 30'))).toEqual(['Project', 'SeqScan']);
    expect(shape(final('SELECT id FROM users WHERE id = 5', noIndex))).toEqual(['Project', 'SeqScan']);
  });

  it('carries LIMIT above it, same as an ordinary IndexScan', () => {
    expect(shape(final('SELECT id FROM users WHERE id = 5 LIMIT 1'))).toEqual([
      'Limit',
      'Project',
      'IndexOnlyScan',
    ]);
  });

  it('can be turned off independently, leaving a plain IndexScan', () => {
    const steps = optimize(
      plan('SELECT id FROM users WHERE id = 5'),
      users,
      ROWS_PER_PAGE,
      new Set(['predicate-pushdown', 'index-selection']),
    );
    expect(steps.map((s) => s.rule)).toEqual(['predicate-pushdown', 'index-selection']);
  });
});

describe('optimize — LIMIT stays transparent to the rewrites', () => {
  it('predicate pushdown still fires underneath a LIMIT', () => {
    const p = final('SELECT * FROM users WHERE age > 30 LIMIT 3');
    expect(shape(p)).toEqual(['Limit', 'Project', 'SeqScan']);
    expect(p).toMatchObject({ op: 'Limit', count: 3 });
    expect(exprToSql(scanPredicate(p)!)).toBe('age > 30');
  });

  it('index selection still fires underneath a LIMIT, and the count survives', () => {
    const p = final('SELECT * FROM users WHERE id = 5 LIMIT 1');
    expect(shape(p)).toEqual(['Limit', 'Project', 'IndexScan']);
    expect(p).toMatchObject({ op: 'Limit', count: 1 });
  });

  it('a bare LIMIT with no WHERE fires no rule, and the count is preserved', () => {
    expect(optimize(plan('SELECT * FROM users LIMIT 3'), users, ROWS_PER_PAGE)).toHaveLength(0);
    expect(plan('SELECT * FROM users LIMIT 3')).toMatchObject({ op: 'Limit', count: 3 });
  });
});

describe('optimize — Sort stays transparent to the rewrites', () => {
  it('predicate pushdown still fires underneath a Sort', () => {
    const p = final('SELECT * FROM users WHERE age > 30 ORDER BY age');
    expect(shape(p)).toEqual(['Project', 'Sort', 'SeqScan']);
    expect(p).toMatchObject({ op: 'Project', child: { op: 'Sort', column: 'age', direction: 'asc' } });
    expect(exprToSql(scanPredicate(p)!)).toBe('age > 30');
  });

  it('index selection still fires underneath a Sort, and the Sort survives above the IndexScan', () => {
    const p = final('SELECT * FROM users WHERE id = 5 ORDER BY age DESC');
    expect(shape(p)).toEqual(['Project', 'Sort', 'IndexScan']);
    expect(p).toMatchObject({ op: 'Project', child: { op: 'Sort', column: 'age', direction: 'desc' } });
  });

  it('composes with LIMIT too: Limit → Project → Sort → IndexScan', () => {
    const p = final('SELECT * FROM users WHERE id = 5 ORDER BY age LIMIT 1');
    expect(shape(p)).toEqual(['Limit', 'Project', 'Sort', 'IndexScan']);
  });

  it('a bare ORDER BY with no WHERE fires no rule, and the Sort is preserved', () => {
    expect(optimize(plan('SELECT * FROM users ORDER BY age'), users, ROWS_PER_PAGE)).toHaveLength(0);
    expect(plan('SELECT * FROM users ORDER BY age')).toMatchObject({
      op: 'Project',
      child: { op: 'Sort', column: 'age' },
    });
  });
});

describe('optimize — HashAggregate stays transparent to the rewrites', () => {
  it('predicate pushdown still fires underneath a HashAggregate — WHERE always applies before GROUP BY', () => {
    const p = final('SELECT age, COUNT(*) FROM users WHERE age > 30 GROUP BY age');
    expect(shape(p)).toEqual(['Project', 'HashAggregate', 'SeqScan']);
    expect(exprToSql(scanPredicate(p)!)).toBe('age > 30');
  });

  it('index selection still fires underneath a HashAggregate, and the aggregate survives above the IndexScan', () => {
    const p = final('SELECT id, COUNT(*) FROM users WHERE id = 5 GROUP BY id');
    expect(shape(p)).toEqual(['Project', 'HashAggregate', 'IndexScan']);
    expect(p).toMatchObject({ op: 'Project', child: { op: 'HashAggregate', groupBy: ['id'] } });
  });

  it('composes with LIMIT too: Limit → Project → HashAggregate → IndexScan', () => {
    const p = final('SELECT id, COUNT(*) FROM users WHERE id = 5 GROUP BY id LIMIT 1');
    expect(shape(p)).toEqual(['Limit', 'Project', 'HashAggregate', 'IndexScan']);
  });

  it('a bare GROUP BY with no WHERE fires no rule, and the HashAggregate is preserved', () => {
    expect(optimize(plan('SELECT age, COUNT(*) FROM users GROUP BY age'), users, ROWS_PER_PAGE)).toHaveLength(0);
    expect(plan('SELECT age, COUNT(*) FROM users GROUP BY age')).toMatchObject({
      op: 'Project',
      child: { op: 'HashAggregate', groupBy: ['age'] },
    });
  });
});

describe('optimize — general properties', () => {
  it('never loses a predicate, whichever rules fire', () => {
    for (const sql of [
      'SELECT * FROM users WHERE id = 5',
      'SELECT * FROM users WHERE age > 30',
      'SELECT * FROM users WHERE id = 5 AND age > 30',
      'SELECT * FROM users WHERE age > 30 AND id = 5',
      'SELECT * FROM users WHERE id = 5 AND age > 30 AND name = \'ada\'',
    ]) {
      const before = conjuncts(ast(sql).where!).map(exprToSql).sort();
      const p = final(sql);
      const after = [
        ...(p.op === 'Project' && p.child.op === 'IndexScan'
          ? [`${p.child.column} = ${String(p.child.key)}`]
          : []),
        ...(scanPredicate(p) ? conjuncts(scanPredicate(p)!).map(exprToSql) : []),
      ].sort();
      expect(after, sql).toEqual(before);
    }
  });

  it('marks exactly the node each rule produced', () => {
    const steps = optimize(plan('SELECT * FROM users WHERE id = 5'), users, ROWS_PER_PAGE);
    expect(steps.map((s) => s.rule)).toEqual(['predicate-pushdown', 'index-selection']);
    for (const step of steps) {
      expect(step.changed.size).toBe(1);
      // The marked node must actually be in the tree it belongs to.
      const found = [...step.changed][0]!;
      const inTree = step.plan.op === 'Project' && step.plan.child === found;
      expect(inTree, step.rule).toBe(true);
    }
  });

  it('is idempotent — re-running the rules changes nothing further', () => {
    const once = final('SELECT * FROM users WHERE id = 5');
    expect(optimize(once, users, ROWS_PER_PAGE)).toHaveLength(0);
  });
});

describe('optimize — rule filter (plan.md §22.3 /tools/planner)', () => {
  const sql = 'SELECT * FROM users WHERE id = 5';

  it('OPTIMIZER_RULES lists every rule, in run order', () => {
    expect([...OPTIMIZER_RULES]).toEqual([
      'constant-folding',
      'predicate-pushdown',
      'join-predicate-pushdown',
      'index-selection',
      'range-index-selection',
      'index-only-scan',
    ]);
  });

  it('an empty set runs no rules — the canonical plan is untouched', () => {
    expect(optimize(plan(sql), users, ROWS_PER_PAGE, new Set())).toHaveLength(0);
  });

  it('with only predicate-pushdown, the scan stays a SeqScan (no index step)', () => {
    const steps = optimize(plan(sql), users, ROWS_PER_PAGE, new Set(['predicate-pushdown']));
    expect(steps.map((s) => s.rule)).toEqual(['predicate-pushdown']);
    expect(shape(steps.at(-1)!.plan)).toEqual(['Project', 'SeqScan']);
  });

  it('index-selection cannot fire without pushdown — it needs the filter in the scan first', () => {
    // A real ordering lesson for the sandbox: turning pushdown off strands
    // index-selection with nothing to match (canonical is Project→Filter→SeqScan).
    expect(optimize(plan(sql), users, ROWS_PER_PAGE, new Set(['index-selection']))).toHaveLength(0);
  });

  it('omitting the argument runs every rule, unchanged from before', () => {
    const withDefault = optimize(plan(sql), users, ROWS_PER_PAGE);
    const withAll = optimize(plan(sql), users, ROWS_PER_PAGE, new Set(OPTIMIZER_RULES));
    expect(withDefault.map((s) => s.rule)).toEqual(withAll.map((s) => s.rule));
  });
});
