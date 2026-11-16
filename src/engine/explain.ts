/**
 * `EXPLAIN [ANALYZE] SELECT …` as a statement (plan.md §25.4 B6) — the in-app
 * EXPLAIN that used to be only a button, now something you can *type*, and
 * whose answer is a result you can read, copy and share like any other.
 *
 *   EXPLAIN          plans and optimises the query and shows the plan with the
 *                    cost model's estimate for every operator. **Nothing is
 *                    read** — the trace stops before the executor, exactly as
 *                    a real EXPLAIN never touches the data.
 *   EXPLAIN ANALYZE  runs the query for real (the trace *is* that run) and puts
 *                    the executor's actual row count beside each estimate, then
 *                    the buffer pool's hits, misses and evictions. It reports
 *                    no timings: this engine makes no claim about latency (§12).
 *
 * Built on the ordinary run of the inner query, so the plan shown is exactly
 * the plan that would execute. The `EXPLAIN [ANALYZE]` prefix is replaced by
 * spaces before that run, which keeps every span the inner statement reports
 * (the editor's squiggles, the parse tree's highlights) pointing at the text
 * the user actually typed.
 */

import type { ExplainStatement } from './parser/index.ts';
import { createTracer } from './trace.ts';
import type { PlanNode, RunResult, StepEvent } from './types.ts';

export const EXPLAIN_COLUMN = 'QUERY PLAN';

/** The optimizer's final plan: the last rewrite's `after`, or the canonical plan if nothing rewrote it. */
export function finalPlan(events: readonly StepEvent[]): PlanNode | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.stage === 'optimize') return e.after;
    if (e.stage === 'plan') return e.planTree;
  }
  return null;
}

/**
 * `max(est/act, act/est)`, Leis et al.'s own metric for cardinality-estimation error (plan.md §25.4 C2;
 * RESEARCH.md §41) — `1` is a perfect guess, `10` an estimate ten times too high or too low, whichever direction
 * it missed. Both sides get the literature's own `+1` smoothing, so a `0` estimate or a `0` actual row count is
 * still a real, finite number rather than a division by zero.
 */
export function qError(estRows: number, actualRows: number): number {
  return Math.max((estRows + 1) / (actualRows + 1), (actualRows + 1) / (estRows + 1));
}

/**
 * The key `actual` (below) is built and read by: `op` alone collides whenever a plan has two nodes of the same
 * kind — a multi-join chain's several `SeqScan`s or several `Join`s (plan.md §25.4 C3 slice b flagged this as a
 * real, pre-existing bug) — so every row this engine ever produces for one of them would be misreported onto
 * all the others sharing that `op`. `table` (a scan's own table, or a `Join`'s `rightTable`) is always enough to
 * tell them apart, since the parser never lets a query name the same table twice.
 */
export function nodeKey(op: string, table: string | undefined): string {
  return table === undefined ? op : `${op}:${table}`;
}

/** One line per operator, PostgreSQL-shaped: the root, then `->` for each level beneath it. */
function planLines(root: PlanNode, actual: ReadonlyMap<string, number> | null): string[] {
  const lines: string[] = [];
  const walk = (node: PlanNode, depth: number): void => {
    const parts: string[] = [];
    if (node.estRows !== undefined) parts.push(`est ~${String(node.estRows)} rows`);
    const rows = actual?.get(nodeKey(node.op, node.table));
    if (rows !== undefined) {
      parts.push(`actual ${String(rows)} rows`);
      // Below 2× is well within the noise a real optimizer lives with every day — naming it would just be clutter.
      if (node.estRows !== undefined) {
        const q = qError(node.estRows, rows);
        if (q >= 2) parts.push(`q-error ${q.toFixed(1)}×`);
      }
    }
    const indent = depth === 0 ? '' : `${'      '.repeat(depth - 1)}  ->  `;
    const text = node.detail ? `${node.label}  ${node.detail}` : node.label;
    lines.push(`${indent}${text}${parts.length > 0 ? `  (${parts.join('; ')})` : ''}`);
    (node.children ?? []).forEach((child) => { walk(child, depth + 1); });
  };
  walk(root, 0);
  return lines;
}

export function explainResult(sql: string, ast: ExplainStatement, run: (sql: string) => RunResult): RunResult {
  const inner = run(' '.repeat(ast.select.span.from) + sql.slice(ast.select.span.from));
  if (inner.error) return inner;

  const plan = finalPlan(inner.events);
  if (!plan) return { events: inner.events, rows: [] };

  // What ran, per operator: the largest count it reported. Bookkeeping events (a discarded candidate, a hash build
  // announcement) can carry a 0 that lands after the real count has grown, so the last event is not always the total.
  const actual = new Map<string, number>();
  for (const e of inner.events) {
    if (e.stage !== 'execute') continue;
    const key = nodeKey(e.op, e.table);
    actual.set(key, Math.max(actual.get(key) ?? 0, e.rowsProduced));
  }

  const lines = planLines(plan, ast.analyze ? actual : null);
  if (ast.analyze) {
    const count = (action: 'hit' | 'miss' | 'evict') =>
      inner.events.filter((e) => e.stage === 'buffer' && e.action === action).length;
    lines.push(
      `Result: ${String(inner.rows.length)} row${inner.rows.length === 1 ? '' : 's'}`,
      `Buffer pool: ${String(count('hit'))} hit${count('hit') === 1 ? '' : 's'}, ${String(count('miss'))} miss${count('miss') === 1 ? '' : 'es'}, ${String(count('evict'))} eviction${count('evict') === 1 ? '' : 's'}`,
    );
  }
  const rows = lines.map((line) => ({ [EXPLAIN_COLUMN]: line }));

  // Plain EXPLAIN stops before the executor; EXPLAIN ANALYZE keeps the whole run but replaces its result.
  const kept = inner.events.filter((e) =>
    ast.analyze ? e.stage !== 'result' : e.stage === 'parse' || e.stage === 'plan' || e.stage === 'optimize',
  );
  const { emit, drain } = createTracer();
  for (const e of kept) {
    const { id: _id, label, predictable, dwell, ...body } = e;
    emit(label, body, {
      ...(predictable ? { predictable } : {}),
      ...(dwell === undefined ? {} : { dwell }),
    });
  }
  emit(
    ast.analyze
      ? `EXPLAIN ANALYZE ran the query for real — the trace above is that run — and reports the cost model's estimate next to the executor's actual row count for every operator, then what the buffer pool did.`
      : `EXPLAIN shows the plan the optimizer chose and the cost model's estimate for each operator. Nothing was executed and no page was read — that is what separates EXPLAIN from EXPLAIN ANALYZE.`,
    { stage: 'result', rows },
  );

  return { events: drain(), rows };
}
