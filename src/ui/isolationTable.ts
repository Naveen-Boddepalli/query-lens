/**
 * The isolation matrix as rows (plan.md §H6): one row for each cell, anomaly by anomaly, with what the published
 * results say beside it and whether the two agree. Kept apart from the schedule rows so that the schedule tool, which
 * has no use for the Hermitage suite, does not carry it.
 */

import {
  DOCUMENTED,
  HERMITAGE_LEVELS,
  HERMITAGE_LEVEL_LABELS,
  HERMITAGE_TESTS,
  KNOWN_DIFFERENCES,
} from '../engine/hermitage.ts';
import type { EngineKind, MatrixCell } from '../engine/hermitage.ts';
import type { TableColumn } from './DataView.tsx';

export interface MatrixRow {
  anomaly: string;
  level: string;
  engine: string;
  happens: string;
  published: string;
  agrees: string;
}

const ENGINE_TITLE: Record<EngineKind, string> = {
  locks: 'Two-phase locking',
  mvcc: 'Versions and snapshots',
  innodb: 'InnoDB (MySQL)',
};

/**
 * Every cell of every matrix, anomaly by anomaly, with what the published results say and whether they agree. A cell
 * nothing was published for says so, and is not held against the engine.
 */
export function matrixRows(matrices: Record<EngineKind, readonly MatrixCell[]>): MatrixRow[] {
  const rows: MatrixRow[] = [];
  for (const test of HERMITAGE_TESTS) {
    for (const engine of ['locks', 'mvcc', 'innodb'] as const) {
      for (const level of HERMITAGE_LEVELS) {
        const cell = matrices[engine].find((c) => c.test === test.id && c.level === level)!;
        const documented = DOCUMENTED[engine][level][test.id];
        const known = KNOWN_DIFFERENCES.find((d) => d.engine === engine && d.level === level && d.test === test.id);
        rows.push({
          anomaly: `${test.id} ${test.name}`,
          level: HERMITAGE_LEVEL_LABELS[level],
          engine: ENGINE_TITLE[engine],
          happens: cell.occurred ? 'happens' : 'prevented',
          published: documented === null ? 'not published' : documented ? 'can occur' : 'prevented',
          agrees:
            documented === null
              ? 'not published'
              : cell.occurred === documented
                ? 'yes'
                : known
                  ? `no — ${known.why}`
                  : 'no',
        });
      }
    }
  }
  return rows;
}

export const MATRIX_COLUMNS: readonly TableColumn<MatrixRow>[] = [
  { header: 'Anomaly', cell: (r) => r.anomaly },
  { header: 'Isolation level', cell: (r) => r.level },
  { header: 'Engine', cell: (r) => r.engine },
  { header: 'In this run', cell: (r) => r.happens },
  { header: 'Published', cell: (r) => r.published },
  { header: 'Agrees', cell: (r) => r.agrees },
];
