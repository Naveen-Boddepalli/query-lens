/**
 * plan.md §27.5 S5 — `COUNT(DISTINCT x)`, and `SUM`/`AVG`/`MIN`/`MAX` with `DISTINCT`. Each distinct non-NULL value
 * of the column once: a set per group under the hash strategy, a sort on (group, value) under the sort strategy.
 */

import { describe, expect, it } from 'vitest';
import { parse } from '../parser/parser.ts';
import { aggregateKeyOf, toDisplayTree } from '../parser/index.ts';
import { runQuery } from '../runQuery.ts';
import { DATASETS } from '../datasets.ts';
import { finalPlan } from '../explain.ts';
import { planToLatex, planToRelationalAlgebra } from '../../export/toRelationalAlgebra.ts';
import { DEFAULT_ENGINE_OPTIONS } from '../types.ts';
import type { Database, EngineOptions, PlanNode, Row, SqlValue } from '../types.ts';

const HASH: EngineOptions = { ...DEFAULT_ENGINE_OPTIONS, aggregateStrategy: 'hash' };
const SORT: EngineOptions = { ...DEFAULT_ENGINE_OPTIONS, aggregateStrategy: 'sort' };
const STRATEGIES = [['hash', HASH], ['sort', SORT]] as const;

const shop = () => DATASETS.shop.make();
const run = (sql: string, options: EngineOptions = HASH, db: Database = shop()) => runQuery(sql, db, options);
const orders = () => shop().tables.orders!.rows;

/** The same aggregate with no engine: the non-NULL values of `column`, each once. */
const distinctOf = (rows: readonly Row[], column: string): SqlValue[] => [
  ...new Set(rows.map((r) => r[column] ?? null).filter((v) => v !== null)),
];
const sum = (values: readonly SqlValue[]) => values.reduce<number>((a, v) => a + Number(v), 0);

/** Ones and twos with a NULL — the case where every DISTINCT aggregate differs from its plain one. */
const tiny = (): Database => ({
  tables: {
    t: {
      name: 't',
      columns: ['id', 'g', 'v'],
      rows: [
        { id: 1, g: 'a', v: 1 },
        { id: 2, g: 'a', v: 1 },
        { id: 3, g: 'a', v: 2 },
        { id: 4, g: 'a', v: null },
        { id: 5, g: 'b', v: 3 },
        { id: 6, g: 'b', v: 3 },
        { id: 7, g: 'c', v: null },
      ],
      indexedColumns: ['id'],
    },
  },
});

describe('parsing (plan.md §27.5 S5)', () => {
  it('reads DISTINCT inside every aggregate, qualified or not, and names it as SQLite does', () => {
    for (const fn of ['COUNT', 'SUM', 'AVG', 'MIN', 'MAX']) {
      const out = parse(`SELECT ${fn}(DISTINCT v) FROM t`);
      expect(out.ok, fn).toBe(true);
      if (out.ok && out.ast.select.kind === 'columns') {
        const item = out.ast.select.items[0]!;
        expect(item.kind === 'aggregate' && item.arg.kind === 'column' && item.arg.distinct).toBe(true);
        expect(item.kind === 'aggregate' && aggregateKeyOf(item.fn, item.arg)).toBe(`${fn}(DISTINCT v)`);
      }
    }
    expect(parse('SELECT COUNT(DISTINCT orders.customerId) FROM orders JOIN customers ON orders.customerId = customers.id').ok).toBe(true);
  });

  it('reads it in HAVING and ORDER BY too, and the parse tree labels it', () => {
    const out = parse('SELECT g FROM t GROUP BY g HAVING COUNT(DISTINCT v) > 1 ORDER BY SUM(DISTINCT v) DESC');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.ast.orderBy?.column).toBe('SUM(DISTINCT v)');
    expect(JSON.stringify(toDisplayTree(out.ast))).toContain('COUNT(DISTINCT v)');
  });

  it('refuses COUNT(DISTINCT *), saying what DISTINCT needs', () => {
    const out = parse('SELECT COUNT(DISTINCT *) FROM t');
    expect(!out.ok && out.error.message).toBe('`COUNT(DISTINCT *)` is not valid SQL.');
    expect(!out.ok && out.error.hint).toMatch(/needs a column/);
    const empty = parse('SELECT SUM(DISTINCT) FROM t');
    expect(!empty.ok && empty.error.message).toMatch(/a column name after DISTINCT/);
  });
});

