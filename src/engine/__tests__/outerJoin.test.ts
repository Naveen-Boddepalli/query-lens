import { describe, expect, it } from 'vitest';
import { runQuery } from '../runQuery.ts';
import { DATASETS } from '../datasets.ts';
import { finalPlan } from '../explain.ts';
import { planToLatex, planToRelationalAlgebra } from '../../export/toRelationalAlgebra.ts';
import { DEFAULT_ENGINE_OPTIONS } from '../types.ts';
import type { Database, EngineOptions, JoinAlgorithm, PlanNode, Row } from '../types.ts';

// shop: customers 1–12 (4, 9 and 12 never order), 40 orders (two a guest's, customerId NULL), products 1–8.
const shop = () => DATASETS.shop.make();
const run = (sql: string, options: EngineOptions = DEFAULT_ENGINE_OPTIONS, db: Database = shop()) => runQuery(sql, db, options);
const ALGORITHMS: readonly (JoinAlgorithm | undefined)[] = [undefined, 'nested-loop', 'hash', 'sort-merge', 'index-nested-loop'];
const withJoin = (joinStrategy: JoinAlgorithm | undefined): EngineOptions =>
  joinStrategy ? { ...DEFAULT_ENGINE_OPTIONS, joinStrategy } : DEFAULT_ENGINE_OPTIONS;
const pairs = (rows: readonly Row[], a: string, b: string) => rows.map((r) => `${String(r[a])}|${String(r[b])}`).sort();

/** The same join computed with two loops, no engine: matched pairs, then each side's unmatched rows as asked. */
function expectedPairs(keepCustomers: boolean, keepOrders: boolean): string[] {
  const { customers, orders } = shop().tables;
  const out: string[] = [];
  for (const c of customers!.rows) for (const o of orders!.rows) if (o.customerId !== null && o.customerId === c.id) out.push(`${String(c.name)}|${String(o.id)}`);
  if (keepCustomers) for (const c of customers!.rows) if (!orders!.rows.some((o) => o.customerId === c.id)) out.push(`${String(c.name)}|null`);
  if (keepOrders) for (const o of orders!.rows) if (!customers!.rows.some((c) => o.customerId !== null && c.id === o.customerId)) out.push(`null|${String(o.id)}`);
  return out.sort();
}

const JOIN = (kind: string) => `SELECT customers.name, orders.id FROM customers ${kind} JOIN orders ON customers.id = orders.customerId`;

