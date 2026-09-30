/**
 * plan.md §25.4 B1a — `OR`, `NOT`, parentheses, `<>`, `IS [NOT] NULL`, `IN`,
 * `LIKE`. Semantics written from SQL's own three-valued rules, not from any
 * engine's output; `oracle/` then checks the same tables against SQLite.
 */

import { describe, expect, it } from 'vitest';
import { evaluatePredicate, likeMatches } from '../exec/evaluate.ts';
import type { Truth } from '../exec/evaluate.ts';
import { parse } from '../parser/parser.ts';
import type { Expr } from '../parser/ast.ts';
import { exprToSql, optimize, buildPlan } from '../planner/index.ts';
import { runQuery } from '../runQuery.ts';
import { DEFAULT_ENGINE_OPTIONS } from '../types.ts';
import type { Database, Row } from '../types.ts';

function where(sql: string): Expr {
  const out = parse(`SELECT * FROM t WHERE ${sql}`);
  if (!out.ok) throw new Error(`${sql}: ${out.error.message}`);
  return out.ast.where!;
}

const truth = (sql: string, row: Row = {}): Truth => evaluatePredicate(where(sql), row);

describe('precedence and parentheses', () => {
  it('NOT binds tighter than AND, AND tighter than OR', () => {
    expect(exprToSql(where('a = 1 OR b = 2 AND c = 3'))).toBe('a = 1 OR b = 2 AND c = 3');
    expect(where('a = 1 OR b = 2 AND c = 3')).toMatchObject({ kind: 'or', right: { kind: 'and' } });
    expect(where('NOT a = 1 AND b = 2')).toMatchObject({ kind: 'and', left: { kind: 'not' } });
  });

  it('parentheses override it, and round-trip through exprToSql', () => {
    const e = where('(a = 1 OR b = 2) AND c = 3');
    expect(e).toMatchObject({ kind: 'and', left: { kind: 'or' } });
    expect(exprToSql(e)).toBe('(a = 1 OR b = 2) AND c = 3');
  });

  it.each([
    'a = 1 OR b = 2 AND c = 3',
    '(a = 1 OR b = 2) AND c = 3',
    'NOT (a = 1 AND b = 2)',
    'NOT a = 1 OR b IS NULL',
    'a NOT IN (1, 2, 3) AND b LIKE \'x%\'',
    'a NOT BETWEEN 1 AND 5',
    'a <> 1 AND (b IS NOT NULL OR c NOT LIKE \'_z\')',
  ])('exprToSql re-parses to the same tree: %s', (sql) => {
    const once = exprToSql(where(sql));
    expect(exprToSql(where(once))).toBe(once);
  });

  it('a parenthesised comparison is still a comparison, and the parentheses widen the span', () => {
    const e = where('(id = 5)');
    expect(e).toMatchObject({ kind: 'compare', op: '=' });
    expect(e.span.to - e.span.from).toBe('(id = 5)'.length);
  });

  it('!= is accepted and normalised to <>', () => {
    expect(where('a != 1')).toMatchObject({ kind: 'compare', op: '<>' });
  });

  it('NOT BETWEEN is NOT applied to the desugared range', () => {
    expect(where('a NOT BETWEEN 1 AND 5')).toMatchObject({ kind: 'not', operand: { kind: 'and' } });
  });
});

