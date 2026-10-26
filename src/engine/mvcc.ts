/**
 * Multi-version concurrency control (plan.md §25.4 D4): a row is not one value but a chain of versions, each stamped
 * with the transaction that made it (`xmin`) and the one that deleted or replaced it (`xmax`). A reader never takes a
 * lock and never waits: it picks, for every row, the version its *snapshot* can see.
 *
 * This is the version store and the visibility rule, nothing else; `schedule.ts` decides when a snapshot is taken and
 * what to do with a write. Pure functions over plain arrays, so a schedule is still a value.
 *
 * The rule is PostgreSQL's, in its simplest form. A version is visible to a snapshot when the transaction that
 * created it was committed when the snapshot was taken (or is the reader itself), and the transaction that removed it
 * was not — or the reader itself did not remove it.
 *
 * One addition, for writers that go on top of a row they cannot see the newest version of (InnoDB's current read,
 * `LockingOptions.currentWrites`): a reader that has written a row sees *its own* version of that row and no other,
 * because the version it replaced may still look visible to its snapshot, and the row would otherwise appear twice.
 * Where a writer is refused when the row has changed — the default — this changes nothing.
 */

import type { Database, Row } from './types.ts';

export interface Version {
  /** The logical row this is a version of; every version of one row shares it, and so does its lock. */
  rid: number;
  table: string;
  row: Row;
  /** The transaction that created it. 0 is the data the schedule began with, committed before anyone started. */
  xmin: number;
  /** The transaction that deleted or replaced it, or null while it is the newest version. */
  xmax: number | null;
  /** Where the row sits in its table. Stable across versions, so an update does not reorder the table. */
  order: number;
}

/** Whether `version` is visible to a reader whose snapshot holds `committed`, running as transaction `self`. */
export function isVisible(version: Version, committed: ReadonlySet<number>, self: number): boolean {
  const created = version.xmin === self || committed.has(version.xmin);
  if (!created) return false;
  if (version.xmax === null) return true;
  const removed = version.xmax === self || committed.has(version.xmax);
  return !removed;
}

/** The database a reader sees: each table's rows are the versions visible to it, in table order. */
export function viewOf(
  template: Database,
  versions: readonly Version[],
  committed: ReadonlySet<number>,
  self: number,
): Database {
  const tables: Database['tables'] = {};
  // The rows the reader has itself written: for those, what it wrote is the row.
  const written = new Set<number>();
  for (const v of versions) if (v.xmin === self || v.xmax === self) written.add(v.rid);
  for (const [name, table] of Object.entries(template.tables)) {
    const rows = versions
      .filter((v) => {
        if (v.table !== name) return false;
        if (!written.has(v.rid)) return isVisible(v, committed, self);
        return v.xmin === self && (v.xmax === null || (v.xmax !== self && !committed.has(v.xmax)));
      })
      .sort((a, b) => a.order - b.order)
      .map((v) => v.row);
    tables[name] = { ...table, rows };
  }
  return { tables };
}

/**
 * A version no snapshot can see again, so vacuum may reclaim it: its creator aborted, or what removed it committed
 * and every transaction still open already counts that removal as done.
 */
export function isDead(
  version: Version,
  committed: ReadonlySet<number>,
  aborted: ReadonlySet<number>,
  openSnapshots: readonly ReadonlySet<number>[],
): boolean {
  if (aborted.has(version.xmin)) return true;
  if (version.xmax === null || !committed.has(version.xmax)) return false;
  return openSnapshots.every((snapshot) => snapshot.has(version.xmax!));
}

/**
 * The visibility rule said as steps, for a reader to check an answer against: whether the version's creator counts as
 * committed for this snapshot, whether its remover does, and so whether the reader sees it.
 */
export function explainVisibility(
  version: Version,
  committed: ReadonlySet<number>,
  self: number,
): { visible: boolean; created: string; removed: string } {
  let created: string;
  if (version.xmin === 0) created = 'It is part of the data the schedule began with, committed before anyone started, so it exists.';
  else if (version.xmin === self) created = `Transaction ${String(version.xmin)} made it and this reader is that transaction, so it exists for it.`;
  else if (committed.has(version.xmin)) {
    created = `Transaction ${String(version.xmin)} made it and had committed when the snapshot was taken, so it exists.`;
  } else {
    created = `Transaction ${String(version.xmin)} made it, and it had not committed when the snapshot was taken, so it does not exist for this reader yet.`;
  }

  let removed: string;
  if (version.xmax === null) removed = 'Nobody has deleted or replaced it.';
  else if (version.xmax === self) removed = `Transaction ${String(version.xmax)} removed it and this reader is that transaction, so it is gone for it.`;
  else if (committed.has(version.xmax)) {
    removed = `Transaction ${String(version.xmax)} deleted or replaced it and had committed when the snapshot was taken, so it is gone.`;
  } else {
    removed = `Transaction ${String(version.xmax)} deleted or replaced it, but had not committed when the snapshot was taken, so as far as this reader is concerned it is still there.`;
  }

  return { visible: isVisible(version, committed, self), created, removed };
}
