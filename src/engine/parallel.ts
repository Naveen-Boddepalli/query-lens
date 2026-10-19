/**
 * Morsel-driven parallel execution (plan.md §27.5 P1), after Leis et al., *Morsel-Driven Parallelism* (SIGMOD 2014):
 * a scan, a filter and an aggregate over a table's real heap pages, cut into **morsels** of a few pages each and handed
 * to *N* workers by a dispatcher. Each worker aggregates what it scans into a partial result of its own; when the last
 * morsel is done, one worker merges the partials — the one step no amount of workers shortens.
 *
 * Nothing here runs in parallel, and nothing waits (plan.md §27.6 rule 9). Time is **ticks**, counted, and how fast
 * each worker is is a **scripted profile** — an input, like a schedule's interleaving — so a run is a pure function of
 * its inputs and the same inputs always give the same timeline:
 *
 * - Reading a page costs one tick, and each row that passes the filter one more (the aggregate's update); a worker
 *   with speed `s` takes `s` times as long. So a filter that matches one corner of the table puts all the work on the
 *   pages there: data skew, beside the workers' own.
 * - Every page has a **home**: the worker whose memory it sits in, the table cut into *N* equal ranges (the paper's
 *   NUMA nodes). Reading a page from another worker's memory costs a second tick.
 * - Taking a morsel costs one tick — the dispatcher's queue is shared — and stealing one from another worker's queue
 *   costs two.
 * - Merging costs one tick for each group in each partial result.
 *
 * Three dispatchers: **static** gives each worker its home range up front and never rebalances — every read local,
 * and the slowest worker or the busiest range decides the end; **shared** keeps one queue of morsels in page order that
 * every idle worker takes the next from — balanced, but most of what a worker reads is someone else's; **stealing**
 * gives each worker a queue of the morsels in its own range (the paper's NUMA-local queues) and lets one whose queue is
 * empty take the last morsel from whichever queue has the most left — local until the end, balanced at it.
 */

import { passes } from './exec/evaluate.ts';
import { parse } from './parser/index.ts';
import type { AggregateFn, Expr, SelectStatement } from './parser/index.ts';
import { aggregateKeyOf, columnKey } from './parser/index.ts';
import { buildHeap } from './storage/index.ts';
import type { Database, Row, SqlValue } from './types.ts';
import { compareValues } from './value.ts';

export type Dispatch = 'static' | 'shared' | 'stealing';
export const DISPATCHES: readonly Dispatch[] = ['static', 'shared', 'stealing'];

export const PARALLEL_LIMITS = {
  minWorkers: 1,
  maxWorkers: 8,
  minMorselPages: 1,
  maxMorselPages: 64,
  minSpeed: 1,
  maxSpeed: 5,
} as const;

export interface ParallelOptions {
  workers: number;
  /** Pages per morsel. A static dispatch ignores it: its morsels are the *N* ranges. */
  morselPages: number;
  dispatch: Dispatch;
  /** Ticks per unit of work, one per worker — 1 is full speed, 3 a worker three times slower. A scripted input. */
  speeds: readonly number[];
  rowsPerPage: number;
}

export interface Morsel {
  id: number;
  firstPage: number;
  lastPage: number;
  /** Work at full speed: a tick per page, and one per row that passes the filter. */
  work: number;
}

export interface MorselRun {
  morsel: number;
  worker: number;
  /** When the worker started taking it: the dispatch tick (or two, for a steal) comes first. */
  taken: number;
  start: number;
  end: number;
  /** The worker whose queue it was stolen from, when it was. */
  stolenFrom?: number;
  /** Rows of it that passed the filter. */
  rows: number;
  /** Pages of it whose home is another worker: each read costs a second tick. */
  remotePages: number;
}

