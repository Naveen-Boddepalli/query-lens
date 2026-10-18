/**
 * A first cost model: cardinality and page-count *estimates*, annotated onto
 * plan nodes (plan.md §7.3, §22.2).
 *
 * Every number here is a textbook heuristic, and each carries a `basis` string
 * naming the rule of thumb it came from — an equality is `1 / ndistinct`, an
 * open range is linear over the column's min–max, an `AND` multiplies its parts
 * and assumes they are independent. plan.md §12 is explicit that an invented
 * figure with a decimal point is worse than an honest guess, so the estimate is
 * always shown next to the count the executor actually produced: the optimiser
 * is guessing, and the UI says so.
 *
 * Pure and synchronous, on the same rules as the rest of `src/engine`.
 */

import type { CompareOp, Expr } from '../parser/index.ts';
import type { Row, SqlValue, Table } from '../types.ts';
import { columnsOfIndex } from '../index/spec.ts';
import { lookupKeysOf } from './plan.ts';
import type { Plan } from './plan.ts';

/** Default selectivity for an open range with no usable min/max (Selinger et al., 1979). */
export const OPEN_RANGE_SELECTIVITY = 1 / 3;
/** Default equality selectivity when a column has no distinct-value stats. */
export const NO_STATS_EQ_SELECTIVITY = 0.1;
/**
 * `LIKE` has no honest closed form without a histogram of prefixes — a guess of
 * one row in ten, the classic optimizer default. Named as a default on the node.
 */
export const LIKE_SELECTIVITY = 0.1;
/** B+Tree fan-out — `DEFAULT_MAX_KEYS` in src/engine/index/btree.ts. */
const FANOUT = 4;

export interface CostEstimate {
  /** Estimated rows *out* of this node. */
  estRows: number;
  /** Estimated page reads this node drives. */
  estPages: number;
  /** The heuristic in a few words, shown on the node so the number is legible. */
  basis: string;
}

/** Per-node estimates for one plan tree, keyed by node identity. */
export type PlanCost = Map<Plan, CostEstimate>;

/**
 * How selective an equality lookup on the first `width` columns of the index `name` is: `distinct` is the number of
 * distinct keys it assumes (each column's distinct count multiplied — independence, the same assumption an `AND`
 * makes), so `rows / distinct` rows match on average. For a plain index that is `ndistinct` of its one column.
 */
function lookupSelectivity(table: Table, name: string, width: number): { distinct: number; basis: string } {
  const columns = columnsOfIndex(name).slice(0, width);
  const counts = columns.map((column) => ndistinct(table, column));
  const distinct = counts.reduce((product, n) => product * n, 1);
  return {
    distinct,
    basis: columns.length === 1 ? `1/${String(distinct)} on ${name}` : `${counts.map((n) => `1/${String(n)}`).join(' × ')} on ${columns.join(', ')}`,
  };
}

function liveNdistinct(rows: readonly Row[], column: string): number {
  const seen = new Set<SqlValue>();
  for (const row of rows) seen.add(row[column] ?? null);
  return Math.max(seen.size, 1);
}

/**
 * Exported for `optimize.ts`'s `index-selection` rule — the same selectivity fact, reused to pick the more
 * selective of two candidate indexes rather than re-deriving it. Reads `table.stats` when `ANALYZE` has set it
 * (plan.md §25.4 C1) — a real count, but possibly a stale one, exactly the way a real optimizer's is — and
 * otherwise scans the live rows, today's (unconditionally accurate, unconditionally *unrealistic*) behaviour.
 */
export function ndistinct(table: Table, column: string): number {
  const stat = table.stats?.columns[column];
  return stat ? Math.max(stat.nDistinct, 1) : liveNdistinct(table.rows, column);
}

function columnName(expr: Expr): string | null {
  if (expr.kind !== 'compare') return null;
  if (expr.left.kind === 'column') return expr.left.name;
  if (expr.right.kind === 'column') return expr.right.name;
  return null;
}

function literalValue(expr: Expr): SqlValue | null {
  if (expr.kind !== 'compare') return null;
  if (expr.left.kind === 'literal') return expr.left.value;
  if (expr.right.kind === 'literal') return expr.right.value;
  return null;
}

interface Selectivity {
  fraction: number;
  /** Terse enough to sit on a plan node. */
  basis: string;
}