describe('results — the same under both strategies', () => {
  for (const [name, options] of STRATEGIES) {
    describe(name, () => {
      it('counts each customer once, and the guests’ NULL never: 9 against 38 and 40', () => {
        const { rows, error } = run('SELECT COUNT(DISTINCT customerId), COUNT(customerId), COUNT(*) FROM orders', options);
        expect(error).toBeUndefined();
        expect(rows).toEqual([{ 'COUNT(DISTINCT customerId)': 9, 'COUNT(customerId)': 38, 'COUNT(*)': 40 }]);
        expect(distinctOf(orders(), 'customerId')).toHaveLength(9);
      });

      it('SUM, AVG, MIN and MAX of the distinct values differ from the plain ones where they should', () => {
        const [row] = run('SELECT SUM(DISTINCT v), AVG(DISTINCT v), MIN(DISTINCT v), MAX(DISTINCT v), SUM(v), AVG(v) FROM t', options, tiny()).rows;
        expect(row).toEqual({
          'SUM(DISTINCT v)': 6,
          'AVG(DISTINCT v)': 2,
          'MIN(DISTINCT v)': 1,
          'MAX(DISTINCT v)': 3,
          'SUM(v)': 10,
          'AVG(v)': 2,
        });
      });

      it('per group: a group of only NULLs counts 0 and sums NULL', () => {
        const rows = run('SELECT g, COUNT(DISTINCT v), SUM(DISTINCT v), AVG(DISTINCT v) FROM t GROUP BY g', options, tiny()).rows;
        const byGroup = Object.fromEntries(rows.map((r) => [String(r.g), r]));
        expect(byGroup.a).toMatchObject({ 'COUNT(DISTINCT v)': 2, 'SUM(DISTINCT v)': 3, 'AVG(DISTINCT v)': 1.5 });
        expect(byGroup.b).toMatchObject({ 'COUNT(DISTINCT v)': 1, 'SUM(DISTINCT v)': 3, 'AVG(DISTINCT v)': 3 });
        expect(byGroup.c).toMatchObject({ 'COUNT(DISTINCT v)': 0, 'SUM(DISTINCT v)': null, 'AVG(DISTINCT v)': null });
      });

      it('matches a plain computation over every customer’s orders, two DISTINCT columns at once', () => {
        const sql = 'SELECT customerId, COUNT(DISTINCT productId), SUM(DISTINCT qty), COUNT(qty) FROM orders GROUP BY customerId';
        const rows = run(sql, options).rows;
        const groups = new Map<string, Row[]>();
        for (const o of orders()) groups.set(String(o.customerId), [...(groups.get(String(o.customerId)) ?? []), o]);
        expect(rows).toHaveLength(groups.size);
        for (const row of rows) {
          const group = groups.get(String(row.customerId))!;
          expect(row['COUNT(DISTINCT productId)'], String(row.customerId)).toBe(distinctOf(group, 'productId').length);
          expect(row['SUM(DISTINCT qty)'], String(row.customerId)).toBe(sum(distinctOf(group, 'qty')));
          expect(row['COUNT(qty)']).toBe(group.length);
        }
      });

      it('one DISTINCT column under GROUP BY — the case the sort strategy sorts on (group, value)', () => {
        const rows = run('SELECT customerId, COUNT(DISTINCT productId), SUM(DISTINCT productId) FROM orders GROUP BY customerId', options).rows;
        for (const row of rows) {
          const group = orders().filter((o) => String(o.customerId) === String(row.customerId));
          expect(row['COUNT(DISTINCT productId)'], String(row.customerId)).toBe(distinctOf(group, 'productId').length);
          expect(row['SUM(DISTINCT productId)'], String(row.customerId)).toBe(sum(distinctOf(group, 'productId')));
        }
      });

      it('over a join, in HAVING when nobody selected it, and as the ORDER BY key', () => {
        const joined = run(
          'SELECT customers.city, COUNT(DISTINCT orders.productId) FROM customers JOIN orders ON customers.id = orders.customerId GROUP BY customers.city ORDER BY COUNT(DISTINCT orders.productId) DESC',
          options,
        ).rows;
        expect(joined.length).toBeGreaterThan(1);
        const counts = joined.map((r) => Number(r['COUNT(DISTINCT orders.productId)']));
        expect(counts).toEqual([...counts].sort((a, b) => b - a));
        const having = run('SELECT customerId FROM orders GROUP BY customerId HAVING COUNT(DISTINCT productId) >= 4', options).rows;
        const expected = [...new Set(orders().map((o) => o.customerId))].filter(
          (id) => distinctOf(orders().filter((o) => o.customerId === id), 'productId').length >= 4,
        );
        expect(having.map((r) => r.customerId).sort()).toEqual(expected.sort());
      });
    });
  }
});