export interface ParallelResult {
  ok: true;
  table: string;
  pages: number;
  morsels: Morsel[];
  runs: MorselRun[];
  /** The merge of the partial results: one worker, after every morsel, a tick per group per partial. */
  merge: { worker: number; start: number; end: number; partials: number[] };
  /** From the first tick to the end of the merge. */
  ticks: number;
  /** One full-speed worker doing all the work: no dispatching, no merge. What the speedup is measured against. */
  serialTicks: number;
  speedup: number;
  /** Ticks each worker spent working (dispatch and merge included), and idle before the merge ended. */
  busy: number[];
  idle: number[];
  steals: number;
  /** The answer, the partial results merged: what the serial engine returns, in its column order. */
  columns: string[];
  rows: Row[];
}

export interface ParallelError {
  ok: false;
  error: string;
}

/** What the tool can run in parallel: one table, an optional `WHERE`, aggregates, and the columns it groups by. */
interface Shape {
  table: string;
  where: Expr | undefined;
  groupBy: string[];
  outputs: ({ kind: 'group'; key: string; column: string } | { kind: 'aggregate'; key: string; fn: AggregateFn; column: string | null })[];
}

function shapeOf(sql: string, db: Database): Shape | string {
  const parsed = parse(sql);
  if (!parsed.ok) return parsed.error.message;
  const ast: SelectStatement = parsed.ast;
  const refuse = 'The parallel run takes a scan, a filter and an aggregate: SELECT [grouped columns,] aggregates FROM one table [WHERE …] [GROUP BY …].';
  if (ast.joins || ast.having || ast.orderBy || ast.limit || ast.distinct || ast.select.kind === 'star' || ast.semiJoins) return refuse;
  const table = db.tables[ast.from.source ?? ast.from.name];
  if (!table) return `There is no table named ${ast.from.name}.`;
  const groupBy = (ast.groupBy?.columns ?? []).map((c) => c.name);
  const outputs: Shape['outputs'] = [];
  for (const item of ast.select.items) {
    if (item.kind === 'aggregate') {
      if (item.arg.kind === 'column' && item.arg.distinct) return 'COUNT(DISTINCT …) cannot be merged from partial counts: each worker would count its own distinct values.';
      const column = item.arg.kind === 'column' ? item.arg.name : null;
      if (column !== null && !table.columns.includes(column)) return `There is no column ${column} in ${table.name}.`;
      outputs.push({ kind: 'aggregate', key: aggregateKeyOf(item.fn, item.arg), fn: item.fn, column });
    } else if (item.kind === 'column' && groupBy.includes(item.name)) {
      outputs.push({ kind: 'group', key: columnKey(item), column: item.name });
    } else {
      return refuse;
    }
  }
  if (!outputs.some((o) => o.kind === 'aggregate')) return refuse;
  for (const g of groupBy) if (!table.columns.includes(g)) return `There is no column ${g} in ${table.name}.`;
  return { table: table.name, where: ast.where, groupBy, outputs };
}

/** One aggregate's running state, mergeable: AVG keeps its sum and count until the end. */
interface Partial {
  count: number;
  sum: number;
  min: SqlValue;
  max: SqlValue;
}

const emptyPartial = (): Partial => ({ count: 0, sum: 0, min: null, max: null });

function update(p: Partial, value: SqlValue): void {
  if (value === null) return;
  p.count += 1;
  if (typeof value === 'number') p.sum += value;
  if (p.min === null || compareValues(value, p.min) < 0) p.min = value;
  if (p.max === null || compareValues(value, p.max) > 0) p.max = value;
}

function mergeInto(into: Partial, from: Partial): void {
  into.count += from.count;
  into.sum += from.sum;
  if (from.min !== null && (into.min === null || compareValues(from.min, into.min) < 0)) into.min = from.min;
  if (from.max !== null && (into.max === null || compareValues(from.max, into.max) > 0)) into.max = from.max;
}

/** A worker's partial result: per group (keyed by its values), one running state per output aggregate. */
type Partials = Map<string, { values: SqlValue[]; states: Partial[]; rows: number }>;

