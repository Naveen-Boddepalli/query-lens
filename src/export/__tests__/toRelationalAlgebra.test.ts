import { describe, expect, it } from 'vitest';
import { createSeedDatabase, createJoinDemoDatabase, runQuery } from '../../engine/index.ts';
import type { PlanNode, StepEvent } from '../../engine/index.ts';
import { planToLatex, planToRelationalAlgebra, raLabel } from '../toRelationalAlgebra.ts';

/** The final plan tree the engine narrates — after the optimizer, exactly what runs. */
function finalPlan(sql: string, db = createSeedDatabase()): PlanNode {
  const { events, error } = runQuery(sql, db);
  if (error) throw new Error(error.message);
  const plans = events.filter((e): e is Extract<StepEvent, { stage: 'plan' | 'optimize' }> => e.stage === 'plan' || e.stage === 'optimize');
  const last = plans[plans.length - 1]!;
  return last.stage === 'optimize' ? last.after : last.planTree;
}
const ra = (sql: string, db?: ReturnType<typeof createSeedDatabase>) => planToRelationalAlgebra(finalPlan(sql, db)).trim();

describe('the algebra of a plan', () => {
  it('a bare SELECT * is just the relation — the π_{*} is left unwritten', () => {
    expect(ra('SELECT * FROM users')).toBe('users');
  });

  it('a projection over a selection over a relation', () => {
    // No index on age, so this is a SeqScan with the filter pushed in — and still σ over users.
    expect(ra('SELECT name FROM users WHERE age > 30')).toBe('π_{name}(σ_{age > 30}(users))');
  });

  it('an index lookup reads the same as a filtered scan — the algebra is logical, the plan is physical', () => {
    const plan = finalPlan('SELECT * FROM users WHERE id = 5');
    const scan = (function find(n: PlanNode): PlanNode | undefined {
      return n.op === 'IndexScan' ? n : (n.children ?? []).map(find).find(Boolean);
    })(plan);
    expect(scan?.label).toBe('IndexScan users.id'); // how
    expect(planToRelationalAlgebra(plan).trim()).toBe('σ_{id = 5}(users)'); // what
  });

  it('an index range scan becomes a selection on both bounds', () => {
    expect(ra('SELECT * FROM users WHERE id > 10 AND id <= 20')).toBe('σ_{id > 10 AND id <= 20}(users)');
  });

  it('a residual predicate the index cannot answer stays in the same σ', () => {
    expect(ra("SELECT * FROM users WHERE id = 5 AND name = 'x'")).toBe("σ_{id = 5 AND name = 'x'}(users)");
  });

  it('OR, NOT, IN and LIKE print as written', () => {
    expect(ra("SELECT * FROM users WHERE (age < 30 OR age IS NULL) AND name LIKE 'a%'")).toBe(
      "σ_{(age < 30 OR age IS NULL) AND name LIKE 'a%'}(users)",
    );
  });

  it('aggregation is γ with the grouping columns, then the aggregates', () => {
    expect(ra('SELECT age, COUNT(*) FROM users GROUP BY age')).toBe('π_{age, COUNT(*)}(γ_{age; COUNT(*)}(users))');
    expect(ra('SELECT COUNT(*), AVG(age) FROM users')).toBe('π_{COUNT(*), AVG(age)}(γ_{COUNT(*), AVG(age)}(users))');
  });

  it('HAVING is a σ above the γ', () => {
    expect(ra('SELECT age FROM users GROUP BY age HAVING COUNT(*) > 1')).toBe(
      'π_{age}(σ_{COUNT(*) > 1}(γ_{age; COUNT(*)}(users)))',
    );
  });

  it('ORDER BY is τ with an arrow, LIMIT is λ, DISTINCT is δ', () => {
    expect(ra('SELECT name FROM users ORDER BY age DESC LIMIT 3')).toBe('λ_{3}(π_{name}(τ_{age ↓}(users)))');
    expect(ra('SELECT DISTINCT age FROM users')).toBe('δ(π_{age}(users))');
    expect(ra('SELECT * FROM users ORDER BY id LIMIT 2 OFFSET 4')).toBe('λ_{2, offset 4}(τ_{id ↑}(users))');
  });

  it('a computed column shows its expression', () => {
    expect(ra('SELECT id, age * 2 AS double FROM users')).toBe('π_{id, age * 2 AS double}(users)');
  });

  it('a JOIN is infix, and the predicate pushed into a side becomes a σ on that side', () => {
    const db = createJoinDemoDatabase();
    expect(ra('SELECT authors.name FROM authors JOIN posts ON authors.id = posts.authorId', db)).toBe(
      'π_{authors.name}(authors ⋈_{authors.id = posts.authorId} posts)',
    );
    expect(
      planToRelationalAlgebra(
        finalPlan("SELECT authors.name FROM authors JOIN posts ON authors.id = posts.authorId WHERE authors.name = 'ada'", db),
        120,
      ).trim(),
    ).toBe("π_{authors.name}(σ_{name = 'ada'}(authors) ⋈_{authors.id = posts.authorId} posts)");
  });

  it('breaks a wide expression over lines, one operator per level, and stays valid when re-joined', () => {
    const sql = "SELECT DISTINCT name FROM users WHERE age > 30 AND name LIKE 'a%' AND id IN (1, 2, 3, 4, 5, 6, 7, 8) ORDER BY name DESC LIMIT 10 OFFSET 20";
    const text = planToRelationalAlgebra(finalPlan(sql), 40);
    expect(text.split('\n').length).toBeGreaterThan(4);
    expect(text).toMatch(/^λ_\{10, offset 20\}\(\n {2}δ\(\n/);
    // Collapsing the layout gives back the one-line form.
    const flat = planToRelationalAlgebra(finalPlan(sql), 1000).trim();
    expect(text.replace(/\n\s*/g, '')).toBe(flat);
  });
});

describe('raLabel — the node text in the tree view', () => {
  it('shows a relation by name and an operator with its subscript', () => {
    expect(raLabel({ symbol: 'rel', rel: 'users' })).toBe('users');
    expect(raLabel({ symbol: 'σ', sub: 'age > 30', rel: 'users' })).toBe('σ age > 30');
    expect(raLabel({ symbol: 'δ' })).toBe('δ');
  });

  it('every node the engine emits has a relational-algebra form', () => {
    const missing: string[] = [];
    const walk = (n: PlanNode) => {
      if (!n.ra) missing.push(n.op);
      (n.children ?? []).forEach(walk);
    };
    for (const sql of [
      'SELECT * FROM users',
      'SELECT DISTINCT age FROM users WHERE id > 3 ORDER BY age LIMIT 2 OFFSET 1',
      'SELECT age, COUNT(*) FROM users GROUP BY age HAVING COUNT(*) > 1',
      'SELECT * FROM users WHERE id = 5',
      'SELECT id FROM users WHERE id = 5',
    ]) walk(finalPlan(sql));
    expect(missing).toEqual([]);
  });
});

describe('LaTeX', () => {
  const latex = (sql: string) => planToLatex(finalPlan(sql)).trim();

  it('uses the standard symbols and escapes the rest', () => {
    expect(latex('SELECT name FROM users WHERE age >= 30')).toBe(
      '\\pi_{name}\\left(\\sigma_{age \\ge 30}\\left(\\text{users}\\right)\\right)',
    );
  });

  it('writes logic as symbols, and escapes underscores in names', () => {
    expect(latex("SELECT * FROM users WHERE age <> 3 AND NOT (id = 1 OR name = 'a_b')")).toBe(
      "\\sigma_{age \\ne 3 \\wedge \\neg (id = 1 \\vee name = 'a\\_b')}\\left(\\text{users}\\right)",
    );
  });

  it('a JOIN is \\bowtie', () => {
    expect(planToLatex(finalPlan('SELECT * FROM authors JOIN posts ON authors.id = posts.authorId', createJoinDemoDatabase())).trim()).toBe(
      '\\text{authors} \\bowtie_{authors.id = posts.authorId} \\text{posts}',
    );
  });

  it('a bare relation and a DISTINCT', () => {
    expect(latex('SELECT * FROM users')).toBe('\\text{users}');
    expect(latex('SELECT DISTINCT age FROM users')).toBe('\\delta\\left(\\pi_{age}\\left(\\text{users}\\right)\\right)');
  });
});
