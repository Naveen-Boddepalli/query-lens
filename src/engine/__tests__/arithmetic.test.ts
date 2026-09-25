/**
 * plan.md §25.4 B1b — arithmetic in `SELECT`, `WHERE` and `UPDATE … SET`,
 * `AS` aliases on computed columns, and negative literals. The number rules
 * (`value.ts`) are checked directly; the rest end to end. `oracle/` compares
 * the same statements with SQLite.
 */

import { describe, expect, it } from 'vitest';
import { parse, parseStatement } from '../parser/parser.ts';
import { exprToSql } from '../planner/index.ts';
import { runQuery } from '../runQuery.ts';
import type { Database, Row, StepEvent } from '../types.ts';
import { arithmetic, negate, toNumber } from '../value.ts';

describe('value arithmetic', () => {
  it('+ - * on numbers', () => {
    expect(arithmetic('+', 2, 3)).toBe(5);
    expect(arithmetic('-', 2, 3)).toBe(-1);
    expect(arithmetic('*', 4, 2.5)).toBe(10);
  });

  it('NULL in, NULL out — on either side, for every operator', () => {
    for (const op of ['+', '-', '*', '/', '%'] as const) {
      expect(arithmetic(op, null, 3)).toBeNull();
      expect(arithmetic(op, 3, null)).toBeNull();
    }
    expect(negate(null)).toBeNull();
  });

  it('whole-number division truncates toward zero; anything else divides exactly', () => {
    expect(arithmetic('/', 7, 2)).toBe(3);
    expect(arithmetic('/', -7, 2)).toBe(-3);
    expect(arithmetic('/', 7, -2)).toBe(-3);
    expect(arithmetic('/', 7.5, 2)).toBe(3.75);
    expect(arithmetic('/', 7, 2.5)).toBe(2.8);
  });

  it('division and modulo by zero are NULL, not an error and not Infinity', () => {
    expect(arithmetic('/', 5, 0)).toBeNull();
    expect(arithmetic('%', 5, 0)).toBeNull();
    expect(arithmetic('/', 0, 0)).toBeNull();
  });

  it('% takes the sign of the dividend, like C and SQLite', () => {
    expect(arithmetic('%', 7, 3)).toBe(1);
    expect(arithmetic('%', -7, 3)).toBe(-1);
    expect(arithmetic('%', 7, -3)).toBe(1);
  });

  it('never yields -0', () => {
    expect(Object.is(arithmetic('*', 0, -1), 0)).toBe(true);
    expect(Object.is(arithmetic('/', 0, -5), 0)).toBe(true);
    expect(Object.is(negate(0), 0)).toBe(true);
  });

  it('a boolean is 0 or 1; a numeric string is that number; other text is not a number', () => {
    expect(toNumber(true)).toBe(1);
    expect(toNumber(false)).toBe(0);
    expect(toNumber('5')).toBe(5);
    expect(toNumber(' 2.5 ')).toBe(2.5);
    expect(toNumber('1e2')).toBe(100);
    expect(toNumber('')).toBeNull();
    expect(toNumber('abc')).toBeNull();
    expect(toNumber('5abc')).toBeNull();
    expect(arithmetic('+', '5', 1)).toBe(6);
    expect(arithmetic('+', 'abc', 1)).toBeNull();
    expect(arithmetic('+', true, 1)).toBe(2);
  });
});

function where(sql: string) {
  const out = parse(`SELECT * FROM t WHERE ${sql}`);
  if (!out.ok) throw new Error(`${sql}: ${out.error.message}`);
  return out.ast.where!;
}

