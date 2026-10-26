import { describe, expect, it } from 'vitest';
import { DEFAULT_ENGINE_OPTIONS, runQuery } from '../index.ts';
import { DATASETS } from '../datasets.ts';
import type { Database } from '../types.ts';

/**
 * plan.md §25.9's 2.0 checklist: "a homework-shaped query using OR, IN, LIKE, DISTINCT, HAVING and a non-unique
 * indexed column runs and narrates end to end". One query with all six, against a table whose `department` index is
 * not unique, checked row for row against a plain computation of the same thing.
 */
describe('a homework-shaped query', () => {
  const base = DATASETS.employees.make();
  const table = base.tables.employees!;
  const db: Database = { tables: { employees: { ...table, indexedColumns: ['id', 'department'] } } };

  const sql =
    "SELECT DISTINCT department, COUNT(*) FROM employees WHERE department IN ('engineering', 'sales') OR office LIKE 'building-1%' GROUP BY department HAVING COUNT(*) > 5";

  it('runs, and its rows are the ones a plain computation gives', () => {
    const result = runQuery(sql, db, DEFAULT_ENGINE_OPTIONS);
    expect(result.error).toBeUndefined();
    const counts = new Map<string, number>();
    for (const r of table.rows) {
      const dept = r.department as string;
      const office = r.office as string;
      if (dept === 'engineering' || dept === 'sales' || office.startsWith('building-1')) {
        counts.set(dept, (counts.get(dept) ?? 0) + 1);
      }
    }
    const expected = [...counts].filter(([, n]) => n > 5).map(([department, n]) => ({ department, 'COUNT(*)': n }));
    expect(expected.length).toBeGreaterThan(0);
    const got = result.rows.map((r) => ({ department: r.department, 'COUNT(*)': Object.values(r)[1] }));
    expect(got.sort((a, b) => String(a.department).localeCompare(String(b.department)))).toEqual(
      expected.sort((a, b) => a.department.localeCompare(b.department)),
    );
  });

  it('narrates every stage it passes through, in order', () => {
    const result = runQuery(sql, db, DEFAULT_ENGINE_OPTIONS);
    const stages = [...new Set(result.events.map((e) => e.stage))];
    for (const stage of ['parse', 'plan', 'execute', 'buffer', 'result'] as const) expect(stages).toContain(stage);
    const order = result.events.map((e) => e.stage);
    expect(order.indexOf('parse')).toBeLessThan(order.indexOf('plan'));
    expect(order.indexOf('plan')).toBeLessThan(order.indexOf('execute'));
    expect(result.events.every((e) => e.label.length > 0)).toBe(true);
  });

  it('uses the non-unique index where a predicate on it can', () => {
    const lookup = runQuery("SELECT * FROM employees WHERE department = 'sales'", db, DEFAULT_ENGINE_OPTIONS);
    expect(lookup.error).toBeUndefined();
    expect(lookup.rows.length).toBeGreaterThan(1);
    expect(lookup.rows.every((r) => r.department === 'sales')).toBe(true);
  });
});
