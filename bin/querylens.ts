#!/usr/bin/env -S node --experimental-strip-types
/**
 * `querylens` — trace a SQL query through the QueryLens engine, on the terminal.
 *
 * plan.md §22.8: the engine is a pure, synchronous, React-free function
 * (`runQuery`), so a CLI is a thin wrapper over it. This replaces the old
 * `scripts/trace.ts` debug dumper with a packaged shape: named flags, the three
 * preset datasets (§22.7), a `--json` mode for scripting, and `NO_COLOR` support.
 * `pnpm trace` and `pnpm querylens` both run it.
 *
 *   querylens "SELECT * FROM users WHERE id = 5"
 *   querylens "SELECT * FROM orders WHERE total > 500" --dataset orders --policy clock
 *   querylens "SELECT * FROM users WHERE age > 30" --json
 *
 * Publishing it to npm (a `dist/` build so it runs without --experimental-strip-types,
 * a `files` allow-list, `npm publish`) is the one remaining step and a deliberate
 * one — this file is the whole implementation.
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  runQuery,
  DATASETS,
  DATASET_IDS,
  DEFAULT_ENGINE_OPTIONS,
  REPLACEMENT_POLICY_NAMES,
  STAGES,
} from '../src/engine/index.ts';
import type { DatasetId, ReplacementPolicyName, RunResult, StepEvent } from '../src/engine/index.ts';

interface Options {
  sql: string;
  policy: ReplacementPolicyName;
  dataset: DatasetId;
  json: boolean;
  color: boolean;
}

export type ParseResult =
  | { kind: 'run'; options: Options }
  | { kind: 'help'; text: string }
  | { kind: 'error'; message: string };

const HELP = `querylens — trace a SQL query through the QueryLens engine

Usage:
  querylens "<SQL>" [options]

Options:
  --policy <name>     buffer replacement policy: ${REPLACEMENT_POLICY_NAMES.join(', ')} (default: lru)
  --dataset <name>    preset table: ${DATASET_IDS.join(', ')} (default: users)
  --json             emit the trace as JSON instead of text
  --no-color         disable ANSI colour (also respects the NO_COLOR env var)
  -h, --help         show this help

Examples:
  querylens "SELECT * FROM users WHERE id = 5"
  querylens "SELECT * FROM orders WHERE total > 500" --dataset orders --policy clock
  querylens "SELECT * FROM users WHERE age > 30" --json
`;

export function parseArgs(
  argv: readonly string[],
  env: Record<string, string | undefined> = {},
  isTTY = false,
): ParseResult {
  if (argv.length === 0 || argv.includes('-h') || argv.includes('--help')) {
    return { kind: 'help', text: HELP };
  }

  const positionals: string[] = [];
  let policy: ReplacementPolicyName = 'lru';
  let dataset: DatasetId = 'users';
  let json = false;
  // Colour only when attached to a terminal and NO_COLOR is not set.
  let color = isTTY && (env.NO_COLOR === undefined || env.NO_COLOR === '');

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') { json = true; continue; }
    if (arg === '--no-color') { color = false; continue; }
    if (arg === '--policy' || arg === '--dataset') {
      const value = argv[++i];
      if (value === undefined) return { kind: 'error', message: `${arg} needs a value.` };
      if (arg === '--policy') {
        if (!(REPLACEMENT_POLICY_NAMES as readonly string[]).includes(value)) {
          return { kind: 'error', message: `Unknown policy "${value}". One of: ${REPLACEMENT_POLICY_NAMES.join(', ')}.` };
        }
        policy = value as ReplacementPolicyName;
      } else {
        if (!(DATASET_IDS as readonly string[]).includes(value)) {
          return { kind: 'error', message: `Unknown dataset "${value}". One of: ${DATASET_IDS.join(', ')}.` };
        }
        dataset = value as DatasetId;
      }
      continue;
    }
    if (arg.startsWith('--')) return { kind: 'error', message: `Unknown option "${arg}". Try --help.` };
    positionals.push(arg);
  }

  if (positionals.length === 0) return { kind: 'error', message: 'No SQL query given. Try --help.' };
  if (positionals.length > 1) {
    return { kind: 'error', message: 'Give the query as a single quoted argument.' };
  }

  return { kind: 'run', options: { sql: positionals[0], policy, dataset, json, color } };
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                   */
/* -------------------------------------------------------------------------- */

const STAGE_COLOUR: Record<string, string> = {
  parse: '36', plan: '35', optimize: '95', execute: '33',
  buffer: '32', index: '94', lock: '91', result: '96',
};

function paint(on: boolean) {
  return (code: string, s: string) => (on ? `\x1b[${code}m${s}\x1b[0m` : s);
}

