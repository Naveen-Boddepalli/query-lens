import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { explainVisibility, isDead, isVisible, viewOf } from '../mvcc.ts';
import type { Version } from '../mvcc.ts';
import type { Database, Row } from '../types.ts';

/** plan.md §25.4 D4: the visibility rule, on its own. */

const version = (xmin: number, xmax: number | null, row: Row = { id: 1 }, order = 1): Version => ({
  rid: 1,
  table: 't',
  row,
  xmin,
  xmax,
  order,
});

describe('the visibility rule', () => {
  const committed = new Set([0, 1, 2]);

  it('sees a version its creator committed and nobody removed', () => {
    expect(isVisible(version(1, null), committed, 9)).toBe(true);
  });

  it('does not see a version whose creator had not committed when the snapshot was taken', () => {
    expect(isVisible(version(5, null), committed, 9)).toBe(false);
  });

  it('sees a version it made itself, though nobody has committed it', () => {
    expect(isVisible(version(9, null), committed, 9)).toBe(true);
  });

  it('stops seeing a version once a committed transaction, or the reader itself, has removed it', () => {
    expect(isVisible(version(0, 2), committed, 9)).toBe(false);
    expect(isVisible(version(0, 9), committed, 9)).toBe(false);
  });

  it('still sees a version that a transaction outside the snapshot has removed', () => {
    expect(isVisible(version(0, 5), committed, 9)).toBe(true);
  });

  it('is explained in step with the rule, whatever the transactions', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 4 }),
        fc.option(fc.integer({ min: 1, max: 4 }), { nil: null }),
        fc.uniqueArray(fc.integer({ min: 0, max: 4 }), { maxLength: 5 }),
        fc.integer({ min: -1, max: 4 }),
        (xmin, xmax, snapshot, self) => {
          const v = version(xmin, xmax);
          const set = new Set(snapshot);
          const explained = explainVisibility(v, set, self);
          expect(explained.visible).toBe(isVisible(v, set, self));
          // Both halves of the explanation always say something, and name the transactions involved.
          expect(explained.created.length).toBeGreaterThan(0);
          if (xmax !== null) expect(explained.removed).toContain(`Transaction ${String(xmax)}`);
        },
      ),
    );
  });
});

describe('a reader’s view of the table', () => {
  const template: Database = { tables: { t: { name: 't', columns: ['id', 'v'], rows: [], indexedColumns: ['id'] } } };
  const a: Row = { id: 1, v: 'old' };
  const a2: Row = { id: 1, v: 'new' };
  const b: Row = { id: 2, v: 'b' };
  const versions: Version[] = [
    { rid: 1, table: 't', row: a, xmin: 0, xmax: 3, order: 1 },
    { rid: 1, table: 't', row: a2, xmin: 3, xmax: null, order: 1 },
    { rid: 2, table: 't', row: b, xmin: 0, xmax: null, order: 2 },
  ];

  it('picks one version per row, in table order, keeping the table’s own definition', () => {
    const before = viewOf(template, versions, new Set([0]), -1);
    expect(before.tables.t!.rows).toEqual([a, b]);
    expect(before.tables.t!.indexedColumns).toEqual(['id']);
    const after = viewOf(template, versions, new Set([0, 3]), -1);
    expect(after.tables.t!.rows).toEqual([a2, b]);
  });

  it('hands out the very row objects the store holds, so a change can be traced back to its version', () => {
    const view = viewOf(template, versions, new Set([0, 3]), -1);
    expect(view.tables.t!.rows[0]).toBe(a2);
  });
});

describe('which versions are dead', () => {
  it('counts a version an aborted transaction made, and one a committed transaction removed that every open snapshot saw', () => {
    const committed = new Set([0, 1]);
    expect(isDead(version(7, null), committed, new Set([7]), [])).toBe(true);
    expect(isDead(version(0, 1), committed, new Set(), [new Set([0, 1])])).toBe(true);
  });

  it('keeps one an open snapshot taken before the removal can still see', () => {
    expect(isDead(version(0, 1), new Set([0, 1]), new Set(), [new Set([0])])).toBe(false);
  });

  it('keeps the newest version, and one whose remover has not committed', () => {
    expect(isDead(version(0, null), new Set([0]), new Set(), [])).toBe(false);
    expect(isDead(version(0, 5), new Set([0]), new Set(), [])).toBe(false);
  });
});
