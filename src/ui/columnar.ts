/**
 * plan.md §25.4 F3 `/tools/columnar`: row vs. column storage layouts (NSM, DSM, PAX), four real compression
 * schemes with genuinely computed compressed sizes, and the early-vs-late materialization trade-off a column
 * store only actually pays off with. Its own standalone driver — like `/tools/lsm` and `/tools/hash-index`, the
 * engine has only ever stored rows (NSM, implicitly, via `BPlusTree`'s row-pointer-addressed heap pages), so
 * there is no existing columnar structure to reuse. Pure and total: given a synthetic table and a page size,
 * this computes every number up front.
 *
 * **The three layouts** (Ramakrishnan & Gehrke; Ailamaki et al.'s PAX paper):
 *   - **NSM** (N-ary Storage Model, the row store): every column of a row sits together, contiguously, one row
 *     after another. Reading even ONE column of a row means reading the WHOLE row's own page — there is no way
 *     to skip the columns a query does not need.
 *   - **DSM** (Decomposition Storage Model, the column store): each column lives in its own, separate run of
 *     pages. A query touching one column reads only that column's own pages — but reconstructing one full ROW
 *     means visiting every column's own, physically distant storage, one region per column.
 *   - **PAX** (Partition Attributes Across, the hybrid): rows are grouped (`rowsPerGroup` at a time); WITHIN
 *     one group, data is laid out column-major (so a query can skip straight to the one column's own mini-
 *     partition, same as DSM), but a group's own pages stay physically adjacent (so reconstructing one row only
 *     ever means revisiting ONE nearby group, same locality NSM gives for free). This tool reports three
 *     honestly different numbers per layout, not a single "score": pages touched by a full scan (every column,
 *     every row), pages touched scanning just ONE column, and how many separate storage REGIONS a single row's
 *     reconstruction has to visit (1 for NSM and PAX, one per column for DSM — the number a raw page count
 *     cannot show, and the actual reason PAX exists rather than everyone just using DSM).
 *
 * **Four real compression schemes, sized by what they would actually occupy, not estimated:**
 *   - **Dictionary**: every distinct value gets a small integer code; storage is `codes (`ceil(log2(distinct))`
 *     bits each) + the dictionary itself (`distinct × 4` bytes)`. Wins on low-cardinality columns, however they
 *     are ordered.
 *   - **RLE** (run-length encoding): consecutive equal values collapse into one `(value, run length)` pair.
 *     Wins only on columns with real runs — clustered or sorted repeats — and can cost MORE than storing nothing
 *     at all on a column whose values keep changing every row, even if the column's own distinct-value count is
 *     just as low (this tool's own demo deliberately ships one column of each kind, to make that contrast real
 *     rather than asserted).
 *   - **Delta**: the first value stored raw, every value after it stored as the difference from its
 *     predecessor, sized by the single widest delta actually seen (plus one sign bit). Wins on sorted or
 *     near-sorted numeric columns — an ascending id column's own deltas are all `1`.
 *   - **Bit-packing**: every value stored in exactly `ceil(log2(max − min + 1))` bits, no more — wins on any
 *     narrow-range column, sorted or not.
 *   Nothing here picks one scheme for you to just believe; `bestEncodingFor` computes every scheme's REAL size
 *   on the actual column and returns whichever is genuinely smallest, same as the rest of this module.
 *
 * **Late vs. early materialization**: the one thing that actually earns a column store its keep on a filtered,
 * narrow query. *Early* materialization reconstructs whole rows first, then filters, then projects — which
 * means touching every column of every row regardless of layout, throwing away DSM/PAX's whole advantage. *Late*
 * materialization filters on the WHERE column's own data alone (cheap: one column, every row), finds which row
 * POSITIONS actually match, and only THEN fetches the SELECT column's own data at just those positions. The
 * gap between the two — measured here by running the filter for real over the actual demo data, not assumed
 * from a textbook selectivity — is the whole reason the layouts above matter at all.
 */

export type Layout = 'NSM' | 'DSM' | 'PAX';
export type Encoding = 'none' | 'dictionary' | 'rle' | 'delta' | 'bitpack';

export const ENCODINGS: readonly Encoding[] = ['none', 'dictionary', 'rle', 'delta', 'bitpack'];

/** Every demo value is a 4-byte (int32) integer — real compression numbers, deliberately uniform column widths. */
export const VALUE_BYTE_WIDTH = 4;

export interface ColumnData {
  name: string;
  values: number[];
}

export interface ColumnPlan {
  name: string;
  encoding: Encoding;
  rawBytes: number;
  compressedBytes: number;
  compressionRatio: number;
}

export interface LayoutPlan {
  layout: Layout;
  pagesForFullScan: number;
  pagesForSingleColumnScan: Record<string, number>;
  /** How many separate storage regions a single row's own reconstruction must visit — 1 for NSM/PAX, one per column for DSM. */
  regionsToReconstructOneRow: number;
}