describe('parsing', () => {
  it('* / % bind tighter than + -, and both are left-associative', () => {
    expect(where('1 + 2 * 3 = 7')).toMatchObject({ kind: 'compare', left: { kind: 'arith', op: '+', right: { op: '*' } } });
    expect(where('10 - 4 - 3 = 3')).toMatchObject({ left: { op: '-', left: { op: '-' } } });
    expect(exprToSql(where('a - (b - c) = 1'))).toBe('a - (b - c) = 1');
    expect(exprToSql(where('(a + b) * c = 1'))).toBe('(a + b) * c = 1');
    expect(exprToSql(where('a + b * c = 1'))).toBe('a + b * c = 1');
  });

  it('a minus in front of a number is folded into the literal, so it stays an index key', () => {
    expect(where('a = -5')).toMatchObject({ right: { kind: 'literal', value: -5, raw: '-5' } });
    expect(where('a = - -5')).toMatchObject({ right: { kind: 'literal', value: 5 } });
    expect(where('a = -b')).toMatchObject({ right: { kind: 'neg', operand: { kind: 'column', name: 'b' } } });
  });

  it('unary minus binds tighter than *: -a * b is (-a) * b', () => {
    expect(where('-a * b = 1')).toMatchObject({ left: { kind: 'arith', op: '*', left: { kind: 'neg' } } });
  });

  it('the printer never lets a double minus become a comment', () => {
    expect(exprToSql(where('a = -(-b)'))).toBe('a = -(-b)');
    expect(exprToSql(where('a - -5 = 1'))).toBe('a - -5 = 1');
    expect(exprToSql(where('-(a + b) = 1'))).toBe('-(a + b) = 1');
  });

  it.each([
    '1 + 2 * 3 = 7',
    '(a + b) * (c - d) <> 0',
    'a - (b - c) > 1',
    'a / b % c = 0',
    '-(a * b) + 1 < 2',
    'a = 1 + 2 OR b IN (1 + 1, 3) OR c BETWEEN a - 1 AND a + 1',
  ])('arithmetic round-trips through exprToSql: %s', (sql) => {
    const once = exprToSql(where(sql));
    expect(exprToSql(where(once))).toBe(once);
  });

  it('* is multiplication after an operand and "every column" in a SELECT list — and COUNT(*) is unaffected', () => {
    expect(parse('SELECT * FROM t').ok).toBe(true);
    expect(parse('SELECT COUNT(*) FROM t').ok).toBe(true);
    const mul = parse('SELECT a * b FROM t');
    expect(mul.ok && mul.ast.select).toMatchObject({ kind: 'columns', items: [{ kind: 'expression', expr: { kind: 'arith', op: '*' } }] });
    expect(parse('SELECT a, * FROM t').ok).toBe(false);
  });

  it('AS names a computed column; a bare column stays a column, an aliased one becomes an expression', () => {
    const out = parse('SELECT a, b + 1 AS next, c AS renamed FROM t');
    expect(out.ok && out.ast.select).toMatchObject({
      items: [
        { kind: 'column', name: 'a' },
        { kind: 'expression', alias: 'next' },
        { kind: 'expression', alias: 'renamed', expr: { kind: 'column', name: 'c' } },
      ],
    });
  });

  it('rejects arithmetic on an aggregate, AS on an aggregate, and a computed column beside GROUP BY — each with a reason', () => {
    const err = (sql: string) => {
      const out = parse(sql);
      if (out.ok) throw new Error('expected an error');
      return out.error;
    };
    expect(err('SELECT COUNT(*) + 1 FROM t').message).toMatch(/aggregate is not supported yet/i);
    expect(err('SELECT COUNT(*) AS n FROM t').message).toMatch(/AS/);
    expect(err('SELECT a + 1, COUNT(*) FROM t GROUP BY a').message).toMatch(/computed column/i);
    expect(err('SELECT a + 1 FROM t GROUP BY a').message).toMatch(/computed column/i);
  });

  it('INSERT folds arithmetic on literals; a column reference is rejected', () => {
    const ok = parseStatement('INSERT INTO t VALUES (-5, 2 * 3, 10 / 4, NULL + 1)');
    expect(ok.ok && ok.ast.kind === 'insert' && ok.ast.values.items.map((i) => i.value)).toEqual([-5, 6, 2, null]);
    const bad = parseStatement('INSERT INTO t (a) VALUES (b + 1)');
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.error.message).toMatch(/expected a value, found `b`/i);
  });
});

