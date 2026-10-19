import { describe, expect, it } from 'vitest';
import { DATASETS, runQuery } from '../../../engine/index.ts';
import { LESSONS, lessonById, stepLink } from '../lessons.tsx';

/**
 * The lesson prose is mostly not tested — it is copy (the NULL lesson's numbers are, below). What is tested is the same
 * thing `GalleryPage`'s test pins: every deep link a lesson hands out is
 * computed from a real engine run, so if a stage moves, this fails here
 * rather than shipping a link to the wrong step.
 */
describe('learn lessons', () => {
  it('has unique ids and at least one step each', () => {
    const ids = LESSONS.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const lesson of LESSONS) expect(lesson.steps.length).toBeGreaterThan(0);
  });

  it('lessonById round-trips and rejects the unknown', () => {
    for (const lesson of LESSONS) expect(lessonById(lesson.id)).toBe(lesson);
    expect(lessonById('nope')).toBeUndefined();
    expect(lessonById(undefined)).toBeUndefined();
  });

  it('every step link resolves to a real Playground step', () => {
    for (const lesson of LESSONS) {
      for (const [i, step] of lesson.steps.entries()) {
        if (!step.open) continue;
        const { href, label } = stepLink(step.open);
        expect(label.length, `${lesson.id} step ${String(i)}`).toBeGreaterThan(0);
        const url = new URL(href, 'https://x');
        expect(url.pathname).toBe('/playground');
        const step_ = Number(url.searchParams.get('s'));
        expect(Number.isInteger(step_) && step_ >= 1, `${lesson.id} step ${String(i)} → ${href}`).toBe(
          true,
        );
        expect(url.searchParams.get('q')).toBeTruthy();
      }
    }
  });

  it('at least one lesson opens a step with prediction on', () => {
    const any = LESSONS.some((l) => l.steps.some((s) => s.open?.predictOn));
    expect(any).toBe(true);
  });

  it('every fixed step link is an in-app path', () => {
    for (const lesson of LESSONS) {
      for (const step of lesson.steps) {
        if (!step.link) continue;
        expect(step.link.label.length).toBeGreaterThan(0);
        expect(step.link.href.startsWith('/'), `${lesson.id}: ${step.link.href}`).toBe(true);
      }
    }
  });
});

