import type { DatasetId } from '../engine/index.ts';

/**
 * plan.md §22.7 — the presentation half of the preset dataset library. The
 * `Database` builders are pure and live in `src/engine/datasets.ts`; the label,
 * one-line blurb, opening query and preset *query* chips (§19.2) for each are
 * here, keyed by the same id.
 */

export interface DatasetCatalogueEntry {
  label: string;
  blurb: string;
  starterSql: string;
  presets: { label: string; sql: string }[];
}

export const DATASET_CATALOGUE: Record<DatasetId, DatasetCatalogueEntry> = {
  users: {
    label: 'users',
    blurb: '48 rows, indexed on id — the baseline: a 12-page scan against 8 buffer frames.',
    starterSql: 'SELECT *\nFROM users\nWHERE id = 5;',
    presets: [
      { label: 'Point lookup', sql: 'SELECT *\nFROM users\nWHERE id = 5;' },
      { label: 'Sequential scan', sql: 'SELECT *\nFROM users\nWHERE age > 30;' },
      { label: 'Lookup, no index', sql: "SELECT *\nFROM users\nWHERE name = 'grace';" },
      // plan.md §25.4 B6: the plan, and what actually ran, as a result you can read — estimate beside actual.
      { label: 'EXPLAIN ANALYZE', sql: 'EXPLAIN ANALYZE\nSELECT *\nFROM users\nWHERE age > 30;' },
    ],
  },
  orders: {
    label: 'orders',
    blurb: '120 rows, indexed on id — a deeper B+Tree and a scan that evicts far harder.',
    starterSql: 'SELECT *\nFROM orders\nWHERE id = 42;',
    presets: [
      { label: 'Deep lookup', sql: 'SELECT *\nFROM orders\nWHERE id = 42;' },
      { label: 'Eviction storm', sql: 'SELECT *\nFROM orders\nWHERE total > 500;' },
      { label: 'Scan by customer', sql: "SELECT *\nFROM orders\nWHERE customer = 'acme';" },
    ],
  },
  logins: {
    label: 'logins',
    blurb: '80 rows with an 8:1 skew on status — the same = predicate, wildly different result size.',
    starterSql: "SELECT *\nFROM logins\nWHERE status = 'blocked';",
    presets: [
      { label: 'Selective scan', sql: "SELECT *\nFROM logins\nWHERE status = 'blocked';" },
      { label: 'Unselective scan', sql: "SELECT *\nFROM logins\nWHERE status = 'ok';" },
      { label: 'Point lookup', sql: 'SELECT *\nFROM logins\nWHERE id = 20;' },
    ],
  },
  employees: {
    label: 'employees',
    blurb: '200 rows — department and office are perfectly correlated, so an AND of both badly underestimates.',
    starterSql: "EXPLAIN ANALYZE\nSELECT *\nFROM employees\nWHERE department = 'engineering' AND office = 'building-1';",
    presets: [
      {
        label: 'Correlated AND',
        sql: "EXPLAIN ANALYZE\nSELECT *\nFROM employees\nWHERE department = 'engineering' AND office = 'building-1';",
      },
      { label: 'Department alone', sql: "SELECT *\nFROM employees\nWHERE department = 'engineering';" },
      { label: 'Point lookup', sql: 'SELECT *\nFROM employees\nWHERE id = 42;' },
    ],
  },
  transactions: {
    label: 'transactions',
    blurb: '3,000 rows, indexed on id — a genuinely deep B+Tree and a scan that evicts hard, not just a little.',
    starterSql: 'SELECT *\nFROM transactions\nWHERE id = 1500;',
    presets: [
      { label: 'Deep lookup', sql: 'SELECT *\nFROM transactions\nWHERE id = 1500;' },
      { label: 'Range lookup', sql: 'SELECT *\nFROM transactions\nWHERE id BETWEEN 1500 AND 1520;' },
      { label: 'Eviction storm', sql: 'SELECT *\nFROM transactions\nWHERE amount > 4500;' },
      {
        label: 'EXPLAIN ANALYZE',
        sql: 'EXPLAIN ANALYZE\nSELECT *\nFROM transactions\nWHERE amount > 4500;',
      },
    ],
  },
};