const db = (): Database => ({
  tables: {
    items: {
      name: 'items',
      columns: ['id', 'price', 'qty', 'note'],
      rows: [
        { id: 1, price: 10, qty: 3, note: 'a' },
        { id: 2, price: 7.5, qty: 2, note: 'b' },
        { id: 3, price: 4, qty: null, note: 'c' },
        { id: 4, price: 9, qty: 0, note: null },
        { id: 5, price: -2, qty: 4, note: 'e' },
      ],
      indexedColumns: ['id'],
    },
  },
});
const rows = (sql: string): Row[] => {
  const r = runQuery(sql, db());
  if (r.error) throw new Error(r.error.message);
  return r.rows;
};
const rules = (events: StepEvent[]): string[] => events.flatMap((e) => (e.stage === 'optimize' ? [e.rule] : []));

describe('computed columns', () => {
  it('SELECT price * qty AS total — named by the alias, NULL where qty is NULL', () => {
    expect(rows('SELECT id, price * qty AS total FROM items ORDER BY id')).toEqual([
      { id: 1, total: 30 },
      { id: 2, total: 15 },
      { id: 3, total: null },
      { id: 4, total: 0 },
      { id: 5, total: -8 },
    ]);
  });

  it('an unaliased expression is named by its own canonical text', () => {
    expect(Object.keys(rows('SELECT price*qty FROM items')[0]!)).toEqual(['price * qty']);
    expect(Object.keys(rows('SELECT (price+1)*2 FROM items')[0]!)).toEqual(['(price + 1) * 2']);
  });

  it('dividing by a zero column gives NULL for that row, not an error', () => {
    // 10/3 → 3 (whole numbers truncate), 7.5/2 → 3.75 (exact), NULL/0 → NULL, -2/4 → 0 (toward zero)
    expect(rows('SELECT id, price / qty AS each FROM items ORDER BY id').map((r) => r.each)).toEqual([3, 3.75, null, null, 0]);
  });

  it('whole-number division truncates: 10 / 4 is 2', () => {
    expect(rows('SELECT 10 / 4 AS q, 10 % 4 AS r FROM items LIMIT 1')).toEqual([{ q: 2, r: 2 }]);
  });

  it('a comparison or a NULL test can be a column', () => {
    expect(rows('SELECT id, qty IS NULL AS missing FROM items WHERE id <= 3 ORDER BY id').map((r) => r.missing)).toEqual([false, false, true]);
  });

  it('an aliased plain column renames it', () => {
    expect(rows('SELECT note AS label FROM items WHERE id = 1')).toEqual([{ label: 'a' }]);
  });

  it('works through a JOIN, with qualified columns', () => {
    const joined: Database = {
      tables: {
        a: { name: 'a', columns: ['id', 'v'], rows: [{ id: 1, v: 10 }, { id: 2, v: 20 }] },
        b: { name: 'b', columns: ['aid', 'w'], rows: [{ aid: 1, w: 3 }, { aid: 2, w: 4 }] },
      },
    };
    const r = runQuery('SELECT a.id, a.v + b.w AS total FROM a JOIN b ON a.id = b.aid ORDER BY a.id', joined);
    expect(r.error?.message).toMatch(/ORDER BY/); // ORDER BY + JOIN is a separate, older limit
    expect(runQuery('SELECT a.id, a.v + b.w AS total FROM a JOIN b ON a.id = b.aid', joined).rows).toEqual([
      { 'a.id': 1, total: 13 },
      { 'a.id': 2, total: 24 },
    ]);
  });

  it('the plan tree shows the computed Project, and the parse tree an Expression node', () => {
    const { events } = runQuery('SELECT price * qty AS total FROM items', db());
    expect(JSON.stringify(events.find((e) => e.stage === 'plan' && JSON.stringify(e).includes('total')))).toContain('price * qty AS total');
    expect(JSON.stringify(events.filter((e) => e.stage === 'parse'))).toContain('"Expression"');
  });

  it('an unknown column inside an expression is reported, with its position', () => {
    const r = runQuery('SELECT price * nope FROM items', db());
    expect(r.error?.message).toMatch(/no column called `nope`/);
    expect(r.error?.from).toBe(15);
  });
});