/**
 * `column = literal`'s selectivity. Without statistics this is the textbook `1/ndistinct` — every distinct value
 * assumed equally likely. With them (plan.md §25.4 C1), a `literal` that is itself one of the column's own
 * most-common values gets its *real* frequency instead of the average; any other value gets the average
 * frequency of everything the most-common list does *not* already cover, which is closer to `1/ndistinct` the
 * less skewed the column turns out to be and further from it the more skewed.
 */
function equalitySelectivity(column: string | null, table: Table, literal: SqlValue | null = null): Selectivity {
  if (!column || !table.columns.includes(column)) {
    return { fraction: NO_STATS_EQ_SELECTIVITY, basis: '0.1 default' };
  }
  const stat = table.stats?.columns[column];
  const rowCount = table.stats?.rowCount ?? 0;
  if (stat && rowCount > 0) {
    const mcv = literal !== null ? stat.mostCommonValues.find((m) => m.value === literal) : undefined;
    if (mcv) {
      return { fraction: mcv.frequency / rowCount, basis: `${String(mcv.frequency)}/${String(rowCount)} on ${column} (its most common value, ANALYZE)` };
    }
    const coveredFraction = stat.mostCommonValues.reduce((sum, m) => sum + m.frequency, 0) / rowCount;
    const remainingDistinct = Math.max(1, stat.nDistinct - stat.mostCommonValues.length);
    return {
      fraction: Math.max(0, 1 - coveredFraction) / remainingDistinct,
      basis: `1/${String(remainingDistinct)} of the rest on ${column} (ANALYZE)`,
    };
  }
  const distinct = ndistinct(table, column);
  return { fraction: 1 / distinct, basis: `1/${String(distinct)} on ${column}` };
}

function rangeSelectivity(
  column: string | null,
  op: Exclude<CompareOp, '=' | '<>'>,
  literal: SqlValue | null,
  table: Table,
): Selectivity {
  const fallback: Selectivity = { fraction: OPEN_RANGE_SELECTIVITY, basis: '⅓ default' };
  if (!column || typeof literal !== 'number') return fallback;

  // A single bound is a half-open BETWEEN — `boundedRangeSelectivity` already has the ANALYZE-aware histogram
  // logic (plan.md §25.4 C1), so a bound with statistics behind it is handed straight to it rather than
  // duplicating that logic here. One without statistics falls through to this function's own min/max fallback,
  // unchanged, so every query a table without `ANALYZE` ever ran keeps exactly the estimate it always got.
  if (table.stats?.columns[column]) {
    return op === '>' || op === '>=' ? boundedRangeSelectivity(column, literal, null, table) : boundedRangeSelectivity(column, null, literal, table);
  }

  const values = table.rows
    .map((row) => row[column])
    .filter((value): value is number => typeof value === 'number');
  if (values.length === 0) return fallback;

  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return fallback;

  const above = (max - literal) / (max - min);
  const fraction = Math.min(1, Math.max(0, op === '>' ? above : 1 - above));
  return { fraction, basis: `~${String(Math.round(fraction * 100))}% by range` };
}

/**
 * Fraction of an equi-depth histogram's own rows (plan.md §25.4 C1) that fall within `[low, high]` — each bucket
 * assumed to hold an equal share of them, and each bucket's own share assumed spread evenly between its two
 * boundaries. Numeric boundaries only; a text histogram (still useful for `mostCommonValues`, never for this)
 * falls back to the classic ⅓ default, same as no histogram at all.
 */
function histogramFraction(bounds: readonly SqlValue[], low: number | null, high: number | null): number {
  if (bounds.length < 2 || !bounds.every((b) => typeof b === 'number')) return OPEN_RANGE_SELECTIVITY;
  const numeric = bounds as number[];
  const buckets = numeric.length - 1;
  let covered = 0;
  for (let i = 0; i < buckets; i++) {
    const bucketLow = numeric[i]!;
    const bucketHigh = numeric[i + 1]!;
    const width = bucketHigh - bucketLow;
    const effLow = low === null ? bucketLow : Math.max(bucketLow, low);
    const effHigh = high === null ? bucketHigh : Math.min(bucketHigh, high);
    const overlap = width <= 0 ? (effHigh >= effLow ? 1 : 0) : Math.max(0, effHigh - effLow) / width;
    covered += overlap / buckets;
  }
  return Math.min(1, Math.max(0, covered));
}

