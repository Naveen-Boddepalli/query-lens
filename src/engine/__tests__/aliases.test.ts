/**
 * plan.md §27.5 S7 — table aliases and self-joins. `FROM customers AS c` (or `customers c`) names a table for this
 * query; so a table can be joined to itself, or read again in its own EXISTS. Every scope sees the alias; only laying
 * out pages asks what it stands for, so both names read the one heap.
 */

import { describe, expect, it } from 'vitest';
import { parseStatement } from '../parser/parser.ts';
import { exprToSql } from '../planner/index.ts';
import { runQuery } from '../runQuery.ts';
import { DATASETS } from '../datasets.ts';
import { finalPlan } from '../explain.ts';
import { planToLatex, planToRelationalAlgebra } from '../../export/toRelationalAlgebra.ts';
import { DEFAULT_ENGINE_OPTIONS } from '../types.ts';
import type { EngineOptions, JoinAlgorithm, PlanNode, Row } from '../types.ts';

const customers = () => DATASETS.customers.make();
const run = (sql: string, options: EngineOptions = DEFAULT_ENGINE_OPTIONS) => runQuery(sql, customers(), options);
const rowsOf = () => customers().tables.customers!.rows;
const ALGORITHMS: readonly (JoinAlgorithm | undefined)[] = [undefined, 'nested-loop', 'hash', 'sort-merge', 'index-nested-loop'];
const withJoin = (joinStrategy: JoinAlgorithm | undefined): EngineOptions =>
  joinStrategy ? { ...DEFAULT_ENGINE_OPTIONS, joinStrategy } : DEFAULT_ENGINE_OPTIONS;
const pairs = (rows: readonly Row[], a: string, b: string) => rows.map((r) => `${String(r[a])}|${String(r[b])}`).sort();

/** Who referred whom, by hand: each customer beside their referrer's name, NULL for none (kept only when `left`). */
function referrals(left: boolean): string[] {
  const out: string[] = [];
  for (const c of rowsOf()) {
    const r = rowsOf().find((x) => c.referrer !== null && x.id === c.referrer);
    if (r || left) out.push(`${String(c.name)}|${String(r?.name ?? null)}`);
  }
  return out.sort();
}
const referredNobody = () => rowsOf().filter((c) => !rowsOf().some((x) => x.referrer === c.id)).map((c) => c.name).sort();

const SELF = 'SELECT c.name, r.name FROM customers AS c JOIN customers AS r ON c.referrer = r.id';