describe('three-valued logic — the truth tables', () => {
  const T = 'a = a', F = 'a <> a'; // TRUE / FALSE once a is non-null
  const U = 'n = 1'; // UNKNOWN when n is NULL
  const row: Row = { a: 1, n: null };

  it('AND: FALSE dominates UNKNOWN', () => {
    expect(truth(`${T} AND ${T}`, row)).toBe(true);
    expect(truth(`${T} AND ${U}`, row)).toBeNull();
    expect(truth(`${F} AND ${U}`, row)).toBe(false);
    expect(truth(`${U} AND ${F}`, row)).toBe(false);
    expect(truth(`${U} AND ${U}`, row)).toBeNull();
  });

  it('OR: TRUE dominates UNKNOWN', () => {
    expect(truth(`${F} OR ${F}`, row)).toBe(false);
    expect(truth(`${F} OR ${U}`, row)).toBeNull();
    expect(truth(`${T} OR ${U}`, row)).toBe(true);
    expect(truth(`${U} OR ${T}`, row)).toBe(true);
    expect(truth(`${U} OR ${U}`, row)).toBeNull();
  });

  it('NOT UNKNOWN is UNKNOWN — so NOT (x = 1) still rejects the NULL rows', () => {
    expect(truth(`NOT (${T})`, row)).toBe(false);
    expect(truth(`NOT (${F})`, row)).toBe(true);
    expect(truth(`NOT (${U})`, row)).toBeNull();
    const db: Database = { tables: { t: { name: 't', columns: ['x'], rows: [{ x: 1 }, { x: 2 }, { x: null }] } } };
    expect(runQuery('SELECT x FROM t WHERE x = 1', db).rows).toEqual([{ x: 1 }]);
    expect(runQuery('SELECT x FROM t WHERE NOT (x = 1)', db).rows).toEqual([{ x: 2 }]); // not the NULL row
  });

  it('IS NULL / IS NOT NULL are never UNKNOWN', () => {
    expect(truth('n IS NULL', row)).toBe(true);
    expect(truth('n IS NOT NULL', row)).toBe(false);
    expect(truth('a IS NULL', row)).toBe(false);
    expect(truth('a IS NOT NULL', row)).toBe(true);
    expect(truth('NULL IS NULL')).toBe(true);
  });

  it('IN: a hit is TRUE; a miss is FALSE; a NULL operand is UNKNOWN', () => {
    expect(truth('a IN (1, 2)', row)).toBe(true);
    expect(truth('a IN (2, 3)', row)).toBe(false);
    expect(truth('n IN (1, 2)', row)).toBeNull();
    expect(truth('n NOT IN (1, 2)', row)).toBeNull();
  });

  it('IN with a NULL in the list: a hit is still TRUE, a miss is UNKNOWN, not FALSE', () => {
    expect(truth('a IN (1, NULL)', row)).toBe(true);
    expect(truth('a IN (2, NULL)', row)).toBeNull();
  });

  it('the NOT IN trap: x NOT IN (1, NULL) is never TRUE', () => {
    expect(truth('a NOT IN (2, NULL)', row)).toBeNull(); // would be TRUE without the NULL
    expect(truth('a NOT IN (1, NULL)', row)).toBe(false);
    expect(truth('a NOT IN (2, 3)', row)).toBe(true);
    const db: Database = { tables: { t: { name: 't', columns: ['x'], rows: [{ x: 1 }, { x: 2 }, { x: 3 }] } } };
    expect(runQuery('SELECT x FROM t WHERE x NOT IN (1, 2)', db).rows).toEqual([{ x: 3 }]);
    expect(runQuery('SELECT x FROM t WHERE x NOT IN (1, NULL)', db).rows).toEqual([]);
  });

  it('IN compares with = semantics, so a number and its numeric string agree', () => {
    expect(truth("a IN ('1')", { a: 1 })).toBe(true);
  });
});

describe('LIKE', () => {
  it('% is any run (including none), _ is exactly one character', () => {
    expect(likeMatches('ada', 'a%')).toBe(true);
    expect(likeMatches('a', 'a%')).toBe(true);
    expect(likeMatches('ada', '%a')).toBe(true);
    expect(likeMatches('ada', '_da')).toBe(true);
    expect(likeMatches('da', '_da')).toBe(false);
    expect(likeMatches('ada', 'a_')).toBe(false);
    expect(likeMatches('ada', '%')).toBe(true);
    expect(likeMatches('', '%')).toBe(true);
    expect(likeMatches('', '_')).toBe(false);
    expect(likeMatches('ada', 'ada')).toBe(true);
  });

  it('is anchored — no implicit wildcard at either end', () => {
    expect(likeMatches('grace', 'race')).toBe(false);
    expect(likeMatches('grace', 'grac')).toBe(false);
  });

  it('is case-sensitive (PostgreSQL’s rule — SQLite’s default differs, see oracle/ledger.ts)', () => {
    expect(likeMatches('Ada', 'a%')).toBe(false);
    expect(likeMatches('Ada', 'A%')).toBe(true);
  });

  it('treats regex metacharacters in the pattern as themselves', () => {
    expect(likeMatches('a.c', 'a.c')).toBe(true);
    expect(likeMatches('abc', 'a.c')).toBe(false);
    expect(likeMatches('a+b', 'a+b')).toBe(true);
    expect(likeMatches('(x)', '(x)')).toBe(true);
    expect(likeMatches("it's", "it's")).toBe(true);
    expect(likeMatches('a\nb', 'a_b')).toBe(true); // `_` is any character, newline included
  });

  it('NULL on either side is UNKNOWN; NOT LIKE keeps that', () => {
    expect(truth("s LIKE 'a%'", { s: null })).toBeNull();
    expect(truth("s NOT LIKE 'a%'", { s: null })).toBeNull();
    expect(truth('s LIKE NULL', { s: 'a' })).toBeNull();
    expect(truth("s LIKE 'a%'", { s: 'ada' })).toBe(true);
    expect(truth("s NOT LIKE 'a%'", { s: 'ada' })).toBe(false);
  });

  it('numbers are matched as their text', () => {
    expect(truth("n LIKE '1%'", { n: 123 })).toBe(true);
  });
});

describe('<>', () => {
  it('is the negation of = for non-NULL values, and UNKNOWN for NULL', () => {
    expect(truth('a <> 2', { a: 1 })).toBe(true);
    expect(truth('a <> 1', { a: 1 })).toBe(false);
    expect(truth('a <> 1', { a: null })).toBeNull();
  });
});

