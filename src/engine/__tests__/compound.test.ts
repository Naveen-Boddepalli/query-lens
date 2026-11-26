import { describe, expect, it } from 'vitest';
import { runQuery } from '../runQuery.ts';
import { DATASETS } from '../datasets.ts';
import { compoundDisplayTree, parse, parseStatement } from '../parser/index.ts';
import { finalPlan } from '../explain.ts';
import { planToLatex, planToRelationalAlgebra } from '../../export/toRelationalAlgebra.ts';
import { DEFAULT_ENGINE_OPTIONS } from '../types.ts';
import type { EngineOptions, PlanNode, Row } from '../types.ts';

// shop: customers 1–12 (4, 9 and 12 never order); orders.customerId holds the other nine and two guest NULLs;
// products 1–8 (8, the vase, is never ordered).
const shop = () => DATASETS.shop.make();
const run = (sql: string, options: EngineOptions = DEFAULT_ENGINE_OPTIONS) => runQuery(sql, shop(), options);
const SORT: EngineOptions = { ...DEFAULT_ENGINE_OPTIONS, aggregateStrategy: 'sort' };
const values = (rows: readonly Row[]) => rows.map((r) => Object.values(r)[0] ?? null);
const sorted = (rows: readonly Row[]) => [...values(rows)].sort((a, b) => (a === null ? 1 : b === null ? -1 : Number(a) - Number(b)));

describe('compound queries — parsing (plan.md §27.5 S3)', () => {
  it('parses members, their operators, and the result’s own ORDER BY and LIMIT', () => {
    const parsed = parseStatement('SELECT id FROM customers UNION ALL SELECT customerId FROM orders EXCEPT SELECT id FROM products ORDER BY id DESC LIMIT 3 OFFSET 1');
    if (!parsed.ok) throw new Error(parsed.error.message);
    const ast = parsed.ast;
    if (ast.kind !== 'compound') throw new Error('expected a compound');
    expect(ast.members.map((m) => m.from.name)).toEqual(['customers', 'orders', 'products']);
    expect(ast.ops.map((o) => [o.op, o.all])).toEqual([['union', true], ['except', false]]);
    expect(ast.orderBy).toMatchObject({ column: 'id', direction: 'desc' });
    expect(ast.limit).toMatchObject({ value: 3, offset: 1 });
    // No member keeps an ORDER BY or a LIMIT of its own.
    for (const m of ast.members) {
      expect(m.orderBy).toBeUndefined();
      expect(m.limit).toBeUndefined();
    }
  });

  it('draws every member’s tree under one root, ids kept apart', () => {
    const parsed = parseStatement('SELECT id FROM customers INTERSECT SELECT customerId FROM orders');
    if (!parsed.ok || parsed.ast.kind !== 'compound') throw new Error('expected a compound');
    const tree = compoundDisplayTree(parsed.ast);
    expect(tree).toMatchObject({ kind: 'CompoundStatement', label: 'INTERSECT' });
    expect(tree.children?.map((c) => c.kind)).toEqual(['SelectStatement', 'SelectStatement']);
    const ids: string[] = [];
    const walk = (n: typeof tree) => { ids.push(n.id); (n.children ?? []).forEach(walk); };
    walk(tree);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each([
    ['INTERSECT mixed with UNION', 'SELECT id FROM customers INTERSECT SELECT id FROM products UNION SELECT id FROM orders', /cannot share a query/],
    ['INTERSECT mixed with EXCEPT', 'SELECT id FROM customers EXCEPT SELECT id FROM products INTERSECT SELECT id FROM orders', /cannot share a query/],
    ['INTERSECT ALL', 'SELECT id FROM customers INTERSECT ALL SELECT id FROM products', /INTERSECT ALL. is not supported/],
    ['EXCEPT ALL', 'SELECT id FROM customers EXCEPT ALL SELECT id FROM products', /EXCEPT ALL. is not supported/],
    ['UNION DISTINCT', 'SELECT id FROM customers UNION DISTINCT SELECT id FROM products', /not needed/],
    ['an ORDER BY on a member', 'SELECT id FROM customers ORDER BY id UNION SELECT id FROM products', /after the last SELECT/],
    ['a LIMIT on a member', 'SELECT id FROM customers LIMIT 2 UNION SELECT id FROM products', /after the last SELECT/],
    ['an ORDER BY that is not a result column', 'SELECT id FROM customers UNION SELECT id FROM products ORDER BY name', /not a column of the combined result/],
    ['an ORDER BY on an aggregate', 'SELECT id FROM customers UNION SELECT id FROM products ORDER BY COUNT(*)', /names a column of the combined result/],

    ['nothing after UNION', 'SELECT id FROM customers UNION', /Expected a SELECT after UNION/],
    ['a column selected twice', 'SELECT id, id FROM customers UNION SELECT id, name FROM products', /selected twice/],
  ] as const)('refuses %s', (_label, sql, message) => {
    const result = parseStatement(sql);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(message);
  });

  it('refuses a SELECT in parentheses, and says to write the SELECT itself', () => {
    const result = parseStatement('SELECT id FROM customers UNION (SELECT id FROM products)');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.hint).toMatch(/in parentheses is not supported/);
  });

  it('the one-SELECT entry point (the planner sandbox’s) refuses a compound, and says where it runs', () => {
    const result = parse('SELECT id FROM customers UNION SELECT id FROM products');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/one SELECT, not a UNION/);
      expect(result.error.hint).toMatch(/Playground/);
    }
  });

  it('refuses members of different widths, and an ORDER BY a SELECT * result does not have, when it runs', () => {
    const wide = run('SELECT id FROM customers UNION SELECT id, name FROM products');
    expect(wide.error?.message).toMatch(/the first returns 1, SELECT 2 returns 2/);
    const star = run('SELECT * FROM customers UNION SELECT * FROM customers ORDER BY price');
    expect(star.error?.message).toMatch(/`price` is not a column of the combined result/);
  });
});