describe('parsing (plan.md §27.5 S7)', () => {
  it('reads AS and a bare alias after a table in FROM, every JOIN form and a subquery’s FROM', () => {
    for (const sql of [
      SELF,
      'SELECT c.name, r.name FROM customers c LEFT JOIN customers r ON c.referrer = r.id',
      'SELECT a.id, b.id FROM customers a CROSS JOIN customers b',
      'SELECT a.id, b.id FROM customers a, customers b WHERE a.referrer = b.id',
      'SELECT name FROM customers c WHERE NOT EXISTS (SELECT * FROM customers r WHERE r.referrer = c.id)',
      'SELECT name FROM customers WHERE id IN (SELECT referrer FROM customers r)',
      'SELECT name FROM customers WHERE id = (SELECT MAX(c2.id) FROM customers AS c2)',
    ]) {
      expect(parseStatement(sql).ok, sql).toBe(true);
    }
    const out = parseStatement(SELF);
    if (!out.ok || out.ast.kind !== 'select') throw new Error('did not parse');
    expect(out.ast.from).toMatchObject({ name: 'c', source: 'customers' });
    expect(out.ast.joins?.[0]?.table).toMatchObject({ name: 'r', source: 'customers' });
  });

  it('refuses one name twice, and points at an alias', () => {
    const twice = parseStatement('SELECT * FROM customers JOIN customers ON customers.id = customers.referrer');
    expect(!twice.ok && twice.error.message).toBe('`customers` is already in this query.');
    expect(!twice.ok && twice.error.hint).toMatch(/JOIN customers AS c2 ON …/);
    const alias = parseStatement('SELECT * FROM customers c JOIN customers c ON c.id = c.referrer');
    expect(!alias.ok && alias.error.message).toBe('`c` is already in this query.');
    const exists = parseStatement('SELECT name FROM customers WHERE NOT EXISTS (SELECT * FROM customers WHERE customers.referrer = customers.id)');
    expect(!exists.ok && exists.error.hint).toMatch(/FROM customers AS c2/);
  });

  it('once aliased, the stored name is not a name in the query — and the error says what is', () => {
    const out = parseStatement('SELECT customers.name FROM customers c JOIN customers r ON c.referrer = r.id');
    expect(!out.ok && out.error.message).toBe('There is no table called `customers` in this query.');
    expect(!out.ok && out.error.hint).toBe('In this query `customers` is called `c` — write `c.name`.');
  });

  it('a write takes no alias, and AS needs a name', () => {
    expect(parseStatement('DELETE FROM customers c WHERE id = 1').ok).toBe(false);
    const bare = parseStatement('SELECT * FROM customers AS');
    expect(!bare.ok && bare.error.message).toMatch(/a name for `customers` after AS/);
  });

  it('a one-table query may name its own table — by alias or name — and the qualifier is dropped everywhere', () => {
    const ok = parseStatement('SELECT c.city, COUNT(c.id) FROM customers c WHERE c.id > 2 GROUP BY c.city HAVING COUNT(c.id) > 1 ORDER BY COUNT(c.id) DESC');
    expect(ok.ok).toBe(true);
    if (ok.ok && ok.ast.kind === 'select') expect(JSON.stringify(ok.ast)).not.toMatch(/"table":"c"/);
    expect(run('SELECT c.name FROM customers c WHERE c.id < 3 ORDER BY c.name').rows).toEqual([{ name: 'ana' }, { name: 'ben' }]);
    expect(run('SELECT customers.name FROM customers WHERE customers.id = 1').rows).toEqual([{ name: 'ana' }]);
  });

  it('keeps a correlation qualified: inside EXISTS, `c.id` is the outer query’s, and prints back with the alias', () => {
    const out = parseStatement('SELECT c.name FROM customers c WHERE NOT EXISTS (SELECT * FROM customers r WHERE r.referrer = c.id)');
    if (!out.ok || out.ast.kind !== 'select' || !out.ast.where) throw new Error('did not parse');
    expect(exprToSql(out.ast.where)).toBe('NOT EXISTS (SELECT * FROM customers AS r WHERE r.referrer = c.id)');
    expect(parseStatement(`SELECT name FROM customers c WHERE ${exprToSql(out.ast.where)}`).ok).toBe(true);
  });
});

describe('self-joins (plan.md §27.5 S7)', () => {
  it.each(ALGORITHMS)('each customer beside the one who referred them, under %s', (algorithm) => {
    const { rows, error } = run(SELF, withJoin(algorithm));
    expect(error).toBeUndefined();
    expect(pairs(rows, 'c.name', 'r.name')).toEqual(referrals(false));
  });

  it.each(ALGORITHMS)('LEFT keeps the customers nobody referred, under %s', (algorithm) => {
    const { rows } = run('SELECT c.name, r.name FROM customers c LEFT JOIN customers r ON c.referrer = r.id', withJoin(algorithm));
    expect(pairs(rows, 'c.name', 'r.name')).toEqual(referrals(true));
  });

  it('three names for one table: who referred the one who referred you', () => {
    const { rows } = run(
      'SELECT c.name, g.name FROM customers c JOIN customers r ON c.referrer = r.id JOIN customers g ON r.referrer = g.id',
    );
    const expected: string[] = [];
    for (const c of rowsOf()) {
      const r = rowsOf().find((x) => c.referrer !== null && x.id === c.referrer);
      const g = r && rowsOf().find((x) => r.referrer !== null && x.id === r.referrer);
      if (g) expected.push(`${String(c.name)}|${String(g.name)}`);
    }
    expect(pairs(rows, 'c.name', 'g.name')).toEqual(expected.sort());
  });

  it('groups over a self-join: how many each customer referred', () => {
    const { rows } = run('SELECT r.name, COUNT(c.id) FROM customers r LEFT JOIN customers c ON c.referrer = r.id GROUP BY r.name');
    for (const row of rows) {
      const r = rowsOf().find((x) => x.name === row['r.name'])!;
      expect(row['COUNT(c.id)'], String(row['r.name'])).toBe(rowsOf().filter((x) => x.referrer === r.id).length);
    }
  });

  it('both names read one heap: a nested-loop’s rescans touch only the table’s own pages, and hit the pool', () => {
    const { events } = run(SELF, withJoin('nested-loop'));
    const pages = new Set(events.flatMap((e) => (e.stage === 'buffer' && (e.action === 'hit' || e.action === 'miss') ? [e.pageId] : [])));
    const heapPages = Math.ceil(rowsOf().length / DEFAULT_ENGINE_OPTIONS.rowsPerPage);
    expect(pages.size).toBe(heapPages);
    expect(events.some((e) => e.stage === 'buffer' && e.action === 'hit')).toBe(true);
  });

  it('an index nested-loop probes the stored table’s own index, built once', () => {
    const { events, rows } = run(SELF, withJoin('index-nested-loop'));
    expect(pairs(rows, 'c.name', 'r.name')).toEqual(referrals(false));
    expect(finalPlan(events)?.children?.[0]?.label).toMatch(/^Join \(index-nested-loop\)/);
  });
});

