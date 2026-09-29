/**
 * plan.md §25.4 B6 — `EXPLAIN [ANALYZE] SELECT …` as a statement.
 */

import { describe, expect, it } from 'vitest';
import { EXPLAIN_COLUMN } from '../explain.ts';
import { parseStatement } from '../parser/parser.ts';
import { createSeedDatabase } from '../seed.ts';
import { DATASETS } from '../datasets.ts';
import { runQuery } from '../runQuery.ts';
import type { Database } from '../types.ts';

const db = (): Database => createSeedDatabase();
const lines = (sql: string) => runQuery(sql, db()).rows.map((r) => r[EXPLAIN_COLUMN] as string);
const stages = (sql: string) => new Set(runQuery(sql, db()).events.map((e) => e.stage));

describe('parsing', () => {
  it('reads EXPLAIN and EXPLAIN ANALYZE before a SELECT, case-insensitively', () => {
    const plain = parseStatement('EXPLAIN SELECT * FROM users');
    expect(plain.ok && plain.ast).toMatchObject({ kind: 'explain', analyze: false, select: { kind: 'select' } });
    const analyze = parseStatement('explain analyze SELECT * FROM users;');
    expect(analyze.ok && analyze.ast).toMatchObject({ kind: 'explain', analyze: true });
  });

  it('the statement span runs from EXPLAIN to the end of the query', () => {
    const sql = 'EXPLAIN ANALYZE SELECT * FROM users WHERE id = 5';
    const out = parseStatement(sql);
    expect(out.ok && out.ast.span).toEqual({ from: 0, to: sql.length });
    expect(out.ok && out.ast.kind === 'explain' && out.ast.select.span.from).toBe(16);
  });

  it.each([
    ['EXPLAIN', /Nothing to explain/],
    ['EXPLAIN ANALYZE', /Nothing to explain/],
    ['EXPLAIN DELETE FROM users', /EXPLAIN of a DELETE is not supported/],
    ['EXPLAIN ANALYZE UPDATE users SET age = 1', /EXPLAIN ANALYZE of a UPDATE is not supported/],
    ['EXPLAIN INSERT INTO users VALUES (1)', /INSERT is not supported/],
    ['EXPLAIN EXPLAIN SELECT * FROM users', /cannot be nested/],
  ])('rejects %s with a reason', (sql, message) => {
    const out = parseStatement(sql);
    expect(out.ok).toBe(false);
    expect(!out.ok && out.error.message).toMatch(message);
  });

  it('EXPLAIN ANALYZE of a write explains that it would perform the write', () => {
    const out = parseStatement('EXPLAIN ANALYZE DELETE FROM users');
    expect(!out.ok && out.error.hint).toMatch(/would perform it|running a write/);
  });
});