describe('compound queries — results', () => {
  it.each([['hash', DEFAULT_ENGINE_OPTIONS], ['sort', SORT]] as const)('each operator’s answer on shop — %s', (_label, options) => {
    // The customers who never ordered, a third way: EXCEPT is not thrown by the guests' NULL.
    expect(sorted(run('SELECT id FROM customers EXCEPT SELECT customerId FROM orders', options).rows)).toEqual([4, 9, 12]);
    expect(sorted(run('SELECT id FROM customers INTERSECT SELECT customerId FROM orders', options).rows)).toEqual([1, 2, 3, 5, 6, 7, 8, 10, 11]);
    // UNION keeps one NULL, since set operators count NULLs as equal; UNION ALL keeps every row.
    expect(sorted(run('SELECT customerId FROM orders UNION SELECT id FROM customers', options).rows)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, null]);
    expect(run('SELECT customerId FROM orders UNION ALL SELECT id FROM customers', options).rows).toHaveLength(52);
    // The never-ordered product.
    expect(values(run('SELECT id FROM products EXCEPT SELECT productId FROM orders', options).rows)).toEqual([8]);
  });

  it('INTERSECT and EXCEPT return each row once, however often it repeats on either side', () => {
    const intersect = run('SELECT customerId FROM orders INTERSECT SELECT customerId FROM orders');
    expect(sorted(intersect.rows)).toEqual([1, 2, 3, 5, 6, 7, 8, 10, 11, null]);
    const except = run('SELECT customerId FROM orders EXCEPT SELECT id FROM customers WHERE id < 3');
    expect(sorted(except.rows)).toEqual([3, 5, 6, 7, 8, 10, 11, null]);
  });

  it('combines left to right: (a UNION b) EXCEPT c, not a UNION (b EXCEPT c)', () => {
    const rows = run('SELECT id FROM products UNION SELECT id FROM customers EXCEPT SELECT customerId FROM orders').rows;
    expect(sorted(rows)).toEqual([4, 9, 12]);
  });

  it('names the result’s columns after the first SELECT, matching the rest by position', () => {
    const rows = run('SELECT id, name FROM customers WHERE id = 1 UNION ALL SELECT price, name FROM products WHERE id = 2').rows;
    expect(rows).toEqual([{ id: 1, name: 'alice' }, { id: 220, name: 'desk' }]);
  });

  it('sorts and cuts the combined result, once', () => {
    const rows = run('SELECT name FROM customers UNION SELECT name FROM products ORDER BY name DESC LIMIT 3 OFFSET 1').rows;
    expect(values(rows)).toEqual(['shelf', 'rug', 'mug']);
  });

  it('runs members with a JOIN, an EXISTS or a GROUP BY of their own', () => {
    const rows = run(
      "SELECT customers.name FROM customers JOIN orders ON customers.id = orders.customerId WHERE orders.qty > 3 INTERSECT SELECT name FROM customers WHERE NOT EXISTS (SELECT * FROM orders WHERE orders.customerId = customers.id AND orders.qty = 1)",
    ).rows;
    const tables = shop().tables;
    const big = new Set(tables.orders!.rows.filter((o) => Number(o.qty) > 3).map((o) => o.customerId));
    const small = new Set(tables.orders!.rows.filter((o) => o.qty === 1).map((o) => o.customerId));
    const want = tables.customers!.rows.filter((c) => big.has(c.id ?? null) && !small.has(c.id ?? null)).map((c) => c.name);
    expect(values(rows).sort()).toEqual([...want].sort());
    const grouped = run('SELECT customerId, COUNT(*) FROM orders GROUP BY customerId EXCEPT SELECT id, 7 FROM customers').rows;
    expect(grouped.some((r) => r.customerId === 1)).toBe(false); // alice's seven orders are subtracted
  });
});