/**
 * Fraction of `table`'s rows whose `column` falls within `[low, high]` —
 * either bound may be `null` for a half-open range. A dedicated formula
 * rather than reusing `selectivityOf`'s `AND` path (which multiplies two
 * independent fractions): a range's own lower and upper bound are *not*
 * independent of each other — the same column, not two different ones — so
 * multiplying their separate `rangeSelectivity` fractions would
 * double-discount a `BETWEEN` (plan.md §12: no plausible-but-false numbers).
 * When both bounds and the column's numeric min/max are known, this instead
 * computes the true linear-density overlap directly, which is provably the
 * same fraction `rangeSelectivity` already gives for a single bound (set the
 * absent bound to the column's own min or max and the two formulas agree).
 */
export function boundedRangeSelectivity(
  column: string | null,
  low: number | null,
  high: number | null,
  table: Table,
): Selectivity {
  const bounded = low !== null && high !== null;
  const fallback: Selectivity = {
    fraction: bounded ? OPEN_RANGE_SELECTIVITY * OPEN_RANGE_SELECTIVITY : OPEN_RANGE_SELECTIVITY,
    basis: bounded ? '⅓ × ⅓ default (no numeric stats)' : '⅓ default (no numeric stats)',
  };
  if (!column) return fallback;

  const stat = table.stats?.columns[column];
  if (stat && table.stats!.rowCount > 0) {
    const rowCount = table.stats!.rowCount;
    const mcvInRange = stat.mostCommonValues.filter(
      (m) => typeof m.value === 'number' && (low === null || m.value >= low) && (high === null || m.value <= high),
    );
    const mcvInRangeFraction = mcvInRange.reduce((sum, m) => sum + m.frequency, 0) / rowCount;
    const mcvTotalFraction = stat.mostCommonValues.reduce((sum, m) => sum + m.frequency, 0) / rowCount;
    const histFraction = histogramFraction(stat.histogramBounds, low, high);
    const fraction = clampFraction(mcvInRangeFraction + (1 - mcvTotalFraction) * histFraction);
    const boundsLabel = `${low === null ? 'no lower bound' : `≥${String(low)}`}, ${high === null ? 'no upper bound' : `≤${String(high)}`}`;
    return { fraction, basis: `~${String(Math.round(fraction * 100))}% by histogram (${boundsLabel}, ANALYZE)` };
  }

  const values = table.rows
    .map((row) => row[column])
    .filter((value): value is number => typeof value === 'number');
  if (values.length === 0) return fallback;

  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return fallback;

  const effectiveLow = low === null ? min : Math.max(min, low);
  const effectiveHigh = high === null ? max : Math.min(max, high);
  const fraction = Math.min(1, Math.max(0, (effectiveHigh - effectiveLow) / (max - min)));
  const boundsLabel = `${low === null ? 'no lower bound' : `≥${String(low)}`}, ${
    high === null ? 'no upper bound' : `≤${String(high)}`
  }`;
  return { fraction, basis: `~${String(Math.round(fraction * 100))}% by range (${boundsLabel})` };
}

/** The fraction of `column`'s values that are NULL — from `ANALYZE`'s stats when it has run (plan.md §25.4 C1;
 *  possibly stale), otherwise counted from the live data. */
function nullSelectivity(column: string | null, table: Table): Selectivity {
  if (!column || !table.columns.includes(column)) {
    return { fraction: NO_STATS_EQ_SELECTIVITY, basis: '0.1 default' };
  }
  const stat = table.stats?.columns[column];
  if (stat) {
    const rowCount = table.stats!.rowCount;
    const nulls = Math.round(stat.nullFraction * rowCount);
    return { fraction: stat.nullFraction, basis: `${String(nulls)}/${String(rowCount)} NULL in ${column} (ANALYZE)` };
  }
  if (table.rows.length === 0) return { fraction: NO_STATS_EQ_SELECTIVITY, basis: '0.1 default' };
  const nulls = table.rows.filter((row) => (row[column] ?? null) === null).length;
  return { fraction: nulls / table.rows.length, basis: `${String(nulls)}/${String(table.rows.length)} NULL in ${column}` };
}

/** The column an operand names, when it is a bare column reference. */
const columnOf = (expr: Expr): string | null => (expr.kind === 'column' ? expr.name : null);

const clampFraction = (f: number): number => Math.min(1, Math.max(0, f));

/**
 * Selectivity of a predicate, with the heuristic that produced it.
 *
 * `OR` uses inclusion–exclusion (`a + b − a·b`) and, like `AND`'s product,
 * assumes the two parts are independent; `NOT` is the complement. Both are
 * exactly the assumptions plan.md §25.4 C2 later sets out to break on purpose.
 */
