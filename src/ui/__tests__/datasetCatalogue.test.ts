import { describe, expect, it } from 'vitest';
import { DATASETS, DATASET_IDS, runQuery } from '../../engine/index.ts';
import { DATASET_CATALOGUE } from '../datasetCatalogue.ts';

describe('dataset catalogue', () => {
  it('covers exactly the engine dataset ids', () => {
    expect(Object.keys(DATASET_CATALOGUE).sort()).toEqual([...DATASET_IDS].sort());
  });

  it.each([...DATASET_IDS])('every %s starter and preset query runs clean', (id) => {
    const db = DATASETS[id].make();
    const entry = DATASET_CATALOGUE[id];
    for (const sql of [entry.starterSql, ...entry.presets.map((p) => p.sql)]) {
      const result = runQuery(sql, db);
      expect(result.error, sql).toBeUndefined();
    }
  });

  it.each([...DATASET_IDS])('the %s starter query targets that dataset\'s table', (id) => {
    expect(DATASET_CATALOGUE[id].starterSql).toContain(`FROM ${DATASETS[id].table}`);
  });

  it('the logins presets show both ends of the skew', () => {
    const db = DATASETS.logins.make();
    const [selective, unselective] = DATASET_CATALOGUE.logins.presets;
    const few = runQuery(selective!.sql, db).rows.length;
    const many = runQuery(unselective!.sql, db).rows.length;
    expect(few).toBeGreaterThan(0);
    expect(many).toBeGreaterThan(few * 3);
  });

  it('the employees "Correlated AND" preset names a real q-error, at least 10× (plan.md §25.4 C2)', () => {
    const [correlated] = DATASET_CATALOGUE.employees.presets;
    const out = runQuery(correlated!.sql, DATASETS.employees.make()).rows.map((r) => r['QUERY PLAN'] as string);
    const scan = out.find((l) => l.includes('q-error'))!;
    expect(scan, out.join('\n')).toBeDefined();
    const q = Number(/q-error (\d+(?:\.\d+)?)×/.exec(scan)![1]);
    expect(q).toBeGreaterThanOrEqual(10);
  });

  it('the transactions "Range lookup" preset is a short, deep, indexed walk — not a full scan (plan.md §25.4 C6)', () => {
    const [, range] = DATASET_CATALOGUE.transactions.presets;
    const db = DATASETS.transactions.make();
    const result = runQuery(range!.sql, db);
    expect(result.events.length).toBeLessThan(300);
    expect(result.rows.length).toBeGreaterThan(1);
    const rangeStep = result.events.find((e) => e.stage === 'optimize' && e.rule === 'range-index-selection');
    expect(rangeStep?.label).toMatch(/single descent.*leaf chain/);
  });

  it('the transactions "Eviction storm" preset genuinely evicts, far beyond a point lookup', () => {
    const [point, , storm] = DATASET_CATALOGUE.transactions.presets;
    const db = DATASETS.transactions.make();
    const pointEvictions = runQuery(point!.sql, db).events.filter((e) => e.stage === 'buffer' && e.action === 'evict').length;
    const stormEvictions = runQuery(storm!.sql, db).events.filter((e) => e.stage === 'buffer' && e.action === 'evict').length;
    expect(stormEvictions).toBeGreaterThan(pointEvictions + 100);
  });
});
