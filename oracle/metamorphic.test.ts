// @vitest-environment node
/**
 * Metamorphic tests inside QueryLens (plan.md §25.4 A1a). No external oracle:
 * each property is a *relation* between two runs of the engine that must hold
 * whatever the answer is.
 *
 *   physical invariance   buffer size, page size, policy, join algorithm,
 *                         aggregate strategy and whether an index exists change
 *                         the trace, never the rows
 *   NoREC-shaped          the optimized plan returns what an unoptimized
 *                         evaluation of the same predicate over the raw rows does
 *   index ↔ heap          after any writes, an indexed lookup finds exactly the
 *                         rows a scan does
 *   determinism           the same input yields the same trace, event for event
 *
 * The SQLite suite (`differential.test.ts`) says the answers are *right*; this
 * one says they are *stable* — and it still works on a build where SQLite is
 * not available or the two dialects would disagree.
 */

import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { passes } from '../src/engine/exec/evaluate.ts';
import { mapChildren, parse } from '../src/engine/parser/index.ts';
import type { Expr } from '../src/engine/parser/index.ts';
import { runQuery } from '../src/engine/runQuery.ts';
import { DEFAULT_ENGINE_OPTIONS } from '../src/engine/types.ts';
import type { EngineOptions, Row, SqlValue } from '../src/engine/types.ts';
import { multisetDiff, sequenceDiff } from './compare.ts';
import type { Tuple } from './compare.ts';
import { ORACLE_TIMEOUT, oracleParams } from './config.ts';
import { optionsArb, sessionArb } from './generate.ts';
import { applyWrite, qlTuples, toDatabase } from './harness.ts';
import { isWrite, orderKeyOf, outputKeys, renderQuery } from './model.ts';
import type { ReadQuery, TableSpec, WriteQuery } from './model.ts';
import { tupleOf } from './sqlite.ts';

vi.setConfig({ testTimeout: ORACLE_TIMEOUT });

/** Applies the session's writes, then returns the tables and the final read. */
function settle(tables: readonly TableSpec[], steps: readonly (ReadQuery | WriteQuery)[], options: EngineOptions) {
  let current = [...tables];
  for (const q of steps.slice(0, -1)) {
    if (!isWrite(q)) continue;
    const result = runQuery(renderQuery(q), toDatabase(current), options);
    expect(result.error).toBeUndefined();
    current = applyWrite(current, q, result);
  }
  return { tables: current, read: steps[steps.length - 1] as ReadQuery };
}

function answer(tables: readonly TableSpec[], q: ReadQuery, options: EngineOptions, indexed: boolean): Tuple[] {
  const result = runQuery(renderQuery(q), toDatabase(tables, indexed), options);
  expect(result.error, renderQuery(q)).toBeUndefined();
  return qlTuples(q, tables, result.rows);
}

/**
 * The reference's own `IN (subquery)` resolution — the subquery's table, its WHERE as a filter, its column's values.
 * No planner and no pages, so NoREC still compares the optimized plan with "the predicate and a loop"; without it a
 * parsed subquery has no values yet and would read as an empty list.
 */
function resolveForReference(expr: Expr | undefined, tables: readonly TableSpec[]): Expr | undefined {
  const walk = (e: Expr): Expr => {
    const out = mapChildren(e, walk);
    if (out.kind === 'scalar') return { kind: 'literal', value: scalarByHand(out.select, tables), raw: '', span: out.span };
    if (out.kind !== 'in' || !out.subquery) return out;
    const { column, from, where } = out.subquery;
    const rows = tables.find((t) => t.name === from.name)!.rows.filter((row) => passes(where, row));
    return { ...out, items: rows.map((row) => ({ kind: 'literal' as const, value: row[column.name] ?? null, raw: '', span: out.span })) };
  };
  return expr && walk(expr);
}

/**
 * The reference's own scalar subquery (plan.md §27.5 S6): its table's rows that pass its WHERE, then the one aggregate
 * it computes, or the first value of the column it sorts — by hand, in a loop, with no planner, no sort and no pages.
 */