describe('RIGHT and FULL JOIN (plan.md §27.5 S4)', () => {
  it.each(ALGORITHMS)('RIGHT keeps every order — the guests’ with no customer — under %s', (algorithm) => {
    const { rows, error } = run(JOIN('RIGHT'), withJoin(algorithm));
    expect(error).toBeUndefined();
    expect(pairs(rows, 'customers.name', 'orders.id')).toEqual(expectedPairs(false, true));
    expect(rows).toHaveLength(40);
  });

  it.each(ALGORITHMS)('FULL keeps both sides, each unmatched row once — under %s', (algorithm) => {
    const { rows, error } = run(JOIN('FULL OUTER'), withJoin(algorithm));
    expect(error).toBeUndefined();
    expect(pairs(rows, 'customers.name', 'orders.id')).toEqual(expectedPairs(true, true));
    expect(rows).toHaveLength(43);
  });

  it('pads every column of the left side, across a chain', () => {
    const rows = run('SELECT * FROM products JOIN orders ON products.id = orders.productId RIGHT JOIN customers ON orders.customerId = customers.id').rows;
    const lonely = rows.filter((r) => r['orders.id'] === null);
    expect(lonely.map((r) => r['customers.name']).sort()).toEqual(['dmitri', 'ines', 'lars']);
    for (const row of lonely) {
      for (const key of ['products.id', 'products.name', 'products.price', 'orders.customerId', 'orders.productId', 'orders.qty']) expect(row[key]).toBeNull();
    }
  });

  it.each(ALGORITHMS)('a RIGHT JOIN from an empty table keeps every right row — under %s', (algorithm) => {
    const db = shop();
    db.tables.customers = { ...db.tables.customers!, rows: [] };
    expect(run(JOIN('RIGHT'), withJoin(algorithm), db).rows).toHaveLength(40);
  });

  it('never filters the side a RIGHT or FULL join pads before the join: WHERE … IS NULL finds the unmatched rows', () => {
    // Pushed into the customers scan, `customers.name IS NULL` would leave no customer and pad all forty orders.
    expect(run(`${JOIN('RIGHT')} WHERE customers.name IS NULL`).rows.map((r) => r['orders.id']).sort((a, b) => Number(a) - Number(b))).toEqual([17, 33]);
    expect(run(`${JOIN('FULL')} WHERE orders.id IS NULL`).rows.map((r) => r['customers.name']).sort()).toEqual(['dmitri', 'ines', 'lars']);
    expect(run(`${JOIN('FULL')} WHERE customers.name IS NULL`).rows).toHaveLength(2);
  });

  it('still pushes a WHERE on the side a RIGHT JOIN keeps whole into its scan', () => {
    const { events, rows } = run(`${JOIN('RIGHT')} WHERE orders.qty > 3`);
    expect(rows).toHaveLength(10);
    const join = finalPlan(events)?.children?.[0];
    expect(join?.children?.[1]).toMatchObject({ op: 'SeqScan', detail: 'filter: qty > 3' });
  });

  it('gives way to a nested-loop when an index nested-loop is asked for, and says why', () => {
    const { events } = run(JOIN('RIGHT'), withJoin('index-nested-loop'));
    expect(events.some((e) => e.stage === 'plan' && /keeps the rows of `orders` nothing matched, which a probe never visits/.test(e.label))).toBe(true);
    expect(finalPlan(events)?.children?.[0]?.label).toBe('Right join (nested-loop) customers × orders');
  });

  it('reads as ⟖ and ⟗ in relational algebra, LEFT as ⟕, and labels each join by its kind', () => {
    const plan = (sql: string) => finalPlan(run(sql).events) as PlanNode;
    expect(planToRelationalAlgebra(plan(JOIN('RIGHT')))).toMatch(/customers ⟖_\{customers\.id = orders\.customerId\} orders/);
    expect(planToRelationalAlgebra(plan(JOIN('FULL')))).toMatch(/ ⟗_/);
    expect(planToRelationalAlgebra(plan(JOIN('LEFT')))).toMatch(/ ⟕_/);
    expect(planToLatex(plan(JOIN('FULL')))).toMatch(/\\mathbin\{⟗\}/);
    expect(plan(JOIN('FULL')).children?.[0]?.label).toMatch(/^Full join \(/);
  });

  it('floors the estimate at the side it keeps whole, and says so only when the floor raised it', () => {
    const right = finalPlan(run(JOIN('RIGHT')).events)?.children?.[0];
    expect(right?.estRows).toBeGreaterThanOrEqual(40);
    const full = finalPlan(run(JOIN('FULL')).events)?.children?.[0];
    expect(full?.estRows).toBeGreaterThanOrEqual(40);
    // The equi-join estimate (48) is already past forty orders: the plain formula, no floor.
    expect(full?.estBasis).not.toMatch(/survives a FULL JOIN/);
    // Eight products against twelve distinct customer ids: the equi-join guesses 8 × 12 / 12 = 8, fewer than the twelve
    // customers a RIGHT JOIN keeps.
    const join = finalPlan(run('SELECT * FROM products RIGHT JOIN customers ON products.id = customers.id').events)?.children?.[0];
    expect(join?.estRows).toBe(12);
    expect(join?.estBasis).toMatch(/^12 \(every customers row survives a RIGHT JOIN; the equi-join estimate alone was only 8\)/);
  });
});

describe('CROSS JOIN and FROM a, b (plan.md §27.5 S4)', () => {
  it.each(ALGORITHMS)('pairs every row with every row, whatever algorithm is asked for — %s', (algorithm) => {
    const { rows, events } = run('SELECT customers.name, products.name FROM customers CROSS JOIN products', withJoin(algorithm));
    expect(rows).toHaveLength(12 * 8);
    expect(finalPlan(events)?.children?.[0]?.label).toBe('Cross join (nested-loop) customers × products');
  });

  it('writes the same join with a comma, reads as × in relational algebra, and estimates every pair', () => {
    const { rows, events } = run('SELECT customers.name, products.name FROM customers, products');
    expect(rows).toHaveLength(96);
    const plan = finalPlan(events)!;
    expect(planToRelationalAlgebra(plan)).toMatch(/customers × products/);
    expect(planToLatex(plan)).toMatch(/\\times/);
    expect(plan.children?.[0]?.estRows).toBe(96);
  });

  it('turns a product with a WHERE equality into a join — σ over × becomes ⋈ — and finds the same rows', () => {
    const sql = 'SELECT customers.name, orders.id FROM customers, orders WHERE customers.id = orders.customerId AND orders.qty > 3';
    const { rows, events } = run(sql);
    const rewrite = events.find((e) => e.stage === 'optimize' && e.rule === 'product-to-join');
    expect(rewrite?.label).toMatch(/σ over × becomes ⋈: `customers\.id = orders\.customerId`/);
    expect(JSON.stringify(finalPlan(events))).not.toMatch(/Cross join/);
    const plain = run(`${JOIN('')} WHERE orders.qty > 3`).rows;
    expect(pairs(rows, 'customers.name', 'orders.id')).toEqual(pairs(plain, 'customers.name', 'orders.id'));
  });

  it('rewrites every cross join of a chain that a WHERE equality connects', () => {
    const { rows, events } = run(
      'SELECT customers.name, products.name FROM customers, orders, products WHERE customers.id = orders.customerId AND orders.productId = products.id',
    );
    expect(rows).toHaveLength(38);
    expect(events.find((e) => e.stage === 'optimize' && e.rule === 'product-to-join')?.label).toMatch(/and `orders\.productId = products\.id`/);
  });

  it('leaves a cross join a RIGHT or FULL join pads alone — the WHERE stays above, and removes the padded rows', () => {
    // Found by the SQLite oracle: moved below the RIGHT JOIN, the equality kept the padded rows it should remove.
    const sql = 'SELECT customers.id, orders.id, products.id FROM customers, orders RIGHT JOIN products ON orders.productId = products.id WHERE customers.id = orders.customerId';
    const { rows, events } = run(sql);
    expect(events.some((e) => e.stage === 'optimize' && e.rule === 'product-to-join')).toBe(false);
    expect(rows.every((r) => r['customers.id'] !== null)).toBe(true);
    expect(rows).toHaveLength(38);
  });

  it('refuses an ON on a CROSS JOIN, saying what to write instead', () => {
    const { error } = run('SELECT * FROM customers CROSS JOIN products ON customers.id = products.id');
    expect(error?.message).toBe('CROSS JOIN takes no ON.');
    expect(error?.hint).toMatch(/put it in WHERE/);
  });
});
