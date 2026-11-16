/**
 * plan.md §27.5 S6 — scalar subqueries. `(SELECT one_column FROM …)` where a value goes, uncorrelated, run once before
 * planning: its answer is a constant to the planner — NULL for no row, an error for more than one.
 */

import { describe, expect, it } from 'vitest';
import { parseStatement } from '../parser/parser.ts';
import { toDisplayTree } from '../parser/index.ts';
import { exprToSql } from '../planner/index.ts';
import type { Expr } from '../parser/index.ts';
import { runQuery } from '../runQuery.ts';
import { DATASETS } from '../datasets.ts';
import { DEFAULT_ENGINE_OPTIONS } from '../types.ts';
import type { ASTNode, Database, Row } from '../types.ts';

const shop = () => DATASETS.shop.make();
const run = (sql: string, db: Database = shop()) => runQuery(sql, db, DEFAULT_ENGINE_OPTIONS);
const products = () => shop().tables.products!.rows;
const prices = () => products().map((p) => Number(p.price));
const average = () => prices().reduce((a, b) => a + b, 0) / prices().length;
const names = (rows: readonly Row[], key = 'name') => rows.map((r) => r[key]).sort();
const where = (sql: string): Expr => {
  const out = parseStatement(sql);
  if (!out.ok || out.ast.kind !== 'select' || !out.ast.where) throw new Error(`no WHERE in ${sql}`);
  return out.ast.where;
};
const ids = (node: ASTNode): string[] => [node.id, ...(node.children ?? []).flatMap(ids)];

describe('parsing (plan.md §27.5 S6)', () => {
  it('reads a parenthesised SELECT as a value, with its own text, and prints it back as written', () => {
    const w = where('SELECT name FROM products WHERE price >\n  (SELECT  AVG(price)\n   FROM products)');
    expect(w.kind === 'compare' && w.right.kind).toBe('scalar');
    if (w.kind === 'compare' && w.right.kind === 'scalar') {
      expect(w.right.sql).toBe('SELECT AVG(price) FROM products');
      expect(w.right.select.from.name).toBe('products');
    }
    expect(exprToSql(w)).toBe('price > (SELECT AVG(price) FROM products)');
  });

  it('is allowed in the SELECT list, HAVING, UPDATE SET and DELETE WHERE, and with ORDER BY and LIMIT inside', () => {
    for (const sql of [
      'SELECT name, price - (SELECT AVG(price) FROM products) FROM products',
      'SELECT customerId FROM orders GROUP BY customerId HAVING COUNT(*) > (SELECT COUNT(*) FROM orders) / 10',
      'UPDATE products SET price = (SELECT MAX(price) FROM products) WHERE id = 1',
      'DELETE FROM orders WHERE qty < (SELECT AVG(qty) FROM orders)',
      'SELECT name FROM products WHERE price = (SELECT price FROM products ORDER BY price DESC LIMIT 1)',
    ]) {
      expect(parseStatement(sql).ok, sql).toBe(true);
    }
  });

  it('puts the outer clause’s flags back afterwards: an EXISTS after it, an aggregate after it in HAVING', () => {
    expect(
      parseStatement('SELECT * FROM orders WHERE qty > (SELECT AVG(qty) FROM orders) AND EXISTS (SELECT * FROM products WHERE products.id = orders.productId)').ok,
    ).toBe(true);
    expect(parseStatement('SELECT customerId FROM orders GROUP BY customerId HAVING (SELECT COUNT(*) FROM customers) < COUNT(*) * 2').ok).toBe(true);
    // …and does not lend them to the subquery: an aggregate in its WHERE is still an error, inside a HAVING or not.
    const inner = parseStatement('SELECT customerId FROM orders GROUP BY customerId HAVING COUNT(*) > (SELECT COUNT(*) FROM orders WHERE COUNT(*) > 1)');
    expect(!inner.ok && inner.error.message).toMatch(/`COUNT\(…\)` cannot be used here/);
  });

  it('draws the subquery’s whole tree under one node, every id unique', () => {
    const out = parseStatement('SELECT name FROM products WHERE price > (SELECT AVG(price) FROM products WHERE id < 5)');
    if (!out.ok || out.ast.kind !== 'select') throw new Error('did not parse');
    const tree = toDisplayTree(out.ast);
    const all = ids(tree);
    expect(new Set(all).size).toBe(all.length);
    expect(JSON.stringify(tree)).toMatch(/"kind":"Subquery"/);
    expect(JSON.stringify(tree)).toMatch(/"kind":"SelectStatement"[^]*"kind":"SelectStatement"/);
  });

  it('refuses what is not one value, naming why', () => {
    const refusals: [string, RegExp][] = [
      ['SELECT name FROM products WHERE price = SELECT MAX(price) FROM products', /A subquery needs parentheses/],
      ['SELECT name FROM products WHERE price > (SELECT * FROM products)', /must select exactly one column/],
      ['SELECT name FROM products WHERE price > (SELECT id, price FROM products)', /must select exactly one column/],
      ['SELECT name FROM products WHERE price > (SELECT price FROM products UNION SELECT qty FROM orders)', /`UNION` is not supported inside a subquery used as a value/],
      ['SELECT * FROM customers WHERE EXISTS (SELECT * FROM orders WHERE orders.qty = (SELECT MAX(qty) FROM orders))', /subquery inside an EXISTS subquery/],
    ];
    for (const [sql, message] of refusals) {
      const out = parseStatement(sql);
      expect(!out.ok && out.error.message, sql).toMatch(message);
    }
  });

  it('a qualified reference to the outer query is told it is correlated, and what to use instead', () => {
    const out = parseStatement('SELECT name FROM customers WHERE id = (SELECT customerId FROM orders WHERE customerId = customers.id)');
    expect(!out.ok && out.error.message).toBe('There is no table called `customers` in this query.');
    expect(!out.ok && out.error.hint).toMatch(/no correlated scalar subqueries; for a per-row test against another table, use EXISTS/);
  });
});

