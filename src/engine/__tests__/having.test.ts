/**
 * plan.md §25.4 B2 — `HAVING`. A filter on the *groups* an aggregate produced:
 * unlike WHERE it may test an aggregate, because it runs after they exist.
 */

import { describe, expect, it } from 'vitest';
import { parse } from '../parser/parser.ts';
import { exprToSql } from '../planner/index.ts';
import { runQuery } from '../runQuery.ts';
import type { Database, Row, StepEvent } from '../types.ts';

const db = (): Database => ({
  tables: {
    emp: {
      name: 'emp',
      columns: ['id', 'dept', 'pay', 'boss'],
      rows: [
        { id: 1, dept: 'eng', pay: 100, boss: null },
        { id: 2, dept: 'eng', pay: 120, boss: 1 },
        { id: 3, dept: 'eng', pay: 80, boss: 1 },
        { id: 4, dept: 'ops', pay: 60, boss: null },
        { id: 5, dept: 'ops', pay: 70, boss: 4 },
        { id: 6, dept: 'hr', pay: 90, boss: null },
        { id: 7, dept: null, pay: 50, boss: null },
        { id: 8, dept: null, pay: 40, boss: null },
      ],
      indexedColumns: ['id'],
    },
  },
});
const rows = (sql: string, options?: Parameters<typeof runQuery>[2]): Row[] => {
  const r = runQuery(sql, db(), options);
  if (r.error) throw new Error(r.error.message);
  return r.rows;
};
const rules = (events: StepEvent[]) => events.flatMap((e) => (e.stage === 'optimize' ? [e.rule] : []));

