/**
 * plan.md §25.4 B2 — `SELECT DISTINCT`, by hash (streaming) or by sort
 * (blocking), on the same `aggregateStrategy` seam `GROUP BY` uses.
 */

import { describe, expect, it } from 'vitest';
import { parse } from '../parser/parser.ts';
import { runQuery } from '../runQuery.ts';
import { DEFAULT_ENGINE_OPTIONS } from '../types.ts';
import type { Database, EngineOptions, Row, StepEvent } from '../types.ts';

const db = (): Database => ({
  tables: {
    t: {
      name: 't',
      columns: ['id', 'a', 'b'],
      rows: [
        { id: 1, a: 'x', b: 1 },
        { id: 2, a: 'y', b: 1 },
        { id: 3, a: 'x', b: 1 },
        { id: 4, a: null, b: 2 },
        { id: 5, a: null, b: 2 },
        { id: 6, a: 'y', b: 2 },
        { id: 7, a: 'x', b: null },
        { id: 8, a: 'x', b: null },
      ],
      indexedColumns: ['id'],
    },
  },
});
const HASH: EngineOptions = { ...DEFAULT_ENGINE_OPTIONS, aggregateStrategy: 'hash' };
const SORT: EngineOptions = { ...DEFAULT_ENGINE_OPTIONS, aggregateStrategy: 'sort' };

const run = (sql: string, options: EngineOptions = HASH) => {
  const r = runQuery(sql, db(), options);
  if (r.error) throw new Error(r.error.message);
  return r;
};
const norm = (rows: Row[]) => rows.map((r) => JSON.stringify(Object.entries(r))).sort();
const ops = (events: StepEvent[]) => new Set(events.flatMap((e) => (e.stage === 'execute' ? [e.op] : [])));

describe('parsing', () => {
  it('reads SELECT DISTINCT, case-insensitively', () => {
    const out = parse('select distinct a from t');
    expect(out.ok && out.ast.distinct).toBe(true);
    expect(parse('SELECT a FROM t').ok && (parse('SELECT a FROM t') as { ast: { distinct?: boolean } }).ast.distinct).toBeUndefined();
  });

  it('DISTINCT * and DISTINCT with several columns, computed columns or a JOIN', () => {
    expect(parse('SELECT DISTINCT * FROM t').ok).toBe(true);
    expect(parse('SELECT DISTINCT a, b FROM t').ok).toBe(true);
    expect(parse('SELECT DISTINCT b + 1 AS c FROM t').ok).toBe(true);
    expect(parse('SELECT DISTINCT authors.name FROM authors JOIN posts ON authors.id = posts.authorId').ok).toBe(true);
  });

  it('ORDER BY must name a column in the select list — and the error says why', () => {
    expect(parse('SELECT DISTINCT a FROM t ORDER BY a').ok).toBe(true);
    expect(parse('SELECT DISTINCT * FROM t ORDER BY b').ok).toBe(true);
    const out = parse('SELECT DISTINCT a FROM t ORDER BY b');
    expect(out.ok).toBe(false);
    expect(!out.ok && out.error.message).toMatch(/For SELECT DISTINCT, ORDER BY `b` must appear in the select list/);
    expect(!out.ok && out.error.hint).toMatch(/no one value to sort it by/);
  });

  it('a stray DISTINCT names the two places it is supported and not', () => {
    const out = parse('SELECT a, DISTINCT b FROM t');
    expect(!out.ok && out.error.hint).toMatch(/SELECT DISTINCT a, b/);
    expect(parse('SELECT COUNT(DISTINCT a) FROM t').ok).toBe(false);
  });
});