function finish(fn: AggregateFn, p: Partial, rows: number, column: string | null): SqlValue {
  if (fn === 'COUNT') return column === null ? rows : p.count;
  if (fn === 'SUM') return p.count === 0 ? null : p.sum;
  if (fn === 'AVG') return p.count === 0 ? null : p.sum / p.count;
  return fn === 'MIN' ? p.min : p.max;
}

/**
 * Runs `sql` — a scan, a filter and an aggregate — over `db`'s table with *N* workers, and returns the timeline and
 * the merged answer. An error names what the parallel run cannot take.
 */
export function runParallel(sql: string, db: Database, options: ParallelOptions): ParallelResult | ParallelError {
  const shape = shapeOf(sql, db);
  if (typeof shape === 'string') return { ok: false, error: shape };
  const n = Math.max(PARALLEL_LIMITS.minWorkers, Math.min(PARALLEL_LIMITS.maxWorkers, Math.floor(options.workers)));
  const speed = (w: number) => Math.max(PARALLEL_LIMITS.minSpeed, Math.min(PARALLEL_LIMITS.maxSpeed, Math.floor(options.speeds[w] ?? 1)));
  const heap = buildHeap(db.tables[shape.table]!, options.rowsPerPage);
  const pages = heap.pages.length;
  const passing = heap.pages.map((page) => page.rows.filter((row) => passes(shape.where, row)));
  const pageWork = passing.map((rows) => 1 + rows.length);
  const homeSize = Math.max(1, Math.ceil(pages / n));
  const homeOf = (page: number) => Math.min(n - 1, Math.floor(page / homeSize));

  // The morsels: N equal ranges for a static dispatch, runs of `morselPages` pages otherwise.
  const ranges: [number, number][] = [];
  if (options.dispatch === 'static') {
    for (let first = 0; first < pages; first += homeSize) ranges.push([first, Math.min(pages, first + homeSize) - 1]);
  } else {
    const size = Math.max(PARALLEL_LIMITS.minMorselPages, Math.min(PARALLEL_LIMITS.maxMorselPages, Math.floor(options.morselPages)));
    for (let first = 0; first < pages; first += size) ranges.push([first, Math.min(pages, first + size) - 1]);
  }
  const morsels: Morsel[] = ranges.map(([firstPage, lastPage], id) => {
    let work = 0;
    for (let p = firstPage; p <= lastPage; p++) work += pageWork[p]!;
    return { id, firstPage, lastPage, work };
  });

  // Who may take what: one queue for a shared dispatch; for the other two, a queue per worker of the morsels that
  // start in its home range.
  const queues: number[][] = Array.from({ length: n }, () => []);
  const shared: number[] = [];
  if (options.dispatch === 'shared') shared.push(...morsels.map((m) => m.id));
  else morsels.forEach((m) => queues[homeOf(m.firstPage)]!.push(m.id));

  const free = Array.from({ length: n }, () => 0);
  const busy = Array.from({ length: n }, () => 0);
  const done = Array.from({ length: n }, () => false);
  const runs: MorselRun[] = [];
  let steals = 0;
  for (;;) {
    // The worker free soonest goes next; ties go to the lower number.
    let w = -1;
    for (let k = 0; k < n; k++) if (!done[k] && (w < 0 || free[k]! < free[w]!)) w = k;
    if (w < 0) break;
    let id: number | undefined;
    let cost = 1;
    let stolenFrom: number | undefined;
    if (options.dispatch === 'shared') id = shared.shift();
    else {
      id = queues[w]!.shift();
      if (id === undefined && options.dispatch === 'stealing') {
        let victim = -1;
        for (let k = 0; k < n; k++) if (queues[k]!.length > 0 && (victim < 0 || queues[k]!.length > queues[victim]!.length)) victim = k;
        if (victim >= 0) {
          id = queues[victim]!.pop();
          stolenFrom = victim;
          cost = 2;
          steals += 1;
        }
      }
      // A static dispatch hands each worker its range at the start: there is nothing to take.
      if (options.dispatch === 'static') cost = 0;
    }
    if (id === undefined) {
      done[w] = true;
      continue;
    }
    const morsel = morsels[id]!;
    const taken = free[w]!;
    const start = taken + cost;
    let rows = 0;
    let remotePages = 0;
    for (let p = morsel.firstPage; p <= morsel.lastPage; p++) {
      rows += passing[p]!.length;
      if (homeOf(p) !== w) remotePages += 1;
    }
    const end = start + (morsel.work + remotePages) * speed(w);
    runs.push({ morsel: id, worker: w, taken, start, end, ...(stolenFrom === undefined ? {} : { stolenFrom }), rows, remotePages });
    busy[w]! += end - taken;
    free[w] = end;
  }

  // Each worker's partial result, from the pages it ran.
  const aggregates = shape.outputs.filter((o): o is Extract<Shape['outputs'][number], { kind: 'aggregate' }> => o.kind === 'aggregate');
  const partials: Partials[] = Array.from({ length: n }, (): Partials => new Map());
  for (const run of runs) {
    const morsel = morsels[run.morsel]!;
    const into = partials[run.worker]!;
    for (let p = morsel.firstPage; p <= morsel.lastPage; p++) {
      for (const row of passing[p]!) {
        const values = shape.groupBy.map((g) => row[g] ?? null);
        const key = JSON.stringify(values);
        let group = into.get(key);
        if (!group) {
          group = { values, states: aggregates.map(() => emptyPartial()), rows: 0 };
          into.set(key, group);
        }
        group.rows += 1;
        aggregates.forEach((a, i) => update(group.states[i]!, a.column === null ? 1 : (row[a.column] ?? null)));
      }
    }
  }

  // The merge: the worker that finished first, once every morsel is done, a tick per group per partial.
  const last = Math.max(0, ...runs.map((r) => r.end));
  const mergeWorker = runs.length === 0 ? 0 : free.indexOf(Math.min(...free));
  const sizes = partials.map((p) => p.size);
  const mergeTicks = Math.max(1, sizes.reduce((s, x) => s + x, 0)) * speed(mergeWorker);
  const merged: Partials = new Map();
  for (const partial of partials) {
    for (const [key, group] of partial) {
      const into = merged.get(key);
      if (!into) merged.set(key, { values: group.values, states: group.states.map((s) => ({ ...s })), rows: group.rows });
      else {
        into.rows += group.rows;
        group.states.forEach((s, i) => mergeInto(into.states[i]!, s));
      }
    }
  }
  // No GROUP BY: one row, even over no rows at all, as SQL gives.
  if (shape.groupBy.length === 0 && merged.size === 0) merged.set('[]', { values: [], states: aggregates.map(() => emptyPartial()), rows: 0 });
  const rows: Row[] = [...merged.values()].map((group) => {
    const row: Row = {};
    for (const o of shape.outputs) {
      if (o.kind === 'group') row[o.key] = group.values[shape.groupBy.indexOf(o.column)] ?? null;
      else row[o.key] = finish(o.fn, group.states[aggregates.indexOf(o)]!, group.rows, o.column);
    }
    return row;
  });

  const ticks = last + mergeTicks;
  busy[mergeWorker]! += mergeTicks;
  const serialTicks = pageWork.reduce((s, x) => s + x, 0);
  return {
    ok: true,
    table: shape.table,
    pages,
    morsels,
    runs,
    merge: { worker: mergeWorker, start: last, end: ticks, partials: sizes },
    ticks,
    serialTicks,
    speedup: ticks === 0 ? 1 : serialTicks / ticks,
    busy,
    idle: busy.map((b) => ticks - b),
    steals,
    columns: shape.outputs.map((o) => o.key),
    rows,
  };
}