export function selectivityOf(expr: Expr, table: Table): Selectivity {
  switch (expr.kind) {
    case 'and': {
      const left = selectivityOf(expr.left, table);
      const right = selectivityOf(expr.right, table);
      return {
        fraction: left.fraction * right.fraction,
        basis: `${left.basis} × ${right.basis}`,
      };
    }
    case 'or': {
      const left = selectivityOf(expr.left, table);
      const right = selectivityOf(expr.right, table);
      return {
        fraction: clampFraction(left.fraction + right.fraction - left.fraction * right.fraction),
        basis: `${left.basis} ∪ ${right.basis}`,
      };
    }
    case 'not': {
      const inner = selectivityOf(expr.operand, table);
      return { fraction: clampFraction(1 - inner.fraction), basis: `1 − (${inner.basis})` };
    }
    case 'isNull': {
      const nulls = nullSelectivity(columnOf(expr.operand), table);
      return expr.negated
        ? { fraction: clampFraction(1 - nulls.fraction), basis: `1 − ${nulls.basis}` }
        : nulls;
    }
    case 'in': {
      const one = equalitySelectivity(columnOf(expr.operand), table);
      const k = expr.items.length;
      const fraction = clampFraction(k * one.fraction);
      return {
        fraction: expr.negated ? clampFraction(1 - fraction) : fraction,
        basis: `${expr.negated ? '1 − ' : ''}${String(k)} × ${one.basis}`,
      };
    }
    case 'like':
      return {
        fraction: expr.negated ? 1 - LIKE_SELECTIVITY : LIKE_SELECTIVITY,
        basis: expr.negated ? '0.9 default (NOT LIKE)' : '0.1 default (LIKE)',
      };
    // An uncorrelated EXISTS has already run (plan.md §27.5 S1): its answer is known, the same for every row.
    case 'exists':
      return expr.resolved === undefined
        ? { fraction: 1, basis: 'EXISTS not yet run' }
        : { fraction: expr.resolved ? 1 : 0, basis: `EXISTS ran once: ${expr.resolved ? 'TRUE' : 'FALSE'}` };
    case 'compare': {
      if (expr.op === '=') return equalitySelectivity(columnName(expr), table, literalValue(expr));
      if (expr.op === '<>') {
        const eq = equalitySelectivity(columnName(expr), table, literalValue(expr));
        return { fraction: clampFraction(1 - eq.fraction), basis: `1 − ${eq.basis}` };
      }
      return rangeSelectivity(columnName(expr), expr.op, literalValue(expr), table);
    }
    default:
      return { fraction: 1, basis: 'no predicate' };
  }
}

const clampRows = (value: number): number => Math.max(0, Math.round(value));

/**
 * The table a plan reads first — its leftmost scan's: a SELECT's `FROM` table, under whatever sits above it. How a
 * compound query's `SetOp` (plan.md §27.5 S3) finds the table to estimate each of its inputs against.
 */
export function baseTableOf(plan: Plan): string {
  switch (plan.op) {
    case 'SeqScan':
    case 'IndexScan':
    case 'IndexOnlyScan':
    case 'IndexRangeScan':
    case 'IndexProbe':
      return plan.table;
    case 'Join':
    case 'SetOp':
      return baseTableOf(plan.left);
    default:
      return baseTableOf(plan.child);
  }
}

/** Estimated B+Tree levels for a bulk-loaded index over `rowCount` rows. */
export function estimateIndexLevels(rowCount: number): number {
  let nodes = Math.max(1, Math.ceil(rowCount / FANOUT));
  let levels = 1;
  while (nodes > 1) {
    nodes = Math.ceil(nodes / (FANOUT + 1));
    levels += 1;
  }
  return levels;
}

/**
 * `otherTables` is consulted only by the `Join` case, for whichever side of
 * the join is not `table` itself — every other case estimates against the
 * one table a v0 query without a JOIN ever has. A `Join`'s own two children
 * are always a bare `SeqScan` in v1 (plan.md §22.2: no predicate pushdown
 * into either side yet), so each side's own row/column data is exactly one
 * table's, found by name in `table`/`otherTables` rather than threaded down
 * through every other case that never needs a second table at all.
 */