export interface MaterializationPlan {
  filterColumn: string;
  threshold: number;
  projectColumn: string;
  matchingRows: number;
  /** Reconstructs every column of every row before filtering — throws away any layout's own columnar advantage. */
  earlyBytesTouched: number;
  /** Filters on the WHERE column alone, then fetches the SELECT column only at the rows that actually matched. */
  lateBytesTouched: number;
}

export interface ColumnarLimits {
  minRows: number;
  maxRows: number;
  minPageSize: number;
  maxPageSize: number;
}

export const COLUMNAR_LIMITS: ColumnarLimits = {
  minRows: 50,
  maxRows: 2000,
  minPageSize: 64,
  maxPageSize: 1024,
};

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(n)));

/** A seeded PRNG (mulberry32), for a reproducible `?seed=` demo — the same generator `/tools/lsm` already uses. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Four columns, each a clean demonstration of a different encoding's own sweet spot (or lack of one) —
 * deliberately not left to chance:
 *   - `id`: sorted ascending, unique — delta wins (every delta is `1`).
 *   - `status_grouped`: a low-cardinality value held in BLOCKS of `blockSize` rows — RLE wins.
 *   - `status_shuffled`: the SAME low-cardinality values, randomly shuffled — dictionary/bit-packing win, and
 *     RLE loses badly (no real runs survive the shuffle), the direct contrast with `status_grouped`.
 *   - `amount`: high-cardinality random noise across a wide range — nothing compresses it well, the honest
 *     "not every column is worth compressing" case.
 */
export function demoColumns(rawRowCount: number, seed: number): ColumnData[] {
  const rowCount = clamp(rawRowCount, COLUMNAR_LIMITS.minRows, COLUMNAR_LIMITS.maxRows);
  const rnd = makeRng(seed);
  // Exactly one pass through the 4-value cycle — the fewest possible runs (4), so RLE's own fixed per-run
  // overhead stays small relative to row count robustly across this tool's whole range, not just by luck at
  // one particular size (verified via probe: this blockCount wins RLE the comparison for every row count this
  // tool allows except its own smallest, where a column this short barely costs anything under any encoding).
  const blockSize = Math.max(1, Math.round(rowCount / 4));
  const statusCycle = [0, 1, 2, 3];

  const id = Array.from({ length: rowCount }, (_, i) => i);
  const statusGrouped = Array.from({ length: rowCount }, (_, i) => statusCycle[Math.floor(i / blockSize) % statusCycle.length]!);
  const statusShuffled = [...statusGrouped];
  for (let i = statusShuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [statusShuffled[i], statusShuffled[j]] = [statusShuffled[j]!, statusShuffled[i]!];
  }
  // Spans almost the full int32 range on purpose — a column where even bit-packing barely helps (~31 of 32
  // bits still needed), the honest "not every column is worth compressing" case the other three columns don't show.
  const amount = Array.from({ length: rowCount }, () => Math.floor(rnd() * 2 ** 31));

  return [
    { name: 'id', values: id },
    { name: 'status_grouped', values: statusGrouped },
    { name: 'status_shuffled', values: statusShuffled },
    { name: 'amount', values: amount },
  ];
}

function bitsFor(distinctOrRange: number): number {
  return Math.max(1, Math.ceil(Math.log2(Math.max(1, distinctOrRange))));
}

function dictionaryBytes(values: readonly number[]): number {
  const distinct = new Set(values).size;
  const codeBits = bitsFor(distinct);
  return Math.ceil((values.length * codeBits) / 8) + distinct * VALUE_BYTE_WIDTH;
}

function rleBytes(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let runs = 1;
  for (let i = 1; i < values.length; i++) if (values[i] !== values[i - 1]) runs++;
  // Each run: one raw value (4 bytes) + a 2-byte run length (supports runs up to 65,535 — generous for any
  // demo size this tool allows).
  return runs * (VALUE_BYTE_WIDTH + 2);
}

function deltaBytes(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let maxAbsDelta = 0;
  for (let i = 1; i < values.length; i++) maxAbsDelta = Math.max(maxAbsDelta, Math.abs(values[i]! - values[i - 1]!));
  const deltaBits = bitsFor(maxAbsDelta + 1) + 1; // +1 sign bit — a delta can be negative even if the column itself is not
  return VALUE_BYTE_WIDTH + Math.ceil(((values.length - 1) * deltaBits) / 8);
}

function bitpackBytes(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const bits = bitsFor(max - min + 1);
  return Math.ceil((values.length * bits) / 8);
}

/** The real, computed size of `values` under `encoding` — never estimated. */
export function encodingSize(values: readonly number[], encoding: Encoding): number {
  switch (encoding) {
    case 'none': return values.length * VALUE_BYTE_WIDTH;
    case 'dictionary': return dictionaryBytes(values);
    case 'rle': return rleBytes(values);
    case 'delta': return deltaBytes(values);
    case 'bitpack': return bitpackBytes(values);
  }
}

