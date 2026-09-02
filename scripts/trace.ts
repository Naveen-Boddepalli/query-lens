/**
 * Dump a full QueryLens trace to the terminal.
 *
 *   pnpm trace                                        # default query
 *   pnpm trace "SELECT name FROM users WHERE age > 55"
 *   pnpm trace "SELECT * FROM users WHERE id = 5" clock
 *
 * The engine is a pure synchronous function with no DOM and no React, which is
 * exactly why this file can exist: the whole pipeline is `runQuery(sql, db)`.
 */

import { runQuery } from '../src/engine/runQuery.ts';
import { createSeedDatabase } from '../src/engine/seed.ts';
import { DEFAULT_ENGINE_OPTIONS, STAGES } from '../src/engine/types.ts';
import type { ReplacementPolicyName, StepEvent } from '../src/engine/types.ts';

const DEFAULT_SQL = 'SELECT * FROM users WHERE id = 5';

const sql = process.argv[2] ?? DEFAULT_SQL;
const policy = (process.argv[3] as ReplacementPolicyName | undefined) ?? 'lru';

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const COLOURS: Record<string, string> = {
  parse: '\x1b[36m', plan: '\x1b[35m', optimize: '\x1b[95m', execute: '\x1b[33m',
  buffer: '\x1b[32m', index: '\x1b[94m', lock: '\x1b[91m', result: '\x1b[96m',
};
const tag = (stage: string) =>
  `${COLOURS[stage] ?? ''}${stage.padEnd(8)}\x1b[0m`;

/** The one detail per event that is worth seeing at a glance. */
function detail(event: StepEvent): string {
  switch (event.stage) {
    case 'parse': return `ast(${String(countNodes(event.ast))} nodes)`;
    case 'plan': return planShape(event.planTree);
    case 'optimize': return `${event.rule}: ${planShape(event.before)} → ${planShape(event.after)}`;
    case 'execute': return `${event.op} → ${String(event.rowsProduced)} rows`;
    case 'buffer':
      if (event.action === 'sweep') return `sweep frame ${String(event.frameId)} → usage ${String(event.usageCountAfter)}`;
      if (event.action === 'evict') return `evict page ${String(event.victimPageId)} from frame ${String(event.frameId)}`;
      if (event.action === 'miss') return `miss page ${String(event.pageId)}`;
      return `${event.action} page ${String(event.pageId)} @ frame ${String(event.frameId)}`;
    case 'index': return event.action === 'open' ? `open (height ${String(event.height)})` : `${event.action} ${event.nodeId}`;
    case 'lock': return `${event.action} page ${String(event.pageId)} (${event.mode})`;
    case 'result': return `${String(event.rows.length)} rows`;
  }
}

function countNodes(node: { children?: unknown[] }): number {
  const kids = (node.children ?? []) as { children?: unknown[] }[];
  return 1 + kids.reduce((n, c) => n + countNodes(c), 0);
}

function planShape(node: { op: string; children?: unknown[] }): string {
  const kids = (node.children ?? []) as { op: string; children?: unknown[] }[];
  return kids.length === 0 ? node.op : `${node.op}→${kids.map(planShape).join(',')}`;
}

// --- run -------------------------------------------------------------------

console.log(`\n${bold('SQL')}     ${sql}`);
console.log(`${bold('Policy')}  ${policy}\n`);

const db = createSeedDatabase();
const { events, rows, error } = runQuery(sql, db, { ...DEFAULT_ENGINE_OPTIONS, policy });

if (error) {
  console.error(`\x1b[91m✗ ${error.message}\x1b[0m`);
  if (error.hint) console.error(dim(`  ${error.hint}`));
  if (error.from !== undefined) {
    console.error(dim(`  ${sql}`));
    console.error(dim(`  ${' '.repeat(error.from)}${'^'.repeat(Math.max(1, (error.to ?? error.from + 1) - error.from))}`));
  }
  process.exit(1);
}

for (const event of events) {
  const gate = event.predictable ? ' \x1b[95m[predict]\x1b[0m' : '';
  console.log(
    `${dim(String(event.id).padStart(3))}  ${tag(event.stage)} ${detail(event).padEnd(42)}${gate}`,
  );
  console.log(`     ${dim(event.label)}`);
}

// --- summary ---------------------------------------------------------------

const count = (fn: (e: StepEvent) => boolean) => events.filter(fn).length;
const reads = count((e) => e.stage === 'buffer' && e.action === 'load');
const hits = count((e) => e.stage === 'buffer' && e.action === 'hit');
const evictions = count((e) => e.stage === 'buffer' && e.action === 'evict');
const stagesSeen = STAGES.filter((s) => events.some((e) => e.stage === s));

console.log(`\n${bold('Summary')}`);
console.log(`  stages     ${stagesSeen.join(' → ')}`);
console.log(`  events     ${String(events.length)}`);
console.log(`  disk reads ${String(reads)}   hits ${String(hits)}   evictions ${String(evictions)}`);
console.log(`  prompts    ${String(count((e) => e.predictable !== undefined))}`);
console.log(`  rows       ${String(rows.length)}`);
if (rows.length > 0) {
  console.log(`  first      ${JSON.stringify(rows[0])}`);
}
console.log();