describe('parsing', () => {
  it('reads HAVING after GROUP BY, with aggregates as operands', () => {
    const out = parse('SELECT dept, COUNT(*) FROM emp GROUP BY dept HAVING COUNT(*) > 1 AND SUM(pay) < 400');
    expect(out.ok && out.ast.having).toMatchObject({ kind: 'and', left: { kind: 'compare', left: { kind: 'aggregate', fn: 'COUNT' } } });
    expect(out.ok && exprToSql(out.ast.having!)).toBe('COUNT(*) > 1 AND SUM(pay) < 400');
  });

  it('the statement span takes HAVING in', () => {
    const sql = 'SELECT dept FROM emp GROUP BY dept HAVING COUNT(*) > 1';
    const out = parse(sql);
    expect(out.ok && out.ast.span.to).toBe(sql.length);
  });

  it('an aggregate in WHERE is refused, and the error points at HAVING', () => {
    const out = parse('SELECT dept FROM emp WHERE COUNT(*) > 1 GROUP BY dept');
    expect(out.ok).toBe(false);
    expect(!out.ok && out.error.message).toMatch(/`COUNT\(…\)` cannot be used here/);
    expect(!out.ok && out.error.hint).toMatch(/HAVING/);
  });

  it('HAVING without GROUP BY or an aggregate says why', () => {
    const out = parse('SELECT id FROM emp HAVING id > 1');
    expect(!out.ok && out.error.message).toMatch(/HAVING needs GROUP BY or an aggregate/);
  });

  it('a plain column that is neither grouped nor aggregated is refused', () => {
    const out = parse('SELECT dept FROM emp GROUP BY dept HAVING pay > 50');
    expect(!out.ok && out.error.message).toMatch(/`pay` is not aggregated and is not in the GROUP BY list/);
  });

  it('a grouped column is fine, and so is HAVING on a whole-table aggregate', () => {
    expect(parse("SELECT dept FROM emp GROUP BY dept HAVING dept <> 'hr'").ok).toBe(true);
    expect(parse('SELECT COUNT(*) FROM emp HAVING COUNT(*) > 3').ok).toBe(true);
    expect(parse('SELECT COUNT(*) FROM emp HAVING id > 3').ok).toBe(false);
  });

  it('HAVING with no GROUP BY makes one group, so a plain column beside it is refused — join or not', () => {
    // PostgreSQL refuses these; QueryLens once answered the first with a single row holding `name: null`.
    for (const sql of ['SELECT name FROM emp HAVING COUNT(*) > 1', 'SELECT * FROM emp HAVING COUNT(*) > 1', 'SELECT a.id FROM a JOIN b ON a.id = b.id HAVING COUNT(*) > 1']) {
      const out = parse(sql);
      expect(!out.ok && out.error.message, sql).toMatch(/is not aggregated|cannot be combined with HAVING/);
    }
    expect(parse('SELECT COUNT(*) FROM emp HAVING COUNT(*) > 1').ok).toBe(true);
  });

  it('COUNT(DISTINCT x) parses in HAVING (plan.md §27.5 S5); COUNT(DISTINCT *) is refused by name', () => {
    expect(parse('SELECT dept FROM emp GROUP BY dept HAVING COUNT(DISTINCT pay) > 1').ok).toBe(true);
    const out = parse('SELECT COUNT(DISTINCT *) FROM emp');
    expect(!out.ok && out.error.message).toMatch(/COUNT\(DISTINCT \*\)` is not valid SQL/);
  });
});

describe('results', () => {
  it('keeps only the groups whose aggregate passes', () => {
    expect(new Set(rows('SELECT dept, COUNT(*) FROM emp GROUP BY dept HAVING COUNT(*) > 1').map((r) => r.dept))).toEqual(new Set(['eng', 'ops', null]));
    expect(rows('SELECT dept, COUNT(*) FROM emp GROUP BY dept HAVING COUNT(*) >= 3')).toEqual([{ dept: 'eng', 'COUNT(*)': 3 }]);
  });

  it('can test an aggregate that is not in the SELECT list', () => {
    expect(rows('SELECT dept FROM emp GROUP BY dept HAVING SUM(pay) > 150').map((r) => r.dept).sort()).toEqual(['eng']);
    expect(Object.keys(rows('SELECT dept FROM emp GROUP BY dept HAVING SUM(pay) > 150')[0]!)).toEqual(['dept']);
  });

  it('WHERE filters rows before grouping; HAVING filters groups after — the two answer different questions', () => {
    // WHERE pay > 65 leaves eng {100,120,80} and ops {70} and hr {90}: counts 3, 1, 1.
    expect(rows('SELECT dept, COUNT(*) FROM emp WHERE pay > 65 GROUP BY dept HAVING COUNT(*) > 1')).toEqual([{ dept: 'eng', 'COUNT(*)': 3 }]);
    // HAVING alone counts every row first: ops has 2, so it stays.
    expect(rows('SELECT dept, COUNT(*) FROM emp GROUP BY dept HAVING COUNT(*) > 1').map((r) => r.dept)).toContain('ops');
  });

  it('combines aggregates and grouped columns with AND, OR, NOT', () => {
    expect(rows("SELECT dept FROM emp GROUP BY dept HAVING dept = 'hr' OR COUNT(*) = 3").map((r) => r.dept).sort()).toEqual(['eng', 'hr']);
    expect(rows('SELECT dept, COUNT(*) FROM emp GROUP BY dept HAVING NOT (COUNT(*) > 1)')).toEqual([{ dept: 'hr', 'COUNT(*)': 1 }]);
  });

  it('a group whose aggregate is NULL is UNKNOWN, so it is dropped — under the predicate and under its negation', () => {
    // AVG(boss) is NULL for the hr and dept-NULL groups (every boss is NULL there).
    const gt = rows('SELECT dept FROM emp GROUP BY dept HAVING AVG(boss) > 1').map((r) => r.dept);
    const not = rows('SELECT dept FROM emp GROUP BY dept HAVING NOT (AVG(boss) > 1)').map((r) => r.dept);
    expect(new Set([...gt, ...not])).not.toContain('hr');
    expect(rows('SELECT dept FROM emp GROUP BY dept HAVING AVG(boss) IS NULL').map((r) => r.dept).sort()).toEqual(['hr', null]);
  });

  it('works on a whole-table aggregate: one group, kept or not', () => {
    expect(rows('SELECT COUNT(*) FROM emp HAVING COUNT(*) > 3')).toEqual([{ 'COUNT(*)': 8 }]);
    expect(rows('SELECT COUNT(*) FROM emp HAVING COUNT(*) > 30')).toEqual([]);
  });

  it('accepts arithmetic on aggregates inside HAVING', () => {
    expect(rows('SELECT dept FROM emp GROUP BY dept HAVING SUM(pay) / COUNT(*) >= 90').map((r) => r.dept).sort()).toEqual(['eng', 'hr']);
  });

  it('is the same under both aggregate strategies', () => {
    const sql = 'SELECT dept, SUM(pay) FROM emp GROUP BY dept HAVING SUM(pay) > 100';
    const norm = (rs: Row[]) => rs.map((r) => JSON.stringify(r)).sort();
    expect(norm(rows(sql, { bufferFrames: 8, rowsPerPage: 4, policy: 'lru', aggregateStrategy: 'sort' }))).toEqual(norm(rows(sql)));
  });

  it('LIMIT applies after HAVING', () => {
    expect(rows('SELECT dept, COUNT(*) FROM emp GROUP BY dept HAVING COUNT(*) > 1 LIMIT 1')).toHaveLength(1);
  });

  it('an unknown column named in an aggregate inside HAVING is reported', () => {
    expect(runQuery('SELECT dept FROM emp GROUP BY dept HAVING SUM(nope) > 1', db()).error?.message).toMatch(/no column called `nope`/);
  });
});

describe('the plan and the optimizer', () => {
  it('HAVING sits above the aggregate, and the WHERE still becomes an index/scan rewrite below it', () => {
    // `db()`'s usual 8 rows are too few for the honest cost gate (plan.md §25.4 C5) to ever prefer the index —
    // padded locally, since `db()` itself is shared by every other test in this file and its row count matters to
    // them. The filler never matches `id = 2` or has a `dept`, so it never reaches this query's own HAVING clause.
    const padded: Database = {
      tables: {
        emp: {
          ...db().tables.emp!,
          rows: [...db().tables.emp!.rows, ...Array.from({ length: 30 }, (_, i) => ({ id: 1000 + i, dept: null, pay: 0, boss: null }))],
        },
      },
    };
    const r = runQuery('SELECT dept, COUNT(*) FROM emp WHERE id = 2 GROUP BY dept HAVING COUNT(*) >= 1', padded);
    expect(r.rows).toEqual([{ dept: 'eng', 'COUNT(*)': 1 }]);
    expect(rules(r.events)).toContain('index-selection'); // the rules see through the Having
    const last = [...r.events].reverse().find((e) => e.stage === 'optimize' && e.rule === 'index-selection');
    const tree = JSON.stringify(last && 'after' in last ? last.after : null);
    expect(tree.indexOf('Having')).toBeGreaterThan(-1);
    expect(tree.indexOf('Having')).toBeLessThan(tree.indexOf('IndexScan'));
  });

  it('predicate pushdown still moves a WHERE into the scan beneath a HAVING', () => {
    expect(rules(runQuery("SELECT dept FROM emp WHERE pay > 10 GROUP BY dept HAVING COUNT(*) > 1", db()).events)).toContain('predicate-pushdown');
  });

  it('narrates HAVING as running after aggregation — the contrast with WHERE', () => {
    const { events } = runQuery('SELECT dept, COUNT(*) FROM emp GROUP BY dept HAVING COUNT(*) > 1', db());
    expect(events.some((e) => /HAVING becomes a Having filter above the aggregate/.test(e.label) && /before\* they are grouped/.test(e.label))).toBe(true);
    expect(events.some((e) => e.stage === 'execute' && e.op === 'Having' && /passes a group through/.test(e.label))).toBe(true);
    expect(JSON.stringify(events.filter((e) => e.stage === 'parse'))).toContain('"Having"');
  });

  it('the cost model labels its guess for a HAVING as a default, not a statistic', () => {
    const { events } = runQuery('SELECT dept, COUNT(*) FROM emp GROUP BY dept HAVING COUNT(*) > 1', db());
    expect(JSON.stringify(events.find((e) => e.stage === 'plan' && JSON.stringify(e).includes('Having')))).toMatch(/HAVING: ⅓ default/);
  });
});
