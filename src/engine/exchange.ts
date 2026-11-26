/**
 * Exchange operators and a parallel hash join (plan.md §27.5 P2). Rows that have to meet on one worker get there by an
 * **exchange**: **broadcast** sends every row of one side to every worker; **repartition** sends each row to the
 * worker its join key hashes to; **gather** brings what every worker produced to one. A parallel hash join is two
 * exchanges and a local join: broadcast the smaller side and leave the larger where it lies, or repartition both
 * sides on the key so equal keys meet. The two move different numbers of rows, and the ticks follow.
 *
 * The same rules as `parallel.ts` (plan.md §27.6 rule 9): nothing runs concurrently, time is counted in ticks, and a run
 * is a pure function of its inputs. Each table starts spread over the workers in equal ranges, the way a scan's
 * morsels left it. Workers are equally fast here, and every phase ends when its slowest worker does:
 *
 * - **exchange** — a tick for each row a worker sends to another (a row that stays put costs nothing);
 * - **build** — a tick for each build row a worker puts in its hash table;
 * - **probe** — a tick for each probe row it looks up, and one for each row that matches;
 * - **gather** — the first worker takes in everyone else's results, a tick a row: every row for `SELECT *`, one
 *   partial count each for `SELECT COUNT(*)`.
 */

import { parse } from './parser/index.ts';
import type { Database, Row, SqlValue } from './types.ts';

export type JoinExchange = 'broadcast' | 'repartition';
export const JOIN_EXCHANGES: readonly JoinExchange[] = ['broadcast', 'repartition'];
export const EXCHANGE_LIMITS = { minWorkers: 1, maxWorkers: 8 } as const;

export interface ExchangeOptions {
  workers: number;
  strategy: JoinExchange;
}

export interface JoinSide {
  table: string;
  column: string;
  rows: number;
}

export interface JoinPhase {
  name: 'exchange' | 'build' | 'probe' | 'gather';
  /** Ticks each worker spends in it. */
  perWorker: number[];
  /** Its slowest worker's: when the phase ends for everyone. */
  ticks: number;
}

export interface ParallelJoinResult {
  ok: true;
  /** The smaller side, which the hash table is built on — and which a broadcast sends. */
  build: JoinSide;
  probe: JoinSide;
  strategy: JoinExchange;
  workers: number;
  /** `traffic[from][to]`: rows worker `from` sent worker `to` in the exchange. */
  traffic: number[][];
  /** Rows each worker holds once the exchange is done. */
  held: { build: number[]; probe: number[] };
  phases: JoinPhase[];
  moved: { exchange: number; gather: number; total: number };
  ticks: number;
  /** One worker alone: build every row, probe every row, no exchange and no gather. */
  serialTicks: number;
  speedup: number;
  /** `COUNT(*)` when the query counts, the rows' number otherwise: what the engine returns, run alone. */
  count: number;
  counting: boolean;
  /** The plan, bottom up, in words. */
  plan: string;
}

export interface ParallelJoinError {
  ok: false;
  error: string;
}

/** A key's worker under repartitioning: a multiplicative hash, the same on every worker. */
export function hashWorker(value: SqlValue, workers: number): number {
  const text = typeof value === 'number' ? String(value) : JSON.stringify(value);
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % workers;
}

/** Which worker each row starts on: the table in equal ranges, as a scan left it. */
const homes = (count: number, workers: number): number[] => {
  const size = Math.max(1, Math.ceil(count / workers));
  return Array.from({ length: count }, (_, i) => Math.min(workers - 1, Math.floor(i / size)));
};