function scalarByHand(select: Extract<Expr, { kind: 'scalar' }>['select'], tables: readonly TableSpec[]): SqlValue {
  const rows = tables.find((t) => t.name === select.from.name)!.rows.filter((row) => passes(select.where, row));
  const item = select.select.kind === 'columns' ? select.select.items[0] : undefined;
  if (item?.kind === 'column') {
    const values = rows.map((r) => r[item.name] ?? null).filter((v) => v !== null);
    if (values.length === 0) return null;
    type Value = Exclude<SqlValue, null>;
    const pick = (a: Value, b: Value): Value => ((select.orderBy?.direction === 'desc' ? a > b : a < b) ? a : b);
    return values.reduce(pick);
  }
  if (item?.kind !== 'aggregate') throw new Error('the oracle only generates a column or an aggregate here');
  if (item.arg.kind === 'star') return rows.length;
  const column = item.arg.name;
  let values = rows.map((r) => r[column] ?? null).filter((v) => v !== null);
  if (item.arg.distinct) values = [...new Map(values.map((v) => [JSON.stringify(v), v])).values()];
  if (item.fn === 'COUNT') return values.length;
  if (values.length === 0) return null;
  const sum = values.reduce<number>((a, v) => a + Number(v), 0);
  if (item.fn === 'SUM') return sum;
  if (item.fn === 'AVG') return sum / values.length;
  return values.reduce((a, b) => ((item.fn === 'MIN' ? b < a : b > a) ? b : a));
}

/**
 * The reference's own `EXISTS` (plan.md §27.5 S1), for one outer row of `outer`: does any row of the subquery's table
 * pass its `WHERE`, read off the two rows side by side, every column qualified? No join, no planner — the subquery
 * run again for this row, which is what a correlated subquery means and what the engine's semi-join replaces.
 */
function existsForRow(expr: Expr | undefined, row: Row, outer: string, tables: readonly TableSpec[]): Expr | undefined {
  const qualified = (table: string, r: Row): Row => Object.fromEntries(Object.entries(r).map(([k, v]) => [`${table}.${k}`, v]));
  const walk = (e: Expr): Expr => {
    if (e.kind !== 'exists') return mapChildren(e, walk);
    const { from, where } = e.subquery;
    const found = tables.find((t) => t.name === from.name)!.rows.some((inner) => passes(where, { ...qualified(outer, row), ...qualified(from.name, inner) }));
    return { ...e, resolved: found };
  };
  return expr && walk(expr);
}

/** The order-defining column's position in the output, when there is an ORDER BY and it is projected. */
function keyAt(q: ReadQuery, tables: readonly TableSpec[]): number {
  const key = orderKeyOf(q);
  return key === null ? -1 : outputKeys(q, tables).indexOf(key);
}

function same(q: ReadQuery, tables: readonly TableSpec[], a: Tuple[], b: Tuple[]): string | null {
  // A LIMIT without ORDER BY picks *some* rows, and which depends on scan order — only the count is defined.
  if (q.limit !== undefined && orderKeyOf(q) === null) return a.length === b.length ? null : `LIMIT count ${a.length} vs ${b.length}`;
  if (q.limit !== undefined) {
    // ORDER BY + LIMIT: ties make the *rows* undefined; the keys of the first n rows are not.
    const at = keyAt(q, tables);
    if (a.length !== b.length) return `LIMIT count ${a.length} vs ${b.length}`;
    return at < 0 ? null : sequenceDiff(a.map((t) => t[at]!), b.map((t) => t[at]!));
  }
  const bag = multisetDiff(a, b);
  if (bag) return bag;
  const at = keyAt(q, tables);
  return at < 0 ? null : sequenceDiff(a.map((t) => t[at]!), b.map((t) => t[at]!));
}

describe('metamorphic — physical choices never change the rows', () => {
  it('buffer size, page size, policy, join algorithm, aggregate strategy and index presence', () => {
    fc.assert(
      fc.property(sessionArb('any'), optionsArb, optionsArb, ({ tables, steps }, a, b) => {
        const { tables: settled, read } = settle(tables, steps, DEFAULT_ENGINE_OPTIONS);
        const base = answer(settled, read, a, true);
        const other = answer(settled, read, b, true);
        const noIndex = answer(settled, read, a, false);
        const sql = renderQuery(read);
        expect(same(read, settled, base, other), `${sql} — options ${JSON.stringify(a)} vs ${JSON.stringify(b)}`).toBeNull();
        expect(same(read, settled, base, noIndex), `${sql} — with and without indexes`).toBeNull();
      }),
      oracleParams(),
    );
  });
});