describe('which values are the same value', () => {
  // A column that mixes 1, '1' and TRUE: `=` calls them equal, and so does SELECT DISTINCT; a DISTINCT aggregate agrees.
  const mixed = (): Database => ({
    tables: {
      m: {
        name: 'm',
        columns: ['id', 'v'],
        rows: [
          { id: 1, v: 1 },
          { id: 2, v: '1' },
          { id: 3, v: true },
          { id: 4, v: 2 },
          { id: 5, v: null },
        ],
        indexedColumns: ['id'],
      },
    },
  });
  for (const [name, options] of STRATEGIES) {
    it(`counts exactly what SELECT DISTINCT returns, NULL aside — ${name}`, () => {
      const distinctRows = run('SELECT DISTINCT v FROM m', options, mixed()).rows.filter((r) => r.v !== null);
      expect(run('SELECT COUNT(DISTINCT v) FROM m', options, mixed()).rows[0]?.['COUNT(DISTINCT v)']).toBe(distinctRows.length);
    });
  }
});

describe('how each strategy finds the repeats', () => {
  it('the hash strategy keeps a set, and says how many values it read and kept', () => {
    const { events } = run('SELECT COUNT(DISTINCT customerId) FROM orders', HASH);
    expect(events.some((e) => e.stage === 'plan' && /keeps a set of the values it has seen/.test(e.label))).toBe(true);
    expect(events.find((e) => e.stage === 'execute' && e.op === 'HashAggregate' && e.rowsProduced === 0)?.label).toBe(
      'HashAggregate kept a set of the values it had seen, so COUNT(DISTINCT customerId) read 38 values and kept 9 — a value counts the first time only, and a NULL never.',
    );
  });

  it('the sort strategy sorts on (group, value) instead, and the plan node says so', () => {
    const { events } = run('SELECT customerId, COUNT(DISTINCT productId) FROM orders GROUP BY customerId', SORT);
    expect(events.some((e) => e.stage === 'plan' && /by sorting on customerId, productId first/.test(e.label))).toBe(true);
    expect(events.some((e) => e.stage === 'plan' && /`productId` joins the sort key/.test(e.label))).toBe(true);
    expect(events.some((e) => e.stage === 'execute' && /SortAggregate sorted on \(customerId, productId\)/.test(e.label))).toBe(true);
    const aggregate = finalPlan(events)?.children?.[0];
    expect(aggregate?.detail).toBe('GROUP BY customerId; COUNT(DISTINCT productId); sorted on customerId, productId');
  });

  it('two DISTINCT columns: the sort cannot order both, so it sorts on the groups and keeps sets, and says why', () => {
    const { events } = run('SELECT customerId, COUNT(DISTINCT productId), COUNT(DISTINCT qty) FROM orders GROUP BY customerId', SORT);
    expect(events.some((e) => e.stage === 'execute' && /sorted on the groups alone: its DISTINCT aggregates read different columns/.test(e.label))).toBe(true);
    expect(finalPlan(events)?.children?.[0]?.detail).not.toMatch(/sorted on/);
  });

  it('with no GROUP BY, the sort strategy sorts on the column itself', () => {
    const { events } = run('SELECT COUNT(DISTINCT customerId) FROM orders', SORT);
    expect(events.some((e) => e.stage === 'plan' && /sorting on customerId first/.test(e.label) && /the sort puts equal values side by side/.test(e.label))).toBe(true);
  });

  it('a query with no DISTINCT aggregate narrates exactly as before', () => {
    const { events } = run('SELECT customerId, COUNT(productId) FROM orders GROUP BY customerId', SORT);
    expect(events.some((e) => /DISTINCT|kept a set|keeps a set|joins the sort key|sorted on the groups alone/.test(e.label))).toBe(false);
    expect(events.some((e) => e.stage === 'plan' && /by sorting on customerId first/.test(e.label))).toBe(true);
  });
});

describe('the other views', () => {
  it('reads as γ in relational algebra and LaTeX, and EXPLAIN shows it', () => {
    const plan = finalPlan(run('SELECT customerId, COUNT(DISTINCT productId) FROM orders GROUP BY customerId').events) as PlanNode;
    expect(planToRelationalAlgebra(plan)).toMatch(/γ_\{customerId; COUNT\(DISTINCT productId\)\}/);
    expect(planToLatex(plan)).toMatch(/DISTINCT/);
    const explain = run('EXPLAIN SELECT COUNT(DISTINCT customerId) FROM orders').rows.map((r) => Object.values(r).join(' ')).join('\n');
    expect(explain).toMatch(/COUNT\(DISTINCT customerId\)/);
  });

  it('works inside a compound query', () => {
    const { rows, error } = run('SELECT COUNT(DISTINCT customerId) FROM orders UNION ALL SELECT COUNT(*) FROM customers');
    expect(error).toBeUndefined();
    expect(rows.map((r) => Object.values(r)[0])).toEqual([9, 12]);
  });
});
