#!/usr/bin/env -S node --experimental-strip-types
/**
 * `@querylens/mcp` (plan.md §25.4 H4) — the engine, over MCP, for the user's own coding assistant. `run_query`,
 * `explain_trace` and `compare_policies` each call the same pure `runQuery` the app and the `querylens` CLI do —
 * there is no separate "explain what a B+Tree does" prompt an assistant could hallucinate past; every answer is
 * a real trace of a real (if deliberately simplified) engine actually running the query, the same grounding
 * plan.md §22.8 already gives the CLI.
 *
 * Runs locally over stdio, started by the assistant's own MCP client — there is no hosted service (RESEARCH.md
 * §44: a hosted server would need to run arbitrary user SQL against something, and a toy in-memory engine with no
 * auth is not a thing to expose to the internet). Not yet published as `@querylens/mcp` — see plan.md §25.4 H3:
 * publishing needs the same npm organisation and trusted-publishing setup this file's own package does.
 *
 *   pnpm mcp
 *
 * Point an MCP-capable assistant at `node --experimental-strip-types mcp/server.ts` (a local build's `dist/`
 * equivalent, once H3 lands) to try it before then.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  DATASET_IDS,
  DATASETS,
  DEFAULT_ENGINE_OPTIONS,
  runQuery,
} from '../src/engine/index.ts';
import type { Database, DatasetId, ReplacementPolicyName, RunResult, StepEvent } from '../src/engine/index.ts';

/** `users (id, name, email, age) · orders (id, customer, total, status) · logins (id, user, status, attempts)` — built once, so every tool's description and every call reads the real column list, not a hand-typed copy that could drift. */
function datasetCatalogue(): { line: string; tables: Record<DatasetId, Database> } {
  const tables = Object.fromEntries(DATASET_IDS.map((id) => [id, DATASETS[id].make()])) as Record<DatasetId, Database>;
  const line = DATASET_IDS.map((id) => {
    const table = tables[id].tables[DATASETS[id].table];
    return `${id} (${table.columns.join(', ')}, ${String(table.rows.length)} rows)`;
  }).join(' · ');
  return { line, tables };
}

const { line: DATASET_LINE, tables: DATASET_DB } = datasetCatalogue();

const datasetSchema = z
  .enum(DATASET_IDS as [DatasetId, ...DatasetId[]])
  .default('users')
  .describe(`Which preset table to query. ${DATASET_LINE}`);
const policySchema = z
  .enum(['lru', 'clock'] as [ReplacementPolicyName, ...ReplacementPolicyName[]])
  .default('lru')
  .describe('Buffer-pool eviction policy for this run — changes the trace, never the rows.');

/** Counts of one buffer-pool action across a trace. */
function count(events: readonly StepEvent[], action: 'hit' | 'load' | 'evict'): number {
  return events.filter((e) => e.stage === 'buffer' && e.action === action).length;
}

/** What a tool hands back for a run that reached a result: never the raw event array (large, and shaped for a UI
 *  timeline) — the narration a person reading the Playground's own step list would see, plus the counts a real
 *  engine's EXPLAIN ANALYZE reports. */
function summarize(result: RunResult) {
  if (result.error) return { error: result.error };
  return {
    rows: result.rows,
    rowCount: result.rows.length,
    diskReads: count(result.events, 'load'),
    bufferHits: count(result.events, 'hit'),
    evictions: count(result.events, 'evict'),
    narration: result.events.map((e) => e.label),
  };
}

const server = new McpServer({ name: 'querylens', version: '0.1.0' });

server.registerTool(
  'run_query',
  {
    description:
      `Run a SQL query against a QueryLens preset table and return the real rows and the engine's own step-by-step ` +
      `narration (parse → plan → optimize → execute → buffer pool → B+Tree → result) — grounded in an actual pure, ` +
      `synchronous engine run, not a description of one. Datasets: ${DATASET_LINE}. Supported SQL is a deliberate ` +
      `subset (one table, one optional JOIN, no subqueries) — an unsupported statement returns a parse error, not a guess.`,
    inputSchema: { sql: z.string().describe('The SQL statement to run.'), dataset: datasetSchema, policy: policySchema },
  },
  ({ sql, dataset, policy }) => {
    const result = runQuery(sql, DATASET_DB[dataset], { ...DEFAULT_ENGINE_OPTIONS, policy });
    return { content: [{ type: 'text', text: JSON.stringify(summarize(result), null, 2) }] };
  },
);

server.registerTool(
  'explain_trace',
  {
    description:
      `The query plan QueryLens's optimizer chooses, PostgreSQL-shaped (one line per operator, an estimate beside ` +
      `each). With analyze (the default), the query actually runs and the executor's real row count and the buffer ` +
      `pool's hit/miss/eviction counts sit next to the estimate, exactly like a real database's EXPLAIN ANALYZE; ` +
      `without it, nothing is read — only the plan and its estimates. Datasets: ${DATASET_LINE}.`,
    inputSchema: {
      sql: z.string().describe('The SELECT statement to explain.'),
      dataset: datasetSchema,
      policy: policySchema,
      analyze: z.boolean().default(true).describe('Run the query for real and show actual rows/buffer-pool counts beside the estimate.'),
    },
  },
  ({ sql, dataset, policy, analyze }) => {
    const result = runQuery(`EXPLAIN ${analyze ? 'ANALYZE ' : ''}${sql}`, DATASET_DB[dataset], { ...DEFAULT_ENGINE_OPTIONS, policy });
    const text = result.error ? JSON.stringify({ error: result.error }, null, 2) : result.rows.map((r) => r['QUERY PLAN']).join('\n');
    return { content: [{ type: 'text', text }] };
  },
);

server.registerTool(
  'compare_policies',
  {
    description:
      `Runs the same query twice, once under each buffer-pool eviction policy (LRU and clock sweep), and reports ` +
      `each run's disk reads, buffer hits and evictions side by side — the same comparison /compare's "Policies" ` +
      `mode makes on the site, over real counters from two real runs, never a guess about which policy wins. ` +
      `Datasets: ${DATASET_LINE}.`,
    inputSchema: { sql: z.string().describe('The SQL statement to run under both policies.'), dataset: datasetSchema },
  },
  ({ sql, dataset }) => {
    const runs = (['lru', 'clock'] as const).map((policy) => [policy, summarize(runQuery(sql, DATASET_DB[dataset], { ...DEFAULT_ENGINE_OPTIONS, policy }))] as const);
    return { content: [{ type: 'text', text: JSON.stringify(Object.fromEntries(runs), null, 2) }] };
  },
);

export { server };

// Only connect a real transport when run directly — a test imports `server` without starting stdio.
if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  await server.connect(new StdioServerTransport());
}