describe('results — the same under both strategies', () => {
  for (const [name, options] of [['hash', HASH], ['sort', SORT]] as const) {
    describe(name, () => {
      it('returns each distinct value once, and NULL once — NULLs count as equal', () => {
        expect(norm(run('SELECT DISTINCT a FROM t', options).rows)).toEqual(norm([{ a: 'x' }, { a: 'y' }, { a: null }]));
      });

      it('a combination of columns is distinct as a whole', () => {
        // (x,1) (y,1) (NULL,2) (y,2) (x,NULL)
        expect(run('SELECT DISTINCT a, b FROM t', options).rows).toHaveLength(5);
      });

      it('DISTINCT * is distinct only if every column repeats — here the id keeps every row', () => {
        expect(run('SELECT DISTINCT * FROM t', options).rows).toHaveLength(8);
      });

      it('applies after WHERE, and works on a computed column', () => {
        expect(norm(run('SELECT DISTINCT b * 10 AS c FROM t WHERE id > 3', options).rows)).toEqual(norm([{ c: 20 }, { c: null }]));
      });

      it('values equal under = are one value, whatever their type — 1, \'1\' and TRUE collapse, 2 does not', () => {
        // The same coercion `=` uses (and the joins): a column that mixes types is a corner, but both
        // strategies must agree on it. (SQLite keeps 1 and '1' apart — ledger: mixed-type-comparison.)
        const mixed: Database = { tables: { m: { name: 'm', columns: ['v'], rows: [{ v: 1 }, { v: '1' }, { v: 2 }, { v: 1 }, { v: true }] } } };
        expect(runQuery('SELECT DISTINCT v FROM m', mixed, options).rows).toHaveLength(2);
      });

      it('an empty table has no rows to return', () => {
        const empty: Database = { tables: { e: { name: 'e', columns: ['v'], rows: [] } } };
        expect(runQuery('SELECT DISTINCT v FROM e', empty, options).rows).toEqual([]);
      });

      it('after GROUP BY, and after a whole-table aggregate', () => {
        expect(run('SELECT DISTINCT COUNT(*) FROM t GROUP BY b', options).rows.length).toBeLessThanOrEqual(3);
        expect(run('SELECT DISTINCT COUNT(*) FROM t', options).rows).toEqual([{ 'COUNT(*)': 8 }]);
      });

      it('composes with ORDER BY (the column is in the list), ascending and descending', () => {
        expect(run('SELECT DISTINCT b FROM t ORDER BY b', options).rows.map((r) => r.b)).toEqual([1, 2, null]);
        expect(run('SELECT DISTINCT b FROM t ORDER BY b DESC', options).rows.map((r) => r.b)).toEqual([null, 2, 1]);
      });

      it('composes with LIMIT and OFFSET applied to the *distinct* rows', () => {
        expect(run('SELECT DISTINCT b FROM t ORDER BY b LIMIT 2', options).rows.map((r) => r.b)).toEqual([1, 2]);
        expect(run('SELECT DISTINCT b FROM t ORDER BY b LIMIT 2 OFFSET 1', options).rows.map((r) => r.b)).toEqual([2, null]);
      });

      it('composes with a JOIN', () => {
        const joined: Database = {
          tables: {
            a: { name: 'a', columns: ['id', 'n'], rows: [{ id: 1, n: 'p' }, { id: 2, n: 'p' }] },
            b: { name: 'b', columns: ['aid'], rows: [{ aid: 1 }, { aid: 1 }, { aid: 2 }] },
          },
        };
        const r = runQuery('SELECT DISTINCT a.n FROM a JOIN b ON a.id = b.aid', joined, { ...options, joinStrategy: 'hash' });
        expect(r.rows).toEqual([{ 'a.n': 'p' }]);
      });
    });
  }

  it('hash and sort agree on every row', () => {
    for (const sql of ['SELECT DISTINCT a FROM t', 'SELECT DISTINCT a, b FROM t', 'SELECT DISTINCT b FROM t WHERE id <> 4']) {
      expect(norm(run(sql, HASH).rows)).toEqual(norm(run(sql, SORT).rows));
    }
  });
});