describe('arithmetic in WHERE', () => {
  it('compares an expression with a value', () => {
    expect(rows('SELECT id FROM items WHERE price * qty > 10 ORDER BY id').map((r) => r.id)).toEqual([1, 2]);
    expect(rows('SELECT id FROM items WHERE price < 0').map((r) => r.id)).toEqual([5]);
    expect(rows('SELECT id FROM items WHERE price = -2').map((r) => r.id)).toEqual([5]);
  });

  it('a NULL in the arithmetic makes the comparison UNKNOWN, so the row is out — either way round', () => {
    const gt = rows('SELECT id FROM items WHERE price * qty > 5').map((r) => r.id);
    const le = rows('SELECT id FROM items WHERE NOT (price * qty > 5)').map((r) => r.id);
    expect([...gt, ...le]).not.toContain(3);
  });

  it('constant arithmetic is folded once — and then the index can answer it', () => {
    const r = runQuery('SELECT * FROM items WHERE id = 2 + 3', db());
    expect(r.rows.map((x) => x.id)).toEqual([5]);
    expect(rules(r.events)).toEqual(expect.arrayContaining(['constant-folding', 'index-selection']));
    const fold = r.events.find((e) => e.stage === 'optimize' && e.rule === 'constant-folding');
    expect(fold?.label).toMatch(/`2 \+ 3` is just 5/);
  });

  it('a function of the column defeats the index: id + 1 = 5 scans, id = 4 does not', () => {
    expect(rules(runQuery('SELECT * FROM items WHERE id + 1 = 5', db()).events)).not.toContain('index-selection');
    expect(rules(runQuery('SELECT * FROM items WHERE id = 4', db()).events)).toContain('index-selection');
    expect(rows('SELECT id FROM items WHERE id + 1 = 5').map((r) => r.id)).toEqual([4]);
  });

  it('folds constant arithmetic inside an always-true comparison and drops it', () => {
    const r = runQuery('SELECT id FROM items WHERE 2 + 3 > 4 AND id = 1', db());
    expect(r.rows).toEqual([{ id: 1 }]);
    const fold = r.events.find((e) => e.stage === 'optimize' && e.rule === 'constant-folding');
    expect(fold?.label).toMatch(/`2 \+ 3` is just 5.*always true/);
  });

  it('a negative bound is still an index range', () => {
    const r = runQuery('SELECT id FROM items WHERE id > -1', db());
    expect(r.rows).toHaveLength(5);
    expect(rules(r.events)).toContain('range-index-selection');
  });
});

describe('UPDATE … SET with expressions', () => {
  it('SET n = n + 1 reads the row as it was', () => {
    const r = runQuery('UPDATE items SET qty = qty + 1 WHERE id IN (1, 3)', db());
    expect(r.write?.rows.map((x) => x.qty)).toEqual([4, 2, null, 0, 4]); // NULL + 1 stays NULL
  });

  it('every SET value sees the original row, so SET a = b, b = a swaps', () => {
    const swap: Database = { tables: { t: { name: 't', columns: ['a', 'b'], rows: [{ a: 1, b: 2 }] } } };
    expect(runQuery('UPDATE t SET a = b, b = a', swap).write?.rows).toEqual([{ a: 2, b: 1 }]);
  });

  it('a value can be a column, a literal or arithmetic, and the changed index key is maintained', () => {
    const r = runQuery('UPDATE items SET id = id + 10 WHERE id = 1', db());
    expect(r.write?.rows.map((x) => x.id)).toEqual([11, 2, 3, 4, 5]);
    const narration = r.events.map((e) => e.label).join(' ');
    expect(narration).toMatch(/Because `id` changed, its B\+Tree drops key 1/);
    expect(narration).toMatch(/adds key 11/);
  });

  it('the parse and narration show the expression, not just its result', () => {
    const { events } = runQuery('UPDATE items SET qty = qty + 1 WHERE id = 1', db());
    expect(events.find((e) => e.label.startsWith('Read the SET clause'))?.label).toMatch(/`qty` = qty \+ 1/);
  });

  it('an unknown column on the right of SET is reported', () => {
    expect(runQuery('UPDATE items SET qty = nope + 1', db()).error?.message).toMatch(/no column called `nope`/);
  });
});

describe('INSERT with folded values', () => {
  it('writes the folded row', () => {
    const r = runQuery('INSERT INTO items VALUES (-9, 2 * 3.5, 10 / 4, \'x\')', db());
    expect(r.write?.rows.at(-1)).toEqual({ id: -9, price: 7, qty: 2, note: 'x' });
  });
});
