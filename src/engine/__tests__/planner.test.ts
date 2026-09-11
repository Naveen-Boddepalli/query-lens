import { describe, expect, it } from 'vitest';
import { parse } from '../parser/parser.ts';
import { buildPlan } from '../planner/buildPlan.ts';
import { optimize, OPTIMIZER_RULES, scanPredicate } from '../planner/optimize.ts';
import { conjoin, conjuncts, equalityOn, exprToSql } from '../planner/plan.ts';
import type { Plan } from '../planner/plan.ts';
import { createSeedDatabase } from '../seed.ts';
import type { Table } from '../types.ts';

const db = createSeedDatabase();
const users = db.tables.users!;
const noIndex: Table = { ...users, indexedColumn: undefined as unknown as string };

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
  const steps = optimize(canonical, table);
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

describe('optimize — constant folding', () => {
  it('drops an always-true literal comparison, keeping the rest of the predicate', () => {
    const steps = optimize(plan('SELECT * FROM users WHERE 1 = 1 AND id = 5'), users);
    const folded = steps.find((s) => s.rule === 'constant-folding');
    expect(folded).toBeDefined();
    // constant-folding runs before predicate-pushdown, so the predicate still
    // sits on a Filter node here, not yet pushed into the scan.
    const root = folded!.plan;
    const filterNode = root.op === 'Project' && root.child.op === 'Filter' ? root.child : null;
    expect(filterNode && exprToSql(filterNode.predicate)).toBe('id = 5');
  });

  it('drops an always-true self-comparison (col = col)', () => {
    const p = final('SELECT * FROM users WHERE age = age');
    expect(shape(p)).toEqual(['Project', 'SeqScan']);
    expect(scanPredicate(p)).toBeUndefined();
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
      optimize(plan('SELECT * FROM users WHERE age > 30'), users).some((s) => s.rule === 'constant-folding'),
    ).toBe(false);
    expect(
      optimize(plan('SELECT * FROM users WHERE id = age'), users).some((s) => s.rule === 'constant-folding'),
    ).toBe(false);
  });

  it('does not fold a comparison against NULL — UNKNOWN, not foldable', () => {
    const steps = optimize(plan('SELECT * FROM users WHERE NULL = NULL AND id = 5'), users);
    expect(steps.some((s) => s.rule === 'constant-folding')).toBe(false);
  });

  it('does not fire when there is no WHERE, or nothing foldable', () => {
    expect(optimize(plan('SELECT * FROM users'), users)).toHaveLength(0);
    expect(optimize(plan('SELECT * FROM users WHERE age > 30'), users).map((s) => s.rule)).toEqual([
      'predicate-pushdown',
    ]);
  });
});

describe('optimize — predicate pushdown', () => {
  it('folds the Filter into the scan', () => {
    const steps = optimize(plan('SELECT * FROM users WHERE age > 30'), users);
    const pushdown = steps.find((s) => s.rule === 'predicate-pushdown');
    expect(pushdown).toBeDefined();
    expect(shape(pushdown!.plan)).toEqual(['Project', 'SeqScan']);
    expect(exprToSql(scanPredicate(pushdown!.plan)!)).toBe('age > 30');
  });

  it('does not fire when there is no WHERE', () => {
    expect(optimize(plan('SELECT * FROM users'), users)).toHaveLength(0);
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

  it('stays a SeqScan for a range predicate — v0 indexes answer equalities only', () => {
    expect(shape(final('SELECT * FROM users WHERE age > 30'))).toEqual(['Project', 'SeqScan']);
    expect(shape(final('SELECT * FROM users WHERE id > 5'))).toEqual(['Project', 'SeqScan']);
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
    expect(optimize(plan('SELECT * FROM users LIMIT 3'), users)).toHaveLength(0);
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
    expect(optimize(plan('SELECT * FROM users ORDER BY age'), users)).toHaveLength(0);
    expect(plan('SELECT * FROM users ORDER BY age')).toMatchObject({
      op: 'Project',
      child: { op: 'Sort', column: 'age' },
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
    const steps = optimize(plan('SELECT * FROM users WHERE id = 5'), users);
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
    expect(optimize(once, users)).toHaveLength(0);
  });
});

describe('optimize — rule filter (plan.md §22.3 /tools/planner)', () => {
  const sql = 'SELECT * FROM users WHERE id = 5';

  it('OPTIMIZER_RULES lists every rule, in run order', () => {
    expect([...OPTIMIZER_RULES]).toEqual(['constant-folding', 'predicate-pushdown', 'index-selection']);
  });

  it('an empty set runs no rules — the canonical plan is untouched', () => {
    expect(optimize(plan(sql), users, new Set())).toHaveLength(0);
  });

  it('with only predicate-pushdown, the scan stays a SeqScan (no index step)', () => {
    const steps = optimize(plan(sql), users, new Set(['predicate-pushdown']));
    expect(steps.map((s) => s.rule)).toEqual(['predicate-pushdown']);
    expect(shape(steps.at(-1)!.plan)).toEqual(['Project', 'SeqScan']);
  });

  it('index-selection cannot fire without pushdown — it needs the filter in the scan first', () => {
    // A real ordering lesson for the sandbox: turning pushdown off strands
    // index-selection with nothing to match (canonical is Project→Filter→SeqScan).
    expect(optimize(plan(sql), users, new Set(['index-selection']))).toHaveLength(0);
  });

  it('omitting the argument runs every rule, unchanged from before', () => {
    const withDefault = optimize(plan(sql), users);
    const withAll = optimize(plan(sql), users, new Set(OPTIMIZER_RULES));
    expect(withDefault.map((s) => s.rule)).toEqual(withAll.map((s) => s.rule));
  });
});