describe('compound queries — the plan and the trace', () => {
  const plan = (sql: string, options: EngineOptions = DEFAULT_ENGINE_OPTIONS): PlanNode => {
    const p = finalPlan(run(sql, options).events);
    if (!p) throw new Error('no plan');
    return p;
  };

  it('UNION is a Union all with a DISTINCT above it — hash or sort, as the strategy says', () => {
    expect(plan('SELECT id FROM customers UNION SELECT customerId FROM orders')).toMatchObject({ op: 'HashDistinct', children: [{ op: 'SetOp', label: 'Union all' }] });
    expect(plan('SELECT id FROM customers UNION SELECT customerId FROM orders', SORT)).toMatchObject({ op: 'SortDistinct', children: [{ op: 'SetOp' }] });
    expect(plan('SELECT id FROM customers UNION ALL SELECT customerId FROM orders')).toMatchObject({ op: 'SetOp', label: 'Union all' });
    expect(plan('SELECT id FROM customers EXCEPT SELECT customerId FROM orders')).toMatchObject({ op: 'SetOp', label: 'Except (hash)' });
  });

  it('reads as ∪, ∩ and − in relational algebra, and in LaTeX', () => {
    expect(planToRelationalAlgebra(plan('SELECT id FROM customers UNION ALL SELECT id FROM products'))).toMatch(/π_\{id\}\(customers\) ∪ π_\{id\}\(products\)/);
    expect(planToRelationalAlgebra(plan('SELECT id FROM customers INTERSECT SELECT id FROM products'))).toMatch(/ ∩ /);
    expect(planToRelationalAlgebra(plan('SELECT id FROM customers EXCEPT SELECT id FROM products'))).toMatch(/ − /);
    expect(planToLatex(plan('SELECT id FROM customers EXCEPT SELECT id FROM products'))).toMatch(/\\setminus/);
  });

  it('tells the stages in order: every member planned, the set operation built, every member optimized, then run', () => {
    const { events } = run("SELECT id FROM customers WHERE city = 'Paris' UNION SELECT customerId FROM orders WHERE qty > 2");
    const order = ['parse', 'plan', 'optimize', 'execute', 'result'];
    const stages = events.map((e) => e.stage).filter((s) => order.includes(s));
    for (let i = 1; i < stages.length; i++) expect(order.indexOf(stages[i]!)).toBeGreaterThanOrEqual(order.indexOf(stages[i - 1]!));
    expect(events.some((e) => e.stage === 'plan' && e.label.startsWith('SELECT 2 of 2.'))).toBe(true);
    expect(events.some((e) => e.stage === 'plan' && /Union all node with a HashDistinct above it/.test(e.label))).toBe(true);
    expect(events.some((e) => e.stage === 'optimize' && e.label.startsWith('SELECT 1 of 2. Predicate pushdown'))).toBe(true);
    expect(events.find((e) => e.stage === 'result')?.predictable).toBeUndefined();
  });

  it('reads a table two SELECTs share from the same pages — the second finds them in the pool', () => {
    const { events } = run('SELECT id FROM customers UNION SELECT id FROM customers');
    const misses = events.filter((e) => e.stage === 'buffer' && e.action === 'miss').length;
    const hits = events.filter((e) => e.stage === 'buffer' && e.action === 'hit').length;
    expect(misses).toBe(Math.ceil(12 / DEFAULT_ENGINE_OPTIONS.rowsPerPage));
    expect(hits).toBeGreaterThan(0);
  });

  it('EXPLAIN ANALYZE shows the set operation over both members, with actual rows', () => {
    const lines = run('EXPLAIN ANALYZE SELECT id FROM customers EXCEPT SELECT customerId FROM orders').rows.map((r) => String(Object.values(r)[0]));
    expect(lines[0]).toMatch(/^Except \(hash\) {2}columns: id · SELECT 2 matched by position: customerId .*actual 3 rows/);
    expect(lines.filter((l) => /SeqScan/.test(l))).toHaveLength(2);
  });
});