describe('lesson: NOT EXISTS is not NOT IN (plan.md §27.5 S1, on S2’s shop preset)', () => {
  const steps = lessonById('not-exists')!.steps;
  const shop = () => DATASETS.shop.make();
  const opened = (i: number) => {
    const url = new URL(stepLink(steps[i]!.open!).href, 'https://x');
    expect(url.searchParams.get('t'), `step ${String(i + 1)}`).toBe('shop');
    return { sql: url.searchParams.get('q')!, step: Number(url.searchParams.get('s')) };
  };
  const names = (sql: string) => runQuery(sql, shop()).rows.map((r) => String(r['name'] ?? r['customers.name']));

  it('a JOIN repeats alice seven times; EXISTS — and a DISTINCT JOIN — return the nine who ordered, once each', () => {
    const join = names('SELECT customers.name FROM customers JOIN orders ON customers.id = orders.customerId');
    expect(join.filter((n) => n === 'alice')).toHaveLength(7);
    const exists = names(opened(0).sql);
    expect(exists).toHaveLength(9);
    expect(new Set(exists).size).toBe(9);
    expect(names('SELECT DISTINCT customers.name FROM customers JOIN orders ON customers.id = orders.customerId').sort()).toEqual([...exists].sort());
  });

  it('the first step lands on the semi-join being planned, the second on the algorithm chosen: about 123 pages against 13', () => {
    const first = opened(0);
    const events = runQuery(first.sql, shop()).events;
    expect(events[first.step - 1]?.label).toMatch(/semi-join \(⋉\)/);
    const second = opened(1);
    const chosen = runQuery(second.sql, shop()).events[second.step - 1];
    expect(chosen?.stage === 'optimize' && chosen.rule).toBe('join-algorithm-selection');
    expect(chosen?.label).toMatch(/hash join chosen by cost — an estimated 13 pages against nested-loop's 123/);
  });

  it('NOT EXISTS finds dmitri, ines and lars; NOT IN finds no one, because of two guest orders; without them, the three', () => {
    expect(names(opened(2).sql).sort()).toEqual(['dmitri', 'ines', 'lars']);
    expect(names(opened(3).sql)).toEqual([]);
    expect(shop().tables.orders!.rows.filter((r) => r['customerId'] === null)).toHaveLength(2);
    expect(names('SELECT name FROM customers WHERE id NOT IN (SELECT customerId FROM orders WHERE customerId IS NOT NULL)').sort()).toEqual(['dmitri', 'ines', 'lars']);
  });
});

describe('lesson: UNION, INTERSECT, EXCEPT (plan.md §27.5 S3, on shop)', () => {
  const steps = lessonById('set-operations')!.steps;
  const opened = (i: number) => {
    const url = new URL(stepLink(steps[i]!.open!).href, 'https://x');
    expect(url.searchParams.get('t'), `step ${String(i + 1)}`).toBe('shop');
    return { sql: url.searchParams.get('q')!, step: Number(url.searchParams.get('s')) };
  };
  const rows = (sql: string) => runQuery(sql, DATASETS.shop.make()).rows;
  const ids = (sql: string) => rows(sql).map((r) => Object.values(r)[0] ?? null);

  it('UNION ALL returns fifty-two rows, named after the first SELECT', () => {
    const all = rows(opened(0).sql);
    expect(all).toHaveLength(52);
    expect(Object.keys(all[0]!)).toEqual(['customerId']);
  });

  it('UNION lands on its HashDistinct being planned, and returns thirteen: twelve ids and one NULL', () => {
    const { sql, step } = opened(1);
    expect(runQuery(sql, DATASETS.shop.make()).events[step - 1]?.label).toMatch(/HashDistinct above it/);
    const union = ids(sql);
    expect(union).toHaveLength(13);
    expect(union.filter((v) => v === null)).toHaveLength(1);
  });

  it('INTERSECT finds the nine who ordered; EXCEPT the three who did not, NULL or no NULL; swapped, the NULL', () => {
    expect(ids(opened(2).sql)).toHaveLength(9);
    expect(ids(opened(3).sql).sort()).toEqual([12, 4, 9].sort());
    expect(ids('SELECT customerId FROM orders EXCEPT SELECT id FROM customers')).toEqual([null]);
  });
});

describe('lesson: RIGHT, FULL and CROSS JOIN (plan.md §27.5 S4, on shop)', () => {
  const steps = lessonById('outer-joins')!.steps;
  const opened = (i: number) => {
    const url = new URL(stepLink(steps[i]!.open!).href, 'https://x');
    expect(url.searchParams.get('t'), `step ${String(i + 1)}`).toBe('shop');
    return { sql: url.searchParams.get('q')!, step: Number(url.searchParams.get('s')) };
  };
  const run = (sql: string) => runQuery(sql, DATASETS.shop.make());
  const names = (rows: readonly Record<string, unknown>[], key: string) => rows.map((r) => r[key]);

  it('the inner join returns thirty-eight rows, without dmitri, ines, lars or orders 17 and 33', () => {
    const { rows } = run(opened(0).sql);
    expect(rows).toHaveLength(38);
    for (const name of ['dmitri', 'ines', 'lars']) expect(names(rows, 'customers.name')).not.toContain(name);
    expect(names(rows, 'orders.id')).not.toContain(17);
    expect(names(rows, 'orders.id')).not.toContain(33);
  });

  it('RIGHT lands on the unmatched orders coming out, keeps all forty, and is the LEFT JOIN the other way round', () => {
    const { sql, step } = opened(1);
    const r = run(sql);
    expect(r.events[step - 1]?.label).toMatch(/2 rows of orders matched nothing, and come out next/);
    expect(r.rows).toHaveLength(40);
    expect(r.rows.filter((row) => row['customers.name'] === null).map((row) => row['orders.id']).sort()).toEqual([17, 33]);
    expect(run('SELECT customers.name, orders.id FROM orders LEFT JOIN customers ON orders.customerId = customers.id').rows).toHaveLength(40);
  });

  it('FULL returns forty-three, and its try-this WHERE the five nothing matched', () => {
    const { sql } = opened(2);
    expect(run(sql).rows).toHaveLength(43);
    expect(run(`${sql.replace(/;$/, '')} WHERE customers.id IS NULL OR orders.id IS NULL`).rows).toHaveLength(5);
  });

  it('CROSS JOIN returns twelve times eight, as a nested loop', () => {
    const r = run(opened(3).sql);
    expect(r.rows).toHaveLength(96);
    expect(r.events.some((e) => e.stage === 'execute' && /a cross join keeps every pair/.test(e.label))).toBe(true);
  });

  it('the comma form lands on product-to-join, which a > does not trigger, and finds the inner join’s rows', () => {
    const { sql, step } = opened(4);
    const r = run(sql);
    expect(r.events[step - 1]).toMatchObject({ stage: 'optimize', rule: 'product-to-join' });
    expect(r.rows).toHaveLength(38);
    expect(12 * 40 - 38).toBe(442);
    const greater = run(sql.replace('=', '>'));
    expect(greater.events.some((e) => e.stage === 'optimize' && e.rule === 'product-to-join')).toBe(false);
  });
});

describe('lesson: NULL is not a value (plan.md §26 Feature 3)', () => {
  // Each step opens on the `customers` preset, and its prose quotes numbers — held here against the engine itself.
  const steps = lessonById('nulls')!.steps;
  const answer = (i: number) => {
    const url = new URL(stepLink(steps[i]!.open!).href, 'https://x');
    expect(url.searchParams.get('t'), `step ${String(i + 1)}`).toBe('customers');
    return runQuery(url.searchParams.get('q')!, DATASETS.customers.make()).rows;
  };

  it('= NULL finds no one, and <> Paris finds eleven of the sixteen who are not in Paris', () => {
    expect(answer(0)).toEqual([]);
    expect(answer(1)).toHaveLength(11);
    expect(runQuery("SELECT * FROM customers WHERE city = 'Paris'", DATASETS.customers.make()).rows).toHaveLength(4);
  });

  it('COUNT(*) is twenty, COUNT(discount) thirteen — the 0 among them — and AVG divides by thirteen', () => {
    const [row] = answer(2);
    const discounts = DATASETS.customers.make().tables.customers!.rows.flatMap((r) => (r['discount'] === null ? [] : [r['discount'] as number]));
    expect(discounts).toContain(0);
    expect(row).toEqual({ 'COUNT(*)': 20, 'COUNT(discount)': 13, 'AVG(discount)': discounts.reduce((a, b) => a + b, 0) / 13 });
  });

  it('NOT IN meets the NULL among the referrers and returns no one; without it, the eleven', () => {
    expect(answer(3)).toEqual([]);
    const fixed = runQuery(
      'SELECT name FROM customers WHERE id NOT IN (SELECT referrer FROM customers WHERE referrer IS NOT NULL)',
      DATASETS.customers.make(),
    ).rows;
    expect(fixed).toHaveLength(11);
  });

  it('GROUP BY puts the five with no city in one group, and ORDER BY puts it last', () => {
    const groups = answer(4);
    expect(groups.at(-1)).toEqual({ city: null, 'COUNT(*)': 5 });
    expect(groups.filter((g) => g['city'] === null)).toHaveLength(1);
  });
});