describe('the two strategies are different operators with different costs', () => {
  it('hash streams and does no I/O of its own; sort writes spill pages through the pool', () => {
    const hash = run('SELECT DISTINCT a FROM t', HASH);
    const sort = run('SELECT DISTINCT a FROM t', SORT);
    expect(ops(hash.events).has('HashDistinct')).toBe(true);
    expect(ops(sort.events).has('SortDistinct')).toBe(true);
    const writes = (r: { events: StepEvent[] }) => r.events.filter((e) => e.stage === 'buffer' && e.action === 'write').length;
    expect(writes(hash)).toBe(0);
    expect(writes(sort)).toBeGreaterThan(0);
  });

  it('a LIMIT above a HashDistinct stops the scan early; above a SortDistinct it cannot', () => {
    const big: Database = {
      tables: { t: { name: 't', columns: ['v'], rows: Array.from({ length: 60 }, (_, i) => ({ v: i })) } },
    };
    const scans = (options: EngineOptions) =>
      runQuery('SELECT DISTINCT v FROM t LIMIT 2', big, options).events.filter((e) => e.stage === 'execute' && e.op === 'SeqScan').length;
    expect(scans(HASH)).toBe(2); // two rows pulled, and no more
    expect(scans(SORT)).toBe(60); // it had to read everything to sort it
  });

  it('narrates the repeats it drops, and says which strategy it is', () => {
    const { events } = run('SELECT DISTINCT a FROM t', HASH);
    expect(events.some((e) => /HashDistinct passes a row it has not seen before \(2 distinct so far, 1 repeat dropped\)/.test(e.label) || /distinct so far/.test(e.label))).toBe(true);
    expect(events.some((e) => /DISTINCT becomes a HashDistinct above the Project/.test(e.label) && /It streams/.test(e.label))).toBe(true);
    expect(run('SELECT DISTINCT a FROM t', SORT).events.some((e) => /DISTINCT becomes a SortDistinct/.test(e.label))).toBe(true);
  });

  it('a sort-based DISTINCT beside ORDER BY does not reuse the other sort’s scratch pages', () => {
    const r = run('SELECT DISTINCT b FROM t ORDER BY b', SORT);
    const spillWrites = r.events.flatMap((e) => (e.stage === 'buffer' && e.action === 'write' ? [e.pageId] : []));
    // Two external sorts ran (Sort, then SortDistinct); each writes into its own block.
    expect(ops(r.events)).toEqual(expect.objectContaining({}));
    expect(new Set(spillWrites).size).toBeGreaterThan(1);
    expect(r.rows.map((x) => x.b)).toEqual([1, 2, null]);
  });

  it('the cost model bounds the estimate by the distinct-value counts and labels it', () => {
    const { events } = run('SELECT DISTINCT a FROM t', HASH);
    const plan = events.find((e) => e.stage === 'plan' && JSON.stringify(e).includes('HashDistinct'));
    expect(JSON.stringify(plan)).toMatch(/min\(8, 3 distinct a\)/);
  });

  it('the parse tree and plan tree show DISTINCT', () => {
    const { events } = run('SELECT DISTINCT a FROM t', HASH);
    expect(JSON.stringify(events.filter((e) => e.stage === 'parse'))).toContain('DISTINCT columns');
    expect(JSON.stringify(events.filter((e) => e.stage === 'plan'))).toContain('HashDistinct');
  });
});

describe('the optimizer sees through DISTINCT', () => {
  it('still turns an equality into an index lookup, and keeps the DISTINCT and LIMIT above it', () => {
    const r = run('SELECT DISTINCT a FROM t WHERE id = 2 LIMIT 5');
    expect(r.rows).toEqual([{ a: 'y' }]);
    const rewrite = r.events.find((e) => e.stage === 'optimize' && e.rule === 'index-selection');
    expect(rewrite).toBeDefined();
    const after = JSON.stringify(rewrite && 'after' in rewrite ? rewrite.after : null);
    expect(after.indexOf('Limit')).toBeLessThan(after.indexOf('HashDistinct'));
    expect(after.indexOf('HashDistinct')).toBeLessThan(after.indexOf('IndexScan'));
  });

  it('keeps a SortDistinct’s ORDER BY key through a rewrite', () => {
    const r = run('SELECT DISTINCT b FROM t WHERE id > 0 ORDER BY b DESC', SORT);
    expect(r.rows.map((x) => x.b)).toEqual([null, 2, 1]);
  });
});