describe('EXPLAIN — the plan, and nothing executed', () => {
  it('returns one QUERY PLAN row per operator, with the cost model’s estimate', () => {
    const out = lines('EXPLAIN SELECT name FROM users WHERE id = 5');
    expect(out[0]).toMatch(/^Project {2}name {2}\(est ~1 rows\)$/);
    expect(out[1]).toMatch(/^ {2}-> {2}IndexScan users\.id .*\(est ~1 rows\)$/);
    expect(out.every((l) => !/actual/.test(l))).toBe(true);
  });

  it('shows the plan the optimizer chose — after its rewrites', () => {
    expect(lines('EXPLAIN SELECT * FROM users WHERE id = 5').join('\n')).toMatch(/IndexScan/);
    expect(lines('EXPLAIN SELECT * FROM users WHERE age > 30').join('\n')).toMatch(/SeqScan users/);
  });

  it('never reaches the executor, the buffer pool, the index or the lock manager', () => {
    const s = stages('EXPLAIN SELECT * FROM users WHERE id = 5');
    expect([...s].sort()).toEqual(['optimize', 'parse', 'plan', 'result'].sort());
    const events = runQuery('EXPLAIN SELECT * FROM users', db()).events;
    expect(events.some((e) => e.stage === 'buffer' || e.stage === 'execute')).toBe(false);
  });

  it('renumbers the trace: ids are the array indices, as everywhere else', () => {
    const { events } = runQuery('EXPLAIN SELECT * FROM users WHERE id = 5', db());
    expect(events.map((e) => e.id)).toEqual(events.map((_, i) => i));
  });

  it('says so in the trace: nothing was executed', () => {
    const { events } = runQuery('EXPLAIN SELECT * FROM users', db());
    const last = events[events.length - 1]!;
    expect(last.stage).toBe('result');
    expect(last.label).toMatch(/Nothing was executed and no page was read/);
  });

  it('covers every kind of SELECT: join, aggregate, HAVING, DISTINCT, ORDER BY, LIMIT', () => {
    const text = lines('EXPLAIN SELECT DISTINCT age FROM users WHERE age > 1 ORDER BY age LIMIT 3 OFFSET 1').join('\n');
    for (const op of ['Limit', 'HashDistinct', 'Project', 'Sort']) expect(text).toContain(op);
    expect(lines('EXPLAIN SELECT age, COUNT(*) FROM users GROUP BY age HAVING COUNT(*) > 1').join('\n')).toMatch(/Having[\s\S]*HashAggregate/);
  });
});

describe('EXPLAIN ANALYZE — the run, reported', () => {
  const analyze = () => runQuery('EXPLAIN ANALYZE SELECT * FROM users WHERE age > 30', db());

  it('puts the executor’s actual row count beside each estimate', () => {
    const out = analyze().rows.map((r) => r[EXPLAIN_COLUMN] as string);
    const scan = out.find((l) => l.includes('SeqScan users'))!;
    expect(scan).toMatch(/est ~\d+ rows; actual \d+ rows/);
    const actual = Number(/actual (\d+) rows/.exec(scan)![1]);
    const truth = runQuery('SELECT * FROM users WHERE age > 30', db()).rows.length;
    expect(actual).toBe(truth);
  });

  it('ends with the result size and what the buffer pool did', () => {
    const out = analyze().rows.map((r) => r[EXPLAIN_COLUMN] as string);
    expect(out[out.length - 2]).toMatch(/^Result: \d+ rows?$/);
    expect(out[out.length - 1]).toMatch(/^Buffer pool: \d+ hits?, \d+ miss(es)?, \d+ evictions?$/);
    const misses = Number(/(\d+) miss/.exec(out[out.length - 1]!)![1]);
    expect(misses).toBeGreaterThan(0);
  });

  it('keeps the whole trace — the execution is what you step through', () => {
    const s = new Set(analyze().events.map((e) => e.stage));
    expect(s.has('execute') && s.has('buffer') && s.has('parse') && s.has('plan')).toBe(true);
    const events = analyze().events;
    expect(events[events.length - 1]!.stage).toBe('result');
    expect(events.filter((e) => e.stage === 'result')).toHaveLength(1); // the query's own result is replaced, not doubled
    expect(events.map((e) => e.id)).toEqual(events.map((_, i) => i));
  });

  it('reports no timings — this engine makes no claim about latency', () => {
    expect(analyze().rows.map((r) => r[EXPLAIN_COLUMN]).join('\n')).not.toMatch(/ms\b|time/i);
  });

  it('agrees with a plain run: the same rows are what the operators produced', () => {
    const sql = 'SELECT age, COUNT(*) FROM users GROUP BY age';
    const out = runQuery(`EXPLAIN ANALYZE ${sql}`, db()).rows.map((r) => r[EXPLAIN_COLUMN] as string);
    const groups = runQuery(sql, db()).rows.length;
    expect(out.find((l) => l.startsWith('Project'))).toContain(`actual ${String(groups)} rows`);
  });
});

