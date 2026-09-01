import { describe, expect, it } from 'vitest';
import { parse } from '../parser/parser.ts';
import { buildPlan } from '../planner/buildPlan.ts';
import { optimize, scanPredicate } from '../planner/optimize.ts';
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
  while (node.op === 'Filter' || node.op === 'Project') {
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
