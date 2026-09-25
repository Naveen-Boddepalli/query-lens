/**
 * plan.md §25.4 B1c — `LIMIT n OFFSET m`. The point worth teaching is that an
 * OFFSET is *not* free: the skipped rows are still produced by everything
 * beneath and then thrown away.
 */

import { describe, expect, it } from 'vitest';
import { parse } from '../parser/parser.ts';
import { runQuery } from '../runQuery.ts';
import type { Database } from '../types.ts';

const db = (n = 10): Database => ({
  tables: {
    t: {
      name: 't',
      columns: ['id', 'v'],
      rows: Array.from({ length: n }, (_, i) => ({ id: i + 1, v: (i * 7) % 5 })),
      indexedColumns: ['id'],
    },
  },
});
const ids = (sql: string, n = 10) => {
  const r = runQuery(sql, db(n));
  if (r.error) throw new Error(r.error.message);
  return r.rows.map((x) => x.id);
};

describe('parsing', () => {
  it('reads LIMIT n OFFSET m, and the span covers both', () => {
    const out = parse('SELECT * FROM t LIMIT 5 OFFSET 10');
    expect(out.ok && out.ast.limit).toMatchObject({ value: 5, offset: 10 });
    expect(out.ok && out.ast.limit!.span).toEqual({ from: 16, to: 33 });
    expect(out.ok && out.ast.span.to).toBe(33);
  });

  it('OFFSET 0 is legal and means no skip', () => {
    expect(ids('SELECT id FROM t ORDER BY id LIMIT 3 OFFSET 0')).toEqual([1, 2, 3]);
  });

  it('is case-insensitive and tolerates a trailing semicolon', () => {
    expect(parse('select * from t limit 2 offset 1;').ok).toBe(true);
  });

  it('an OFFSET without a LIMIT is rejected with what to write instead', () => {
    const out = parse('SELECT * FROM t OFFSET 5');
    expect(out.ok).toBe(false);
    expect(!out.ok && out.error.message).toMatch(/OFFSET needs a LIMIT/);
    expect(!out.ok && out.error.hint).toMatch(/LIMIT n OFFSET m/);
  });

  it.each(['SELECT * FROM t LIMIT 5 OFFSET 1.5', 'SELECT * FROM t LIMIT 5 OFFSET', "SELECT * FROM t LIMIT 5 OFFSET 'x'", 'SELECT * FROM t LIMIT 5 OFFSET id'])(
    'needs a whole number after OFFSET: %s',
    (sql) => {
      const out = parse(sql);
      expect(out.ok).toBe(false);
      expect(!out.ok && out.error.message).toMatch(/whole number after OFFSET/);
    },
  );

  it('OFFSET cannot come before LIMIT', () => {
    expect(parse('SELECT * FROM t OFFSET 1 LIMIT 5').ok).toBe(false);
  });
});

describe('results', () => {
  it('skips m rows of the ordered result, then returns n', () => {
    expect(ids('SELECT id FROM t ORDER BY id LIMIT 3 OFFSET 4')).toEqual([5, 6, 7]);
    expect(ids('SELECT id FROM t ORDER BY id DESC LIMIT 3 OFFSET 2')).toEqual([8, 7, 6]);
  });

  it('an OFFSET past the end returns nothing; a short tail returns what is left', () => {
    expect(ids('SELECT id FROM t ORDER BY id LIMIT 5 OFFSET 99')).toEqual([]);
    expect(ids('SELECT id FROM t ORDER BY id LIMIT 5 OFFSET 8')).toEqual([9, 10]);
  });

  it('LIMIT 0 returns nothing whatever the OFFSET', () => {
    expect(ids('SELECT id FROM t LIMIT 0 OFFSET 3')).toEqual([]);
  });

  it('applies after WHERE, so the skipped rows are the matching ones', () => {
    expect(ids('SELECT id FROM t WHERE id > 4 ORDER BY id LIMIT 2 OFFSET 1')).toEqual([6, 7]);
  });

  it('pages tile the table with no gap and no overlap', () => {
    const pages = [0, 3, 6, 9].flatMap((offset) => ids(`SELECT id FROM t ORDER BY id LIMIT 3 OFFSET ${offset}`));
    expect(pages).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('works with an index lookup and with GROUP BY', () => {
    expect(ids('SELECT id FROM t WHERE id = 3 LIMIT 5 OFFSET 0')).toEqual([3]);
    expect(ids('SELECT id FROM t WHERE id = 3 LIMIT 5 OFFSET 1')).toEqual([]);
    const grouped = runQuery('SELECT v, COUNT(*) FROM t GROUP BY v LIMIT 2 OFFSET 1', db());
    expect(grouped.rows).toHaveLength(2);
  });
});

describe('the trace tells the truth about the cost', () => {
  it('narrates that the skipped rows were still produced — and reads as many rows as offset + limit needs', () => {
    const { events } = runQuery('SELECT id FROM t LIMIT 2 OFFSET 5', db());
    const labels = events.map((e) => e.label);
    expect(labels.some((l) => /discards the first 5 rows/.test(l) && /cost of OFFSET/.test(l))).toBe(true);
    const seq = events.filter((e) => e.stage === 'execute' && e.op === 'SeqScan');
    expect(seq).toHaveLength(7); // 5 thrown away + 2 returned; the other 3 are never pulled
  });

  it('a larger OFFSET reads more of the table for the same LIMIT', () => {
    const scanned = (offset: number) =>
      runQuery(`SELECT id FROM t LIMIT 2 OFFSET ${offset}`, db(40)).events.filter((e) => e.stage === 'buffer' && e.action === 'miss').length;
    expect(scanned(30)).toBeGreaterThan(scanned(0));
  });

  it('says when the OFFSET outruns the input', () => {
    const { events, rows } = runQuery('SELECT id FROM t LIMIT 2 OFFSET 50', db());
    expect(rows).toEqual([]);
    expect(events.some((e) => /input runs out/.test(e.label))).toBe(true);
  });

  it('shows OFFSET in the AST, the plan, and the narration', () => {
    const { events } = runQuery('SELECT id FROM t ORDER BY id LIMIT 3 OFFSET 4', db());
    const text = JSON.stringify(events);
    expect(text).toContain('3 OFFSET 4');
    expect(text).toContain('offset 4');
    expect(events.some((e) => /skip the first 4 rows, then cap the result at 3/.test(e.label))).toBe(true);
    expect(events.some((e) => /still produced by everything beneath/.test(e.label))).toBe(true);
  });

  it('the cost model subtracts the skipped rows before capping', () => {
    const { events } = runQuery('SELECT id FROM t LIMIT 5 OFFSET 8', db());
    const plan = events.find((e) => e.stage === 'plan' && JSON.stringify(e).includes('offset 8'));
    expect(JSON.stringify(plan)).toMatch(/min\(10 − 8 skipped, LIMIT 5\)/);
  });

  it('the optimizer keeps the OFFSET when it rewrites beneath the Limit', () => {
    const { events, rows } = runQuery('SELECT * FROM t WHERE id = 4 LIMIT 3 OFFSET 0', db());
    expect(rows).toHaveLength(1);
    const rewrite = events.find((e) => e.stage === 'optimize' && e.rule === 'index-selection');
    expect(rewrite).toBeDefined();
    const withOffset = runQuery('SELECT * FROM t WHERE id = 4 LIMIT 3 OFFSET 1', db());
    expect(withOffset.rows).toEqual([]);
    expect(JSON.stringify(withOffset.events.find((e) => e.stage === 'optimize' && e.rule === 'index-selection'))).toContain('offset 1');
  });
});