describe('queries with the new predicates, end to end', () => {
  const db = (): Database => ({
    tables: {
      users: {
        name: 'users',
        columns: ['id', 'name', 'age'],
        rows: [
          { id: 1, name: 'ada', age: 36 },
          { id: 2, name: 'alan', age: 41 },
          { id: 3, name: 'grace', age: null },
          { id: 4, name: 'Grace', age: 85 },
          { id: 5, name: 'linus', age: 55 },
        ],
        indexedColumns: ['id'],
      },
    },
  });
  const ids = (sql: string) => runQuery(sql, db()).rows.map((r) => r.id);

  it('OR, IN, NOT, IS NULL, LIKE and <> each select what SQL says they select', () => {
    expect(ids('SELECT id FROM users WHERE id = 1 OR id = 5')).toEqual([1, 5]);
    expect(ids('SELECT id FROM users WHERE id IN (2, 4, 9)')).toEqual([2, 4]);
    expect(ids('SELECT id FROM users WHERE age IS NULL')).toEqual([3]);
    expect(ids('SELECT id FROM users WHERE age IS NOT NULL AND age > 40')).toEqual([2, 4, 5]);
    expect(ids("SELECT id FROM users WHERE name LIKE 'a%'")).toEqual([1, 2]);
    expect(ids("SELECT id FROM users WHERE name LIKE '%ace'")).toEqual([3, 4]);
    expect(ids("SELECT id FROM users WHERE name NOT LIKE '%a%'")).toEqual([5]);
    expect(ids('SELECT id FROM users WHERE id <> 3')).toEqual([1, 2, 4, 5]);
    expect(ids('SELECT id FROM users WHERE NOT (age > 40)')).toEqual([1]); // not id 3: age is NULL
    expect(ids('SELECT id FROM users WHERE (id = 1 OR id = 2) AND age < 40')).toEqual([1]);
  });

  it('the NULL-age row is in neither age > 40 nor NOT (age > 40) — the two do not partition the table', () => {
    const gt = ids('SELECT id FROM users WHERE age > 40');
    const not = ids('SELECT id FROM users WHERE NOT (age > 40)');
    expect([...gt, ...not].sort()).toEqual([1, 2, 4, 5]);
    expect(ids('SELECT id FROM users WHERE age IS NULL')).toEqual([3]); // IS NULL finds the row the other two lose
  });

  it('an OR is a filter, not an index lookup — but an AND beside it still uses the index', () => {
    const rules = (sql: string) =>
      runQuery(sql, db()).events.flatMap((e) => (e.stage === 'optimize' ? [e.rule] : []));
    expect(rules('SELECT * FROM users WHERE id = 1 OR id = 2')).not.toContain('index-selection');
    expect(rules('SELECT * FROM users WHERE id = 1 AND (age > 1 OR age IS NULL)')).toContain('index-selection');
  });

  it('a NOT (id = 5) is not mistaken for an index equality', () => {
    const parsed = parse('SELECT * FROM users WHERE NOT (id = 5)');
    if (!parsed.ok) throw new Error(parsed.error.message);
    const steps = optimize(buildPlan(parsed.ast), db().tables.users!, DEFAULT_ENGINE_OPTIONS.rowsPerPage);
    expect(steps.map((s) => s.rule)).not.toContain('index-selection');
  });

  it('a `<>` on an indexed column is never an index range', () => {
    const rules = runQuery('SELECT * FROM users WHERE id <> 3', db()).events.flatMap((e) =>
      e.stage === 'optimize' ? [e.rule] : [],
    );
    expect(rules).not.toContain('range-index-selection');
    expect(rules).not.toContain('index-selection');
  });

  it('the plan tree shows the new predicates, parenthesised', () => {
    const { events } = runQuery("SELECT * FROM users WHERE (id = 1 OR id = 2) AND name LIKE 'a%'", db());
    const plan = events.find((e) => e.stage === 'plan' && JSON.stringify(e.planTree).includes('OR'));
    expect(JSON.stringify(plan)).toContain("(id = 1 OR id = 2) AND name LIKE 'a%'");
  });

  it('the AST display carries a node for each new form, with the operand and items beneath it', () => {
    const { events } = runQuery("SELECT * FROM users WHERE id IN (1, 2) OR name NOT LIKE 'a%' OR age IS NULL", db());
    const ast = JSON.stringify(events.find((e) => e.stage === 'parse' && JSON.stringify(e).includes('IS NULL')));
    for (const label of ['"OR"', '"IN"', '"NOT LIKE"', '"IS NULL"']) expect(ast).toContain(label);
  });

  it('an unknown column inside an OR / IN / LIKE is still reported', () => {
    expect(runQuery('SELECT * FROM users WHERE id = 1 OR nope = 2', db()).error?.message).toMatch(/no column called `nope`/);
    expect(runQuery('SELECT * FROM users WHERE nope IN (1)', db()).error?.message).toMatch(/nope/);
    expect(runQuery("SELECT * FROM users WHERE name LIKE nope", db()).error?.message).toMatch(/nope/);
  });

  it('DELETE and UPDATE take the same predicates', () => {
    const del = runQuery('DELETE FROM users WHERE id IN (1, 2) OR age IS NULL', db());
    expect(del.write).toMatchObject({ kind: 'delete', deletedCount: 3 });
    const upd = runQuery("UPDATE users SET age = 0 WHERE name LIKE 'g%' OR id = 1", db());
    expect(upd.write).toMatchObject({ kind: 'update', updatedCount: 2 });
  });
});