/** The one detail per event worth seeing at a glance. */
function detail(event: StepEvent): string {
  switch (event.stage) {
    case 'parse': return `ast(${String(countNodes(event.ast))} nodes)`;
    case 'plan': return planShape(event.planTree);
    case 'optimize': return `${event.rule}: ${planShape(event.before)} -> ${planShape(event.after)}`;
    case 'execute': return `${event.op} -> ${String(event.rowsProduced)} rows`;
    case 'buffer':
      if (event.action === 'sweep') return `sweep frame ${String(event.frameId)} -> usage ${String(event.usageCountAfter)}`;
      if (event.action === 'evict') return `evict page ${String(event.victimPageId)} from frame ${String(event.frameId)}`;
      if (event.action === 'miss') return `miss page ${String(event.pageId)}`;
      if (event.action === 'log') return `log LSN ${String(event.lsn)} page ${String(event.pageId)}`;
      if (event.action === 'flush') return `flush log through LSN ${String(event.lsn)} before page ${String(event.pageId)}`;
      return `${event.action} page ${String(event.pageId)} @ frame ${String(event.frameId)}`;
    case 'index':
      return event.action === 'open'
        ? `open (height ${String(event.height)})`
        : event.action === 'chain-next'
          ? `chain-next ${event.fromNodeId} -> ${event.toNodeId}`
          : `${event.action} ${event.nodeId}`;
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
  return kids.length === 0 ? node.op : `${node.op}(${kids.map(planShape).join(',')})`;
}

function summary(result: RunResult) {
  const count = (fn: (e: StepEvent) => boolean) => result.events.filter(fn).length;
  return {
    stages: STAGES.filter((s) => result.events.some((e) => e.stage === s)),
    events: result.events.length,
    diskReads: count((e) => e.stage === 'buffer' && e.action === 'load'),
    hits: count((e) => e.stage === 'buffer' && e.action === 'hit'),
    evictions: count((e) => e.stage === 'buffer' && e.action === 'evict'),
    prompts: count((e) => e.predictable !== undefined),
    rows: result.rows.length,
  };
}

export function renderText(opts: Options, result: RunResult): string {
  const c = paint(opts.color);
  const head = `${c('1', opts.sql.replace(/\s+/g, ' ').trim())}  ${c('2', '·')}  ${opts.policy}  ${c('2', '·')}  ${opts.dataset}`;

  if (result.error) {
    const lines = [head, '', c('91', `error  ${result.error.message}`)];
    if (result.error.hint) lines.push(c('2', `       ${result.error.hint}`));
    return lines.join('\n');
  }

  const body = result.events.map((e) => {
    const tag = c(STAGE_COLOUR[e.stage] ?? '0', e.stage.padEnd(8));
    const gate = e.predictable ? ` ${c('95', '[predict]')}` : '';
    return `  ${c('2', String(e.id).padStart(3))}  ${tag} ${detail(e).padEnd(40)}${gate}\n       ${c('2', e.label)}`;
  });

  const s = summary(result);
  const foot =
    `  ${s.stages.length} stages · ${s.events} events · ${s.diskReads} disk reads · ` +
    `${s.hits} hits · ${s.evictions} evictions · ${s.prompts} prompts · ` +
    `${s.rows} row${s.rows === 1 ? '' : 's'}`;

  return [head, '', ...body, '', c('1', foot)].join('\n');
}

export function renderJson(opts: Options, result: RunResult): string {
  return JSON.stringify(
    {
      sql: opts.sql,
      policy: opts.policy,
      dataset: opts.dataset,
      ...(result.error ? { error: result.error } : { rows: result.rows, summary: summary(result), events: result.events }),
    },
    null,
    2,
  );
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                 */
/* -------------------------------------------------------------------------- */

/** Runs the CLI. Returns the process exit code; does the I/O itself. */
export function main(
  argv: readonly string[],
  out: (s: string) => void = (s) => process.stdout.write(`${s}\n`),
  err: (s: string) => void = (s) => process.stderr.write(`${s}\n`),
): number {
  const parsed = parseArgs(argv, process.env, process.stdout.isTTY === true);
  if (parsed.kind === 'help') { out(parsed.text); return 0; }
  if (parsed.kind === 'error') { err(parsed.message); return 2; }

  const { options } = parsed;
  const result = runQuery(options.sql, DATASETS[options.dataset].make(), {
    ...DEFAULT_ENGINE_OPTIONS,
    policy: options.policy,
  });

  out(options.json ? renderJson(options, result) : renderText(options, result));
  return result.error ? 1 : 0;
}

/** True when this module is the program's entry point. npm runs a bin through a symlink, so the path is resolved first. */
function invokedDirectly(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === fileURLToPath(moduleUrl);
  } catch {
    return false;
  }
}

// Only run when invoked directly, not when imported by a test.
if (invokedDirectly(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