describe('a subquery on its own table (plan.md §27.5 S7)', () => {
  it('NOT EXISTS: the customers who referred nobody — as an anti-join', () => {
    const { rows, events } = run('SELECT c.name FROM customers c WHERE NOT EXISTS (SELECT * FROM customers r WHERE r.referrer = c.id)');
    expect(rows.map((r) => r.name).sort()).toEqual(referredNobody());
    expect(events.some((e) => e.stage === 'plan' && /`NOT EXISTS \(SELECT \* FROM customers AS r WHERE r\.referrer = c\.id\)` becomes an anti-join/.test(e.label))).toBe(true);
  });

  it('EXISTS: the customers who referred someone, each once', () => {
    const { rows } = run('SELECT name FROM customers c WHERE EXISTS (SELECT * FROM customers r WHERE r.referrer = c.id)');
    const referred = rowsOf().filter((c) => rowsOf().some((x) => x.referrer === c.id)).map((c) => c.name).sort();
    expect(rows.map((r) => r.name).sort()).toEqual(referred);
  });

  it('an uncorrelated EXISTS under an alias runs once against the stored table', () => {
    const { rows, error } = run('SELECT name FROM customers c WHERE EXISTS (SELECT * FROM customers r WHERE r.city = \'Paris\') AND c.id = 1');
    expect(error).toBeUndefined();
    expect(rows).toEqual([{ name: 'ana' }]);
  });
});

