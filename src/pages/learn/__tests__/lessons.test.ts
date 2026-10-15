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