export function runParallelJoin(sql: string, db: Database, options: ExchangeOptions): ParallelJoinResult | ParallelJoinError {
  const parsed = parse(sql);
  if (!parsed.ok) return { ok: false, error: parsed.error.message };
  const ast = parsed.ast;
  const join = ast.joins?.[0];
  const refuse = 'The parallel join takes two tables and one equality: SELECT * or SELECT COUNT(*) FROM a JOIN b ON a.x = b.y.';
  if (!join || ast.joins!.length !== 1 || join.joinType !== undefined || !join.on || ast.where || ast.groupBy || ast.orderBy || ast.limit || ast.distinct) {
    return { ok: false, error: refuse };
  }
  const counting =
    ast.select.kind === 'columns' &&
    ast.select.items.length === 1 &&
    ast.select.items[0]!.kind === 'aggregate' &&
    ast.select.items[0]!.fn === 'COUNT' &&
    ast.select.items[0]!.arg.kind === 'star';
  if (ast.select.kind !== 'star' && !counting) return { ok: false, error: refuse };
  const { left, right } = join.on;
  if (left.kind !== 'column' || right.kind !== 'column') return { ok: false, error: refuse };
  const tableOf = (name: string | undefined) => (name === ast.from.name ? ast.from.source ?? ast.from.name : name === join.table.name ? join.table.source ?? join.table.name : undefined);
  const a = { table: tableOf(left.table), column: left.name };
  const b = { table: tableOf(right.table), column: right.name };
  if (!a.table || !b.table || a.table === b.table) return { ok: false, error: refuse };
  const ta = db.tables[a.table];
  const tb = db.tables[b.table];
  if (!ta || !tb) return { ok: false, error: refuse };

  const n = Math.max(EXCHANGE_LIMITS.minWorkers, Math.min(EXCHANGE_LIMITS.maxWorkers, Math.floor(options.workers)));
  // Build on the smaller side, as a hash join does.
  const sideA = { table: a.table, column: a.column, data: ta.rows };
  const sideB = { table: b.table, column: b.column, data: tb.rows };
  const [buildSide, probeSide] = ta.rows.length <= tb.rows.length ? [sideA, sideB] : [sideB, sideA];
  const buildHome = homes(buildSide.data.length, n);
  const probeHome = homes(probeSide.data.length, n);

  // Where every row ends up: a list of workers per row (a broadcast row is on all of them).
  const traffic = Array.from({ length: n }, () => Array.from({ length: n }, () => 0));
  const buildAt: Row[][] = Array.from({ length: n }, () => []);
  const probeAt: Row[][] = Array.from({ length: n }, () => []);
  const send = (row: Row, from: number, to: number, into: Row[][]) => {
    into[to]!.push(row);
    if (from !== to) traffic[from]![to]! += 1;
  };
  buildSide.data.forEach((row, i) => {
    const from = buildHome[i]!;
    if (options.strategy === 'broadcast') for (let to = 0; to < n; to++) send(row, from, to, buildAt);
    else send(row, from, hashWorker(row[buildSide.column] ?? null, n), buildAt);
  });
  probeSide.data.forEach((row, i) => {
    const from = probeHome[i]!;
    send(row, from, options.strategy === 'broadcast' ? from : hashWorker(row[probeSide.column] ?? null, n), probeAt);
  });

  // The local join on each worker: build its hash table, probe it, count what matches.
  const matches = Array.from({ length: n }, (_, w) => {
    const table = new Map<string, number>();
    for (const row of buildAt[w]!) {
      const key = row[buildSide.column] ?? null;
      if (key === null) continue;
      const k = JSON.stringify(key);
      table.set(k, (table.get(k) ?? 0) + 1);
    }
    let found = 0;
    for (const row of probeAt[w]!) {
      const key = row[probeSide.column] ?? null;
      if (key !== null) found += table.get(JSON.stringify(key)) ?? 0;
    }
    return found;
  });

  const sent = traffic.map((row) => row.reduce((s, x) => s + x, 0));
  const phase = (name: JoinPhase['name'], perWorker: number[]): JoinPhase => ({ name, perWorker, ticks: Math.max(0, ...perWorker) });
  const gatherIn = counting ? n - 1 : matches.slice(1).reduce((s, x) => s + x, 0);
  const phases = [
    phase('exchange', sent),
    phase('build', buildAt.map((rows) => rows.length)),
    phase('probe', probeAt.map((rows, w) => rows.length + matches[w]!)),
    phase('gather', Array.from({ length: n }, (_, w) => (w === 0 ? gatherIn : 0))),
  ];
  const ticks = phases.reduce((s, p) => s + p.ticks, 0);
  const count = matches.reduce((s, x) => s + x, 0);
  const serialTicks = buildSide.data.length + probeSide.data.length + count;
  const exchange = sent.reduce((s, x) => s + x, 0);
  const how =
    options.strategy === 'broadcast'
      ? `Broadcast(${buildSide.table}) → every worker; ${probeSide.table} stays where it is`
      : `Repartition(${buildSide.table} by ${buildSide.column}) and Repartition(${probeSide.table} by ${probeSide.column})`;
  return {
    ok: true,
    build: { table: buildSide.table, column: buildSide.column, rows: buildSide.data.length },
    probe: { table: probeSide.table, column: probeSide.column, rows: probeSide.data.length },
    strategy: options.strategy,
    workers: n,
    traffic,
    held: { build: buildAt.map((r) => r.length), probe: probeAt.map((r) => r.length) },
    phases,
    moved: { exchange, gather: gatherIn, total: exchange + gatherIn },
    ticks,
    serialTicks,
    speedup: ticks === 0 ? 1 : serialTicks / ticks,
    count,
    counting,
    plan: `${how} → HashJoin on each worker (build ${buildSide.table}, probe ${probeSide.table}) → Gather${counting ? ' of partial counts' : ''}`,
  };
}