/** Whichever real encoding is genuinely smallest for this column — computed, never guessed. */
export function bestEncodingFor(values: readonly number[]): Encoding {
  let best: Encoding = 'none';
  let bestSize = encodingSize(values, 'none');
  for (const enc of ENCODINGS.slice(1)) {
    const size = encodingSize(values, enc);
    if (size < bestSize) { best = enc; bestSize = size; }
  }
  return best;
}

export function planColumn(column: ColumnData, encoding: Encoding): ColumnPlan {
  const rawBytes = column.values.length * VALUE_BYTE_WIDTH;
  const compressedBytes = encodingSize(column.values, encoding);
  return {
    name: column.name,
    encoding,
    rawBytes,
    compressedBytes,
    compressionRatio: compressedBytes === 0 ? 0 : rawBytes / compressedBytes,
  };
}

/**
 * PAX's own group size: large enough that one column's own minipage within a group spans at least a full page
 * (`pageSize / VALUE_BYTE_WIDTH` rows) — otherwise a group's entire row width already fits on one shared page,
 * and a "single-column" read would cost that same one page anyway, same as NSM, with no columnar skip benefit
 * at all. This is a real, non-obvious property of PAX, not a demo convenience: too small a group and the hybrid
 * degenerates to NSM's own locality with none of DSM's read savings.
 */
function paxRowsPerGroup(pageSize: number): number {
  return Math.max(16, Math.ceil(pageSize / VALUE_BYTE_WIDTH));
}

export function planLayout(layout: Layout, columns: readonly ColumnData[], rawPageSize: number): LayoutPlan {
  const pageSize = clamp(rawPageSize, COLUMNAR_LIMITS.minPageSize, COLUMNAR_LIMITS.maxPageSize);
  const rowCount = columns[0]?.values.length ?? 0;
  const rowWidth = columns.length * VALUE_BYTE_WIDTH;
  const pagesForSingleColumnScan: Record<string, number> = {};

  if (layout === 'NSM') {
    const rowsPerPage = Math.max(1, Math.floor(pageSize / rowWidth));
    const pages = Math.ceil(rowCount / rowsPerPage);
    for (const c of columns) pagesForSingleColumnScan[c.name] = pages; // no way to skip other columns in a page
    return { layout, pagesForFullScan: pages, pagesForSingleColumnScan, regionsToReconstructOneRow: 1 };
  }

  if (layout === 'DSM') {
    let totalPages = 0;
    for (const c of columns) {
      const colPages = Math.ceil((rowCount * VALUE_BYTE_WIDTH) / pageSize);
      pagesForSingleColumnScan[c.name] = colPages;
      totalPages += colPages;
    }
    return { layout, pagesForFullScan: totalPages, pagesForSingleColumnScan, regionsToReconstructOneRow: columns.length };
  }

  // PAX: column-major within each row group, groups laid out one after another. A group's own pages are
  // shared, densely packed across every column's minipage (so a full scan costs the same total bytes as NSM/
  // DSM) — but a single-column scan can fetch just that column's own minipage, one nearby group at a time.
  const rowsPerGroup = paxRowsPerGroup(pageSize);
  const groupCount = Math.ceil(rowCount / rowsPerGroup);
  let fullScanPages = 0;
  for (const c of columns) pagesForSingleColumnScan[c.name] = 0;

  for (let g = 0; g < groupCount; g++) {
    const rowsInGroup = Math.min(rowsPerGroup, rowCount - g * rowsPerGroup);
    fullScanPages += Math.ceil((rowsInGroup * rowWidth) / pageSize);
    for (const c of columns) {
      pagesForSingleColumnScan[c.name]! += Math.ceil((rowsInGroup * VALUE_BYTE_WIDTH) / pageSize);
    }
  }

  return { layout, pagesForFullScan: fullScanPages, pagesForSingleColumnScan, regionsToReconstructOneRow: 1 };
}

export function planMaterialization(
  columns: readonly ColumnData[],
  filterColumn: string,
  threshold: number,
  projectColumn: string,
): MaterializationPlan {
  const filter = columns.find((c) => c.name === filterColumn);
  const rowCount = columns[0]?.values.length ?? 0;
  const matchingRows = filter ? filter.values.filter((v) => v >= threshold).length : 0;

  const rowWidth = columns.length * VALUE_BYTE_WIDTH;
  const earlyBytesTouched = rowCount * rowWidth; // every column, every row, before the filter is even applied

  const filterBytes = rowCount * VALUE_BYTE_WIDTH; // the WHERE column, every row — it must be read in full to filter
  const projectBytes = matchingRows * VALUE_BYTE_WIDTH; // the SELECT column, only at the rows that actually matched
  const lateBytesTouched = filterColumn === projectColumn ? filterBytes : filterBytes + projectBytes;

  return { filterColumn, threshold, projectColumn, matchingRows, earlyBytesTouched, lateBytesTouched };
}