describe('results (plan.md §27.5 S6)', () => {
  it('compares with the subquery’s one value: the products above the average price', () => {
    const { rows, error } = run('SELECT name FROM products WHERE price > (SELECT AVG(price) FROM products)');
    expect(error).toBeUndefined();
    expect(names(rows)).toEqual(names(products().filter((p) => Number(p.price) > average())));
  });

  it('a computed column is named as written, with or without AS, and holds the difference', () => {
    const plain = run('SELECT name, price - (SELECT AVG(price) FROM products) FROM products').rows;
    expect(Object.keys(plain[0]!)).toEqual(['name', 'price - (SELECT AVG(price) FROM products)']);
    const aliased = run('SELECT name, price - (SELECT AVG(price) FROM products) AS diff FROM products').rows;
    for (const row of aliased) {
      const price = Number(products().find((p) => p.name === row.name)!.price);
      expect(row.diff).toBeCloseTo(price - average());
    }
  });

  it('works in HAVING, and with ORDER BY … LIMIT 1 inside the subquery', () => {
    const having = run('SELECT customerId FROM orders GROUP BY customerId HAVING COUNT(*) > (SELECT COUNT(*) FROM orders) / 10').rows;
    const counts = new Map<unknown, number>();
    for (const o of shop().tables.orders!.rows) counts.set(o.customerId, (counts.get(o.customerId) ?? 0) + 1);
    expect(having.map((r) => r.customerId).sort()).toEqual([...counts].filter(([, n]) => n > 4).map(([id]) => id).sort());
    const top = run('SELECT name FROM products WHERE price = (SELECT price FROM products ORDER BY price DESC LIMIT 1)').rows;
    expect(names(top)).toEqual(names(products().filter((p) => Number(p.price) === Math.max(...prices()))));
  });

  it('no row is NULL — so the comparison is UNKNOWN and keeps nothing, even under NOT', () => {
    expect(run('SELECT name FROM products WHERE price = (SELECT price FROM products WHERE id = 99)').rows).toHaveLength(0);
    expect(run('SELECT name FROM products WHERE NOT (price = (SELECT price FROM products WHERE id = 99))').rows).toHaveLength(0);
    const [row] = run('SELECT (SELECT price FROM products WHERE id = 99) IS NULL AS empty FROM products LIMIT 1').rows;
    expect(row?.empty).toBe(true);
  });

  it('more than one row is an error that says how many, underlines the subquery, and says how to fix it', () => {
    const sql = 'SELECT name FROM products WHERE price = (SELECT price FROM products)';
    const { error } = run(sql);
    expect(error?.message).toBe('The subquery `(SELECT price FROM products)` returned 8 rows, but a subquery used as a value must return at most one.');
    expect(error?.hint).toMatch(/ORDER BY … LIMIT 1/);
    expect(sql.slice(error!.from, error!.to)).toBe('(SELECT price FROM products)');
  });

  it('an unqualified column the subquery’s table lacks gets the correlation hint', () => {
    const { error } = run("SELECT name FROM customers WHERE id = (SELECT COUNT(*) FROM orders WHERE customerId = city)");
    expect(error?.message).toBe('The subquery used as a value failed: `orders` has no column called `city`.');
    expect(error?.hint).toMatch(/cannot read the outer query’s columns/);
  });

  it('nests: inside another scalar subquery, and inside an IN subquery', () => {
    const second = run('SELECT name FROM products WHERE price = (SELECT MAX(price) FROM products WHERE price < (SELECT MAX(price) FROM products))').rows;
    const sorted = [...new Set(prices())].sort((a, b) => b - a);
    expect(names(second)).toEqual(names(products().filter((p) => Number(p.price) === sorted[1])));
    const biggest = run('SELECT name FROM customers WHERE id IN (SELECT customerId FROM orders WHERE qty = (SELECT MAX(qty) FROM orders))').rows;
    const maxQty = Math.max(...shop().tables.orders!.rows.map((o) => Number(o.qty)));
    const buyers = new Set(shop().tables.orders!.rows.filter((o) => o.qty === maxQty).map((o) => o.customerId));
    expect(names(biggest)).toEqual(names(shop().tables.customers!.rows.filter((c) => buyers.has(c.id))));
  });

  it('writes with it: UPDATE … SET and DELETE … WHERE read the table before they change it', () => {
    const update = run('UPDATE products SET price = (SELECT MAX(price) FROM products) WHERE id = 1');
    expect(update.error).toBeUndefined();
    expect(update.write?.kind === 'update' && update.write.rows.find((p) => p.id === 1)?.price).toBe(Math.max(...prices()));
    const del = run('DELETE FROM orders WHERE qty > (SELECT AVG(qty) FROM orders)');
    const qty = shop().tables.orders!.rows.map((o) => Number(o.qty));
    const avg = qty.reduce((a, b) => a + b, 0) / qty.length;
    expect(del.write?.kind === 'delete' && del.write.deletedCount).toBe(qty.filter((q) => q > avg).length);
  });

  it('runs inside a compound member and under EXPLAIN', () => {
    const compound = run('SELECT name FROM products WHERE price > (SELECT AVG(price) FROM products) UNION ALL SELECT name FROM customers WHERE id = (SELECT MIN(id) FROM customers)');
    expect(compound.error).toBeUndefined();
    expect(compound.rows).toHaveLength(products().filter((p) => Number(p.price) > average()).length + 1);
    expect(run('EXPLAIN SELECT name FROM products WHERE price > (SELECT AVG(price) FROM products)').error).toBeUndefined();
  });
});