describe('q-error (plan.md §25.4 C2)', () => {
  // `employees`: department and office are perfectly correlated (every department occupies exactly one office),
  // which is exactly the independence assumption `AND` selectivity makes and exactly what it gets wrong.
  const correlated = () => DATASETS.employees.make();
  const correlatedQuery = "SELECT * FROM employees WHERE department = 'engineering' AND office = 'building-1';";

  it('names a real q-error, at least 10×, on the correlated dataset\'s own headline query', () => {
    const out = runQuery(`EXPLAIN ANALYZE ${correlatedQuery}`, correlated()).rows.map((r) => r[EXPLAIN_COLUMN] as string);
    const scan = out.find((l) => l.includes('SeqScan employees'))!;
    expect(scan).toMatch(/q-error (\d+(\.\d+)?)×/);
    const q = Number(/q-error (\d+(?:\.\d+)?)×/.exec(scan)![1]);
    expect(q).toBeGreaterThanOrEqual(10);
  });

  it('is the real ratio between the estimate and the actual, with the literature\'s own +1 smoothing', () => {
    const out = runQuery(`EXPLAIN ANALYZE ${correlatedQuery}`, correlated()).rows.map((r) => r[EXPLAIN_COLUMN] as string);
    const scan = out.find((l) => l.includes('SeqScan employees'))!;
    const est = Number(/est ~(\d+) rows/.exec(scan)![1]);
    const actual = Number(/actual (\d+) rows/.exec(scan)![1]);
    const q = Number(/q-error (\d+(?:\.\d+)?)×/.exec(scan)![1]);
    expect(q).toBeCloseTo(Math.max((est + 1) / (actual + 1), (actual + 1) / (est + 1)), 5);
  });

  it('says nothing when the estimate is close — no clutter for an ordinary query', () => {
    const out = lines('EXPLAIN ANALYZE SELECT * FROM users WHERE id = 5');
    expect(out.some((l) => l.includes('q-error'))).toBe(false);
  });

  it('never appears on a plain EXPLAIN — there is no actual to compare against', () => {
    const out = runQuery(`EXPLAIN ${correlatedQuery}`, correlated()).rows.map((r) => r[EXPLAIN_COLUMN] as string);
    expect(out.some((l) => l.includes('q-error'))).toBe(false);
  });
});

describe('errors and spans point at what was typed', () => {
  it('an unknown table or column inside an EXPLAIN is reported at the right offset', () => {
    const sql = 'EXPLAIN SELECT nope FROM users';
    const err = runQuery(sql, db()).error!;
    expect(err.message).toMatch(/no column called `nope`/);
    expect(sql.slice(err.from, err.to)).toBe('nope');
    const t = 'EXPLAIN ANALYZE SELECT * FROM nowhere';
    const terr = runQuery(t, db()).error!;
    expect(t.slice(terr.from, terr.to)).toBe('nowhere');
  });

  it('the parse tree’s highlight spans index the original text, prefix included', () => {
    const sql = 'EXPLAIN SELECT id FROM users';
    const parse = runQuery(sql, db()).events.find((e) => e.stage === 'parse' && e.span)!;
    if (parse.stage !== 'parse' || !parse.span) throw new Error('no parse span');
    expect(sql.slice(parse.span.from, parse.span.to)).toBe('id');
  });

  it('a syntax error in the inner query is an error, not a plan', () => {
    expect(runQuery('EXPLAIN SELECT FROM users', db()).error).toBeDefined();
  });
});

describe('it changes nothing', () => {
  it('EXPLAIN and EXPLAIN ANALYZE return no write — the table is untouched', () => {
    expect(runQuery('EXPLAIN SELECT * FROM users', db()).write).toBeUndefined();
    expect(runQuery('EXPLAIN ANALYZE SELECT * FROM users', db()).write).toBeUndefined();
  });

  it('both are deterministic', () => {
    for (const sql of ['EXPLAIN SELECT * FROM users WHERE id = 5', 'EXPLAIN ANALYZE SELECT * FROM users WHERE id = 5']) {
      expect(JSON.stringify(runQuery(sql, db()))).toBe(JSON.stringify(runQuery(sql, db())));
    }
  });
});