describe('metamorphic — NoREC-shaped: the optimized plan agrees with evaluating the predicate directly', () => {
  it('SELECT … WHERE returns exactly the rows the predicate keeps', () => {
    fc.assert(
      fc.property(sessionArb('select'), optionsArb, ({ tables, steps }, options) => {
        const { tables: settled, read } = settle(tables, steps, options);
        // The reference is the predicate and a loop: it has no DISTINCT, so those queries are the differential's.
        if (read.kind !== 'select' || read.limit !== undefined || read.distinct) return;

        const parsed = parse(renderQuery(read));
        if (!parsed.ok) throw new Error(parsed.error.message);
        const table = settled.find((t) => t.name === read.table)!;
        // The reference projects plain columns only, so a computed column's *value* is left to the SQLite
        // comparison — what NoREC checks here is which rows the optimized plan keeps.
        const keys = outputKeys(read, settled).slice(0, outputKeys(read, settled).length - (read.computed?.length ?? 0));
        // The reference never plans, never touches a page or an index — it is the predicate and a loop.
        const where = resolveForReference(parsed.ast.where, settled);
        const expected = table.rows.filter((row) => passes(existsForRow(where, row, table.name, settled), row)).map((row) => tupleOf(row, keys));

        const actual = answer(settled, read, options, true).map((t) => t.slice(0, keys.length));
        expect(multisetDiff(actual, expected), renderQuery(read)).toBeNull();
      }),
      oracleParams(),
    );
  });

  it('COUNT(*) WHERE agrees with the size of that same reference', () => {
    fc.assert(
      fc.property(sessionArb('select'), ({ tables, steps }) => {
        const { tables: settled, read } = settle(tables, steps, DEFAULT_ENGINE_OPTIONS);
        if (read.kind !== 'select') return;
        const count = renderQuery({
          kind: 'aggregate',
          table: read.table,
          group: [],
          shownGroup: [],
          aggs: [{ fn: 'COUNT', arg: '*' }],
          where: read.where,
        });
        const parsed = parse(count);
        if (!parsed.ok) throw new Error(parsed.error.message);
        const where = resolveForReference(parsed.ast.where, settled);
        const kept = settled.find((t) => t.name === read.table)!.rows.filter((row) => passes(existsForRow(where, row, read.table, settled), row)).length;
        const result = runQuery(count, toDatabase(settled), DEFAULT_ENGINE_OPTIONS);
        expect(result.rows, count).toEqual([{ 'COUNT(*)': kept }]);
      }),
      oracleParams(),
    );
  });
});

describe('metamorphic — index and heap agree after writes', () => {
  it('every id a table holds is found by an indexed lookup, and no absent id is', () => {
    fc.assert(
      fc.property(sessionArb('select'), optionsArb, ({ tables, steps }, options) => {
        const { tables: settled } = settle(tables, steps, options);
        const t = settled.find((x) => x.name === 't')!;
        // An INSERT that names no `id` leaves it NULL, and `id = NULL` matches nothing — by design.
        const present = new Set(t.rows.map((r) => r.id).filter((id): id is number => typeof id === 'number'));
        for (const id of [...present, 0, 41, 999]) {
          const sql = `SELECT * FROM t WHERE id = ${String(id)}`;
          const viaIndex = runQuery(sql, toDatabase(settled, true), options).rows;
          const viaScan = runQuery(sql, toDatabase(settled, false), options).rows;
          // Without an ORDER BY the order is not defined, and a composite index returns matching rows in *key* order
          // (its later columns) where a scan returns them in heap order — the same rows, so compare them as a bag.
          const bag = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).sort();
          expect(bag(viaIndex), sql).toEqual(bag(viaScan));
          expect(viaIndex.length, sql).toBe(t.rows.filter((r) => r.id === id).length);
        }
      }),
      oracleParams(0.5),
    );
  });
});

describe('metamorphic — the engine is deterministic', () => {
  it('the same statement over the same data yields the same trace, event for event', () => {
    fc.assert(
      fc.property(sessionArb('any'), optionsArb, ({ tables, steps }, options) => {
        const { tables: settled, read } = settle(tables, steps, options);
        const sql = renderQuery(read);
        const a = runQuery(sql, toDatabase(settled), options);
        const b = runQuery(sql, toDatabase(settled), options);
        expect(JSON.stringify(a)).toBe(JSON.stringify(b));
      }),
      oracleParams(0.5),
    );
  });
});