describe('planning: the answer is a constant (plan.md §27.5 S6)', () => {
  it('ran once before planning, says what it returned, and an index serves the comparison', () => {
    const { events, rows } = run("SELECT id FROM orders WHERE customerId = (SELECT id FROM customers WHERE name = 'alice')");
    expect(rows).toHaveLength(7);
    const note = events.find((e) => e.stage === 'plan' && e.label.includes('names nothing from the outer query'));
    expect(note?.label).toMatch(/The subquery `\(SELECT id FROM customers WHERE name = 'alice'\)` names nothing from the outer query, so it already ran once, before this plan was built, and returned 1/);
    expect(events.some((e) => e.stage === 'optimize' && e.rule === 'index-selection')).toBe(true);
  });

  it('narrates it in HAVING and the SELECT list too', () => {
    const having = run('SELECT customerId FROM orders GROUP BY customerId HAVING COUNT(*) > (SELECT COUNT(*) FROM orders) / 10').events;
    expect(having.some((e) => e.stage === 'plan' && /^HAVING becomes/.test(e.label) && /returned 40/.test(e.label))).toBe(true);
    const list = run('SELECT name, price - (SELECT MIN(price) FROM products) AS above FROM products').events;
    expect(list.some((e) => e.stage === 'plan' && /Project/.test(e.label) && /returned \d+/.test(e.label))).toBe(true);
  });
});