describe('a plan that pins more pages than the pool has frames (found by the oracle, plan.md §27.5 S7)', () => {
  // Four scans in one nested loop — three names for customers and a NOT EXISTS on a fourth — each holding a page.
  const DEEP =
    'SELECT c.name FROM customers c JOIN customers r ON c.referrer = r.id JOIN customers g ON r.referrer = g.id WHERE NOT EXISTS (SELECT * FROM customers x WHERE x.id = c.id)';

  it('is an error that says why, not rows a scan that quietly stopped left behind', () => {
    const { rows, error, events } = run(DEEP, { ...DEFAULT_ENGINE_OPTIONS, joinStrategy: 'nested-loop', bufferFrames: 3, rowsPerPage: 1 });
    expect(rows).toEqual([]);
    expect(error?.message).toMatch(/^Every one of the buffer pool's 3 frames is pinned, so page \d+ has nowhere to be read into\.$/);
    expect(error?.hint).toMatch(/no unpinned buffers available/);
    expect(events.at(-1)?.label).toMatch(/^The query stops: Every one of the buffer pool's 3 frames is pinned/);
  });

  it('runs with one more frame, or a join that reads one side whole first — and every customer has themself', () => {
    expect(run(DEEP, { ...DEFAULT_ENGINE_OPTIONS, joinStrategy: 'nested-loop', bufferFrames: 4, rowsPerPage: 1 })).toMatchObject({ rows: [] });
    expect(run(DEEP, { ...DEFAULT_ENGINE_OPTIONS, joinStrategy: 'nested-loop', bufferFrames: 4, rowsPerPage: 1 }).error).toBeUndefined();
    expect(run(DEEP, { ...DEFAULT_ENGINE_OPTIONS, joinStrategy: 'hash', bufferFrames: 3, rowsPerPage: 1 }).error).toBeUndefined();
  });

  it('a three-table nested loop in a two-frame pool says so, where it once returned nothing', () => {
    const sql = 'SELECT customers.name FROM orders JOIN customers ON orders.customerId = customers.id JOIN products ON orders.productId = products.id';
    const tiny = runQuery(sql, DATASETS.shop.make(), { ...DEFAULT_ENGINE_OPTIONS, joinStrategy: 'nested-loop', bufferFrames: 2 });
    expect(tiny.error?.message).toMatch(/frames is pinned/);
    expect(runQuery(sql, DATASETS.shop.make(), { ...DEFAULT_ENGINE_OPTIONS, joinStrategy: 'nested-loop', bufferFrames: 3 }).rows).toHaveLength(38);
  });
});

describe('narration and errors (plan.md §27.5 S7)', () => {
  it('names each table by what it is and what this query calls it', () => {
    const { events } = run(SELF);
    expect(events.some((e) => e.stage === 'plan' && /a sequential scan of `customers AS c`/.test(e.label))).toBe(true);
    expect(events.some((e) => e.stage === 'plan' && /a second scan of `customers AS r`|an index probe on `customers AS r`/.test(e.label))).toBe(true);
  });

  it('reads as a rename in relational algebra — ρ_c(customers) — and the plan says customers AS c', () => {
    const plan = finalPlan(run(SELF, withJoin('nested-loop')).events) as PlanNode;
    expect(planToRelationalAlgebra(plan)).toMatch(/ρ_\{c\}\(customers\) ⋈_\{c\.referrer = r\.id\} ρ_\{r\}\(customers\)/);
    expect(planToLatex(plan)).toMatch(/\\rho_\{\\text\{c\}\}\\left\(\\text\{customers\}\\right\)/);
    expect(JSON.stringify(plan)).toMatch(/"label":"SeqScan customers AS r"/);
    // A table read under its own name is just its name.
    const plain = finalPlan(runQuery('SELECT name FROM customers', customers()).events) as PlanNode;
    expect(planToRelationalAlgebra(plain)).not.toMatch(/ρ/);
  });

  it('reports a missing table and a missing column by the stored name', () => {
    expect(run('SELECT x.id FROM nope x JOIN customers c ON x.id = c.id').error?.message).toBe('There is no table called `nope`.');
    expect(run('SELECT c.nope, r.name FROM customers c JOIN customers r ON c.referrer = r.id').error?.message).toBe('`customers` has no column called `nope`.');
  });

  it('works in a compound query, each SELECT with its own names', () => {
    const { rows, error } = run(
      'SELECT c.name FROM customers c JOIN customers r ON c.referrer = r.id UNION SELECT name FROM customers c WHERE NOT EXISTS (SELECT * FROM customers r WHERE r.referrer = c.id)',
    );
    expect(error).toBeUndefined();
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe('plan.md §27.8, 3.0’s definition of done', () => {
  it('NOT EXISTS, UNION, a FULL JOIN, COUNT(DISTINCT …) and a self-join through an alias run and narrate together on a preset', () => {
    const sql =
      'SELECT c.name, COUNT(DISTINCT r.id) FROM customers c FULL JOIN customers r ON r.referrer = c.id ' +
      'WHERE NOT EXISTS (SELECT * FROM customers x WHERE x.id = c.referrer) GROUP BY c.name ' +
      'UNION SELECT name, id FROM customers WHERE id < 0';
    const { rows, error, events } = run(sql);
    expect(error).toBeUndefined();
    // The customers nobody referred (their referrer finds no row), each with how many they referred — and the FULL
    // JOIN's one padded group, the referred customers' NULL side, which NOT EXISTS keeps too.
    const counts = new Map<unknown, number>();
    for (const c of rowsOf().filter((x) => !rowsOf().some((y) => y.id === x.referrer))) {
      counts.set(c.name, new Set(rowsOf().filter((y) => y.referrer === c.id).map((y) => y.id)).size);
    }
    const named = rows.filter((r) => r['c.name'] !== null);
    expect(new Map(named.map((r) => [r['c.name'], r['COUNT(DISTINCT r.id)']]))).toEqual(counts);
    const labels = events.filter((e) => e.stage === 'plan').map((e) => e.label).join('\n');
    for (const piece of [/anti-join/, /FULL JOIN/, /COUNT\(DISTINCT r\.id\)/, /UNION/, /customers AS r/]) expect(labels).toMatch(piece);
  });
});
