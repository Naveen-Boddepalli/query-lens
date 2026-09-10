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
});