function estimateNode(
  plan: Plan,
  table: Table,
  rowsPerPage: number,
  into: PlanCost,
  otherTables: Record<string, Table> = {},
): CostEstimate {
  const rowCount = table.rows.length;
  const heapPages = Math.max(1, Math.ceil(rowCount / rowsPerPage));
  const tableNamed = (name: string): Table => (name === table.name ? table : otherTables[name]!);

  let estimate: CostEstimate;
  switch (plan.op) {
    case 'SetOp': {
      // Each input is a whole SELECT over its own table (plan.md §27.5 S3), estimated against that table.
      const left = estimateNode(plan.left, tableNamed(baseTableOf(plan.left)), rowsPerPage, into, otherTables);
      const right = estimateNode(plan.right, tableNamed(baseTableOf(plan.right)), rowsPerPage, into, otherTables);
      const estPages = left.estPages + right.estPages;
      estimate =
        plan.kind === 'union'
          ? { estRows: left.estRows + right.estRows, estPages, basis: `${String(left.estRows)} + ${String(right.estRows)}: every row of both` }
          : plan.kind === 'intersect'
            ? { estRows: Math.min(left.estRows, right.estRows), estPages, basis: `at most min(${String(left.estRows)}, ${String(right.estRows)}): no row is in both more often than in either` }
            : { estRows: left.estRows, estPages, basis: `at most ${String(left.estRows)}: EXCEPT can only remove rows from the left` };
      break;
    }
    case 'Join': {
      const left = estimateNode(plan.left, tableNamed(plan.leftTable), rowsPerPage, into, otherTables);
      const right = estimateNode(plan.right, tableNamed(plan.rightTable), rowsPerPage, into, otherTables);
      // Foreign-key assumption: each left row matches about 1/ndistinct(right
      // key) of the right table — the same independence heuristic an
      // equality WHERE already makes, just applied to a join key instead of a
      // literal. Row count never depends on the algorithm — only the page
      // cost does.
      const rightDistinct = ndistinct(tableNamed(plan.rightTable), plan.rightColumn);
      // An `IndexProbe`'s own estimate is *per outer row*, so the full inner size comes from the table itself.
      const rightRows = plan.algorithm === 'index-nested-loop' ? tableNamed(plan.rightTable).rows.length : right.estRows;
      const innerEstimate = clampRows((left.estRows * rightRows) / rightDistinct);
      // A semi- or anti-join (plan.md §27.5 S1) never produces more rows than its outer side, and never one per match:
      // under the textbook *containment* assumption, the outer key's distinct values are matched in proportion to how
      // many distinct keys the inner side has left after its own filter — min(1, that / ndistinct(outer key)). The
      // anti-join keeps the rest. A residual is not estimated: it is assumed to pass.
      const semiKind = plan.joinType === 'semi' || plan.joinType === 'anti' ? plan.joinType : null;
      const outerDistinct = Math.max(1, ndistinct(tableNamed(plan.leftTable), plan.leftColumn));
      const innerKeys = Math.min(rightDistinct, Math.max(rightRows, 0));
      const matchedFraction = Math.min(1, innerKeys / outerDistinct);
      const semiRows = clampRows(left.estRows * matchedFraction);
      // A LEFT JOIN (plan.md §25.4 C3) never drops a left row — the equi-join estimate is a floor, not the answer,
      // whenever it would otherwise guess fewer rows than the outer side alone already has.
      const estRows =
        semiKind === 'semi'
          ? semiRows
          : semiKind === 'anti'
            ? Math.max(0, left.estRows - semiRows)
            : plan.joinType === 'left'
              ? Math.max(left.estRows, innerEstimate)
              : innerEstimate;
      const rowsBasis = semiKind
        ? `${semiKind === 'anti' ? `${String(left.estRows)} − ` : ''}${String(left.estRows)} × min(1, ${String(innerKeys)} distinct ${plan.rightTable}.${plan.rightColumn} / ${String(outerDistinct)} distinct ${plan.leftTable}.${plan.leftColumn})`
        : plan.joinType === 'left' && estRows === left.estRows && left.estRows > innerEstimate
          ? `${String(left.estRows)} (every ${plan.leftTable} row survives a LEFT JOIN; the equi-join estimate alone was only ${String(innerEstimate)})`
          : `${String(left.estRows)} × ${String(rightRows)} / ndistinct(${plan.rightTable}.${plan.rightColumn})`;
      switch (plan.algorithm) {
        case 'index-nested-loop':
          estimate = {
            // The outer is read once; then each outer row pays one probe — the descent, any extra leaves the run of
            // equal keys spans, and a heap page per match (`right` is that per-probe estimate). This is the number
            // that beats a rescan whenever the outer is small and the inner is big.
            estRows,
            estPages: left.estPages + left.estRows * right.estPages,
            basis: `${rowsBasis}; index nested-loop reads ${plan.leftTable} once, then probes ${plan.rightTable}'s index on ${plan.rightColumn} once per row`,
          };
          break;
        case 'hash':
          estimate = {
            // Build the right side into a hash table once, then probe with
            // the left streamed — each side is read exactly once, the
            // honest saving over nested-loop's repeated rescans.
            estRows,
            estPages: left.estPages + right.estPages,
            basis: `${rowsBasis}; hash join reads each side once — build a table on ${plan.rightTable}, probe with ${plan.leftTable}`,
          };
          break;
        case 'sort-merge': {
          // Each side is read once, same as hash — but sorting it first is
          // real spill I/O (mirroring `Sort`'s own `2 * spillPages` "at
          // least run generation" estimate), which hash join's in-memory
          // table never pays. Honest, not flattering: sort-merge is not
          // free just because it avoids nested-loop's rescans.
          const leftSpill = Math.max(1, Math.ceil(left.estRows / rowsPerPage));
          const rightSpill = Math.max(1, Math.ceil(right.estRows / rowsPerPage));
          estimate = {
            estRows,
            estPages: left.estPages + right.estPages + 2 * leftSpill + 2 * rightSpill,
            basis: `${rowsBasis}; sort-merge reads each side once, then sorts both — at least ${String(2 * leftSpill)} spill pages on ${plan.leftTable}, ${String(2 * rightSpill)} on ${plan.rightTable}`,
          };
          break;
        }
        case 'nested-loop':
          estimate = {
            // Nested-loop's own cost is the honest, unflattering number:
            // the outer read once, plus a full rescan of the inner for
            // every outer row — no index taken advantage of yet, since
            // `left`/`right` are always a bare SeqScan in v1.
            estRows,
            estPages: left.estPages + left.estRows * right.estPages,
            basis: semiKind
              ? `${rowsBasis}; nested-loop rescans ${plan.rightTable} once per ${plan.leftTable} row — at most, since it stops at the first match`
              : `${rowsBasis}; nested-loop rescans ${plan.rightTable} once per ${plan.leftTable} row`,
          };
          break;
      }
      break;
    }
    case 'SeqScan': {
      if (plan.filter) {
        const { fraction, basis } = selectivityOf(plan.filter, table);
        estimate = { estRows: clampRows(rowCount * fraction), estPages: heapPages, basis };
      } else {
        estimate = { estRows: rowCount, estPages: heapPages, basis: 'every row' };
      }
      break;
    }
    case 'IndexProbe': {
      // One probe of `table`'s index for one outer row: the per-probe cost, which the Join multiplies by its outer rows.
      const inner = tableNamed(plan.table);
      const distinct = ndistinct(inner, plan.column);
      const matches = Math.max(clampRows(inner.rows.length / distinct), 1);
      const extraLeaves = Math.max(0, Math.ceil(matches / FANOUT) - 1);
      estimate = {
        estRows: matches,
        estPages: estimateIndexLevels(inner.rows.length) + extraLeaves + matches,
        basis: `per outer row: 1/${String(distinct)} on ${plan.column}; ${String(estimateIndexLevels(inner.rows.length))} to descend, ${String(matches)} heap page${matches === 1 ? '' : 's'}`,
      };
      break;
    }
    case 'IndexScan': {
      const { distinct, basis: lookupBasis } = lookupSelectivity(table, plan.column, lookupKeysOf(plan).length);
      let fraction = 1 / distinct;
      let basis = lookupBasis;
      if (plan.residual) {
        const residual = selectivityOf(plan.residual, table);
        fraction *= residual.fraction;
        basis += ` + recheck ${residual.basis}`;
      }
      const levels = estimateIndexLevels(rowCount);
      // A repeated value is one entry per row: the lookup may read a few more leaves along the run, and each match
      // costs its own heap page. For a unique value that is zero extra leaves and one page — the +1 it always was.
      const matches = Math.max(clampRows(rowCount / distinct), 1);
      const extraLeaves = Math.max(0, Math.ceil(matches / FANOUT) - 1);
      estimate = {
        estRows: Math.max(clampRows(rowCount * fraction), plan.residual ? 0 : 1),
        estPages: levels + extraLeaves + matches,
        basis,
      };
      break;
    }
    case 'IndexRangeScan': {
      const low = plan.low && typeof plan.low.value === 'number' ? plan.low.value : null;
      const high = plan.high && typeof plan.high.value === 'number' ? plan.high.value : null;
      const prefixLength = plan.prefix?.length ?? 0;
      const rangeColumn = columnsOfIndex(plan.column)[prefixLength] ?? plan.column;
      const { fraction: rangeFraction, basis: rangeBasis } = boundedRangeSelectivity(
        rangeColumn,
        low,
        high,
        table,
      );
      // Within a composite index's equality prefix the range narrows only that run.
      const within = prefixLength > 0 ? lookupSelectivity(table, plan.column, prefixLength) : null;
      let fraction = within ? rangeFraction / within.distinct : rangeFraction;
      let basis = within ? `${within.basis} × ${rangeBasis}` : rangeBasis;
      if (plan.residual) {
        const residual = selectivityOf(plan.residual, table);
        fraction *= residual.fraction;
        basis += ` + recheck ${residual.basis}`;
      }
      const estRows = clampRows(rowCount * fraction);
      const levels = estimateIndexLevels(rowCount);
      // Descend to the first leaf (`levels` node reads), walk however many
      // more leaves the estimated rows span via sibling pointers, then one
      // heap page per matching row — the same one-touch-per-row granularity
      // IndexScan already prices, just repeated `estRows` times instead of
      // once.
      const leafSpan = Math.max(1, Math.ceil(estRows / FANOUT));
      const extraLeaves = Math.max(0, leafSpan - 1);
      estimate = {
        estRows,
        estPages: levels + extraLeaves + estRows,
        basis: `${basis}; ${String(levels)} to descend, ${String(extraLeaves)} more leaf${extraLeaves === 1 ? '' : 's'} via sibling pointers, ${String(estRows)} heap page${estRows === 1 ? '' : 's'}`,
      };
      break;
    }
    case 'IndexOnlyScan': {
      // The tree levels alone — no heap page, the honest difference from IndexScan — plus any further leaves a
      // repeated value's run spans.
      const { distinct, basis: lookupBasis } = lookupSelectivity(table, plan.column, lookupKeysOf(plan).length);
      const matches = Math.max(clampRows(rowCount / distinct), 1);
      const extraLeaves = Math.max(0, Math.ceil(matches / FANOUT) - 1);
      estimate = {
        estRows: matches,
        estPages: estimateIndexLevels(rowCount) + extraLeaves,
        basis: `${lookupBasis} — index-only, no heap page`,
      };
      break;
    }
    case 'Filter': {
      const child = estimateNode(plan.child, table, rowsPerPage, into, otherTables);
      const { fraction, basis } = selectivityOf(plan.predicate, table);
      estimate = { estRows: clampRows(child.estRows * fraction), estPages: child.estPages, basis };
      break;
    }
    case 'HashDistinct':
    case 'SortDistinct': {
      const child = estimateNode(plan.child, table, rowsPerPage, into, otherTables);
      // How many distinct rows: bounded by the input, and — when the projection is plain columns — by the product
      // of their distinct-value counts (the same independence assumption an AND makes). An expression, `*` or a
      // column the table does not know has no statistic, so the input size stands.
      const project = plan.child.op === 'Project' ? plan.child.columns : null;
      let bound = child.estRows;
      let basis = 'no distinct-value statistic for this list';
      if (project?.kind === 'columns' && project.names.every((n) => table.columns.includes(n))) {
        const distinct = project.names.reduce((product, n) => product * ndistinct(table, n), 1);
        bound = Math.min(child.estRows, distinct);
        basis = `min(${String(child.estRows)}, ${project.names.map((n) => `${String(ndistinct(table, n))} distinct ${n}`).join(' × ')})`;
      }
      // A sort-based DISTINCT spills exactly like `Sort`: every row written once and read back once.
      const spill = plan.op === 'SortDistinct' ? 2 * Math.max(1, Math.ceil(child.estRows / rowsPerPage)) : 0;
      estimate = {
        estRows: clampRows(bound),
        estPages: child.estPages + spill,
        basis: plan.op === 'SortDistinct' ? `${basis}; sorted first (${String(spill)} spill pages)` : basis,
      };
      break;
    }
    case 'Having': {
      const child = estimateNode(plan.child, table, rowsPerPage, into, otherTables);
      // Aggregate values have no column statistics to consult, so every comparison against one falls to the
      // range/equality *defaults* (`selectivityOf` finds no column) — honest, and labelled as such.
      const { fraction, basis } = selectivityOf(plan.predicate, table);
      estimate = { estRows: clampRows(child.estRows * fraction), estPages: child.estPages, basis: `HAVING: ${basis}` };
      break;
    }
    case 'HashAggregate':
    case 'SortAggregate': {
      const child = estimateNode(plan.child, table, rowsPerPage, into, otherTables);
      // A hash table adds no I/O of its own — everything happens in memory —
      // but a sort aggregate spills exactly like `Sort` does, on top of
      // whatever the child already costs to read; that extra spill, priced
      // the same way `Sort`'s own case below prices it, is the entire point
      // of comparison `/compare`'s third mode shows (plan.md §22.2).
      const spillPages =
        plan.op === 'SortAggregate' ? 2 * Math.max(1, Math.ceil(child.estRows / rowsPerPage)) : 0;
      if (plan.groupBy.length === 0) {
        // No GROUP BY: the whole input is one group — even zero input rows
        // still produce one, since COUNT(*) of nothing is 0, not absent.
        estimate = {
          estRows: 1,
          estPages: child.estPages + spillPages,
          basis:
            plan.op === 'SortAggregate'
              ? `no GROUP BY — one group, but sorted first anyway (${String(spillPages)} spill pages)`
              : 'no GROUP BY — the whole input is one group',
        };
      } else {
        // Textbook independence assumption, same as an AND's selectivity:
        // the product of each column's distinct-value count, capped at the
        // rows actually going in — there cannot be more groups than rows.
        // A group column after a JOIN is keyed `table.column` (plan.md §26 Feature 1, slice c): count it in its own table.
        const ndistinctOf = (key: string): number => {
          const dot = key.indexOf('.');
          if (dot < 0) return ndistinct(table, key);
          const owner = key.slice(0, dot) === table.name ? table : otherTables[key.slice(0, dot)];
          return owner ? ndistinct(owner, key.slice(dot + 1)) : 1;
        };
        const groups = plan.groupBy.reduce((product, col) => product * ndistinctOf(col), 1);
        const groupBasis = `${plan.groupBy.map((c) => `ndistinct(${c})`).join(' × ')}, capped at the input`;
        estimate = {
          estRows: Math.max(1, Math.min(child.estRows, clampRows(groups))),
          estPages: child.estPages + spillPages,
          basis:
            plan.op === 'SortAggregate'
              ? `${groupBasis}; sorts ${String(child.estRows)} rows first (${String(spillPages)} spill pages)`
              : groupBasis,
        };
      }
      break;
    }
    case 'Sort': {
      // Row order changes, not row count — but Sort's own I/O is the honest
      // number to surface here: a spill writes and re-reads the data, so its
      // page cost is real disk activity a Filter/Project never adds.
      const child = estimateNode(plan.child, table, rowsPerPage, into, otherTables);
      const spillPages = Math.max(1, Math.ceil(child.estRows / rowsPerPage));
      estimate = {
        estRows: child.estRows,
        estPages: 2 * spillPages,
        basis: `sorts ${String(child.estRows)} rows; at least ${String(2 * spillPages)} spill pages (run generation alone)`,
      };
      break;
    }
    case 'Project': {
      const child = estimateNode(plan.child, table, rowsPerPage, into, otherTables);
      estimate = { estRows: child.estRows, estPages: child.estPages, basis: child.basis };
      break;
    }
    case 'Limit': {
      const child = estimateNode(plan.child, table, rowsPerPage, into, otherTables);
      const offset = plan.offset ?? 0;
      estimate = {
        estRows: Math.min(Math.max(0, child.estRows - offset), plan.count),
        estPages: child.estPages,
        basis:
          offset > 0
            ? `min(${String(child.estRows)} − ${String(offset)} skipped, LIMIT ${String(plan.count)})`
            : `min(${String(child.estRows)}, LIMIT ${String(plan.count)})`,
      };
      break;
    }
  }

  into.set(plan, estimate);
  return estimate;
}

/**
 * Per-node estimates for a plan tree. `otherTables` is the join partner's
 * `Table`, keyed by name — needed only when `plan` contains a `Join`; every
 * other caller (no JOIN in the query) omits it.
 */
export function estimatePlan(
  plan: Plan,
  table: Table,
  rowsPerPage: number,
  otherTables?: Record<string, Table>,
): PlanCost {
  const cost: PlanCost = new Map();
  estimateNode(plan, table, rowsPerPage, cost, otherTables);
  return cost;
}

/** The estimate for the plan's root node — the query's estimated output. */
export function rootEstimate(
  plan: Plan,
  table: Table,
  rowsPerPage: number,
  otherTables?: Record<string, Table>,
): CostEstimate {
  return estimateNode(plan, table, rowsPerPage, new Map(), otherTables);
}
