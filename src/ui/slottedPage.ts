import type { Row } from '../engine/index.ts';

/**
 * plan.md §22.3 `/tools/page`: the byte-level layout of a slotted heap page,
 * synthesised for teaching. QueryLens's own `Page` is just a `Row[]` (§7 — "a
 * page you can see the contents of teaches more than a realistic one you
 * cannot"), so this does not read a real layout; it lays the rows out the way
 * Postgres/BusTub would — a header, a line-pointer (slot) array growing forward,
 * tuples packed from the far end backward, free space in between — so that
 * "rows per page" stops being an abstract number. Numbers are plausible and
 * self-consistent, not byte-exact to any engine; the disclaimer covers it.
 *
 * Pure and total, so it is unit-tested rather than eyeballed in the DOM.
 */

export interface FieldLayout {
  column: string;
  value: string;
  bytes: number;
}

export interface TupleLayout {
  /** Slot index; also this tuple's position in insertion order. */
  slot: number;
  /** Byte offset of the tuple's start within the page. */
  offset: number;
  /** Total tuple bytes — `headerBytes` plus every field. */
  length: number;
  headerBytes: number;
  fields: FieldLayout[];
}

export interface SlottedPage {
  pageBytes: number;
  headerBytes: number;
  /** Bytes per line pointer. */
  slotBytes: number;
  /** `tuples.length * slotBytes`. */
  slotArrayBytes: number;
  /** In slot order (0…n-1). */
  tuples: TupleLayout[];
  /** header + slot array + every tuple. */
  usedBytes: number;
  freeBytes: number;
  /** How many more average-sized rows the free space would hold. */
  moreRowsFit: number;
  /** The rows do not fit this page size at all. */
  overflow: boolean;
}

export interface SlottedPageOptions {
  pageBytes?: number;
  headerBytes?: number;
  slotBytes?: number;
  tupleHeaderBytes?: number;
}

const DEFAULTS = {
  pageBytes: 4096,
  headerBytes: 24,
  slotBytes: 4,
  tupleHeaderBytes: 8,
} as const;

/** A field's on-disk size: 4 for a number, 1 for null/bool, `bytes + 1` for
 *  text (a one-byte length prefix, like a short varlena). */
function fieldBytes(value: Row[string] | undefined): number {
  if (value === null || value === undefined) return 1;
  if (typeof value === 'number') return 4;
  if (typeof value === 'boolean') return 1;
  return new TextEncoder().encode(value).length + 1;
}

export function layOutPage(
  rows: readonly Row[],
  columns: readonly string[],
  opts: SlottedPageOptions = {},
): SlottedPage {
  const pageBytes = opts.pageBytes ?? DEFAULTS.pageBytes;
  const headerBytes = opts.headerBytes ?? DEFAULTS.headerBytes;
  const slotBytes = opts.slotBytes ?? DEFAULTS.slotBytes;
  const tupleHeaderBytes = opts.tupleHeaderBytes ?? DEFAULTS.tupleHeaderBytes;

  // Tuples pack from the high end downward; slot i addresses tuple i.
  let cursor = pageBytes;
  const tuples: TupleLayout[] = rows.map((row, i) => {
    const fields: FieldLayout[] = columns.map((column) => ({
      column,
      value: row[column] === null || row[column] === undefined ? 'NULL' : String(row[column]),
      bytes: fieldBytes(row[column]),
    }));
    const length = tupleHeaderBytes + fields.reduce((n, f) => n + f.bytes, 0);
    cursor -= length;
    return { slot: i, offset: cursor, length, headerBytes: tupleHeaderBytes, fields };
  });

  const slotArrayBytes = rows.length * slotBytes;
  const tupleTotal = tuples.reduce((n, t) => n + t.length, 0);
  const usedBytes = headerBytes + slotArrayBytes + tupleTotal;
  const freeBytes = pageBytes - usedBytes;
  const avgTuple = rows.length === 0 ? 0 : tupleTotal / rows.length;

  return {
    pageBytes,
    headerBytes,
    slotBytes,
    slotArrayBytes,
    tuples,
    usedBytes,
    freeBytes: Math.max(freeBytes, 0),
    moreRowsFit:
      avgTuple === 0 || freeBytes <= 0 ? 0 : Math.floor(freeBytes / (avgTuple + slotBytes)),
    overflow: freeBytes < 0,
  };
}
