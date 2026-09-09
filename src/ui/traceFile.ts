import { BUILD_SHA, BUILD_TIME } from '../buildInfo.ts';
import type { ReplacementPolicyName, Row, SqlValue } from '../engine/index.ts';

/**
 * plan.md §22.5: "Download this trace" / "load a trace from a file". This is the
 * reproducer the error boundary already assembles (§14.1 item 4, `errorReport.ts`),
 * lifted out of the crash path and made round-trippable — a small, readable JSON
 * that re-runs to the exact moment, for a bug report or a §9 study instrument.
 *
 * It deliberately carries **no `events`**: the engine is deterministic, so the
 * event stream re-derives from `sql` + `policy` + `rows`, and a second copy in
 * the file could only ever drift from what the running engine produces — the
 * §15.2 rule, one level up (never ship a half-restore that renders a trace that
 * is a lie). The raw event array is `/trace`'s "Copy JSON" when you need it
 * frozen.
 *
 * On the way in it is untrusted input, exactly like the shareable URL: every
 * field is checked and a mismatch fails the whole load rather than half-applying
 * it. The ceilings match `src/ui/urlState.ts` — same kind of stranger's input,
 * just larger and not clipped by an address bar.
 */

export const TRACE_FILE_KIND = 'querylens/playground-trace';
export const TRACE_FILE_VERSION = 1;

/** The state a trace file restores — the Playground's share state, plus nothing. */
export interface TraceState {
  sql: string;
  policy: ReplacementPolicyName;
  predictOn: boolean;
  step: number;
  /** `null` when the dataset is the untouched seed set (kept out, like the URL's `d`). */
  rows: Row[] | null;
}

interface TraceFile extends TraceState {
  kind: typeof TRACE_FILE_KIND;
  version: number;
  meta: {
    app: 'QueryLens';
    build: string;
    builtAt: string;
    exportedAt: string;
  };
}

const MAX_SQL = 2000;
const MAX_ROWS = 500;
const MAX_STRING = 200;
const MAX_STEP = 100_000;

/** The current Playground moment as the text of a `.json` file (trailing newline). */
export function serializeTraceFile(state: TraceState): string {
  const file: TraceFile = {
    kind: TRACE_FILE_KIND,
    version: TRACE_FILE_VERSION,
    sql: state.sql,
    policy: state.policy,
    predictOn: state.predictOn,
    step: state.step,
    rows: state.rows,
    meta: {
      app: 'QueryLens',
      build: BUILD_SHA,
      builtAt: BUILD_TIME,
      exportedAt: new Date().toISOString(),
    },
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

export type TraceParseResult =
  | { ok: true; value: TraceState }
  | { ok: false; error: string };

/** Parse a trace file's text. Total on any input; never throws. */
export function parseTraceFile(text: string, columns: readonly string[]): TraceParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'That file is not valid JSON.' };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'A trace file is a JSON object.' };
  }
  const o = raw as Record<string, unknown>;

  if (o.kind !== TRACE_FILE_KIND) {
    return { ok: false, error: 'That is not a QueryLens trace file.' };
  }
  if (o.version !== TRACE_FILE_VERSION) {
    return { ok: false, error: `Unsupported trace file version: ${String(o.version)}.` };
  }
  if (typeof o.sql !== 'string' || o.sql.length === 0 || o.sql.length > MAX_SQL) {
    return { ok: false, error: 'The "sql" field is missing or too long.' };
  }
  if (o.policy !== 'lru' && o.policy !== 'clock') {
    return { ok: false, error: 'The "policy" field must be "lru" or "clock".' };
  }
  if (typeof o.predictOn !== 'boolean') {
    return { ok: false, error: 'The "predictOn" field must be true or false.' };
  }
  if (
    typeof o.step !== 'number' ||
    !Number.isInteger(o.step) ||
    o.step < 0 ||
    o.step > MAX_STEP
  ) {
    return { ok: false, error: 'The "step" field must be a whole number ≥ 0.' };
  }

  let rows: Row[] | null = null;
  if (o.rows !== null && o.rows !== undefined) {
    const decoded = decodeRows(o.rows, columns);
    if (decoded === null) {
      return { ok: false, error: 'The "rows" do not match the users table schema.' };
    }
    rows = decoded;
  }

  return {
    ok: true,
    value: { sql: o.sql, policy: o.policy, predictOn: o.predictOn, step: o.step, rows },
  };
}

/**
 * Rows as an array of objects keyed by column — readable in the file, unlike the
 * URL's positional form. A row with a missing column, an extra key (a typo'd
 * column name), or a value of the wrong shape fails the whole file.
 */
function decodeRows(raw: unknown, columns: readonly string[]): Row[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_ROWS) return null;

  const rows: Row[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null;
    const src = entry as Record<string, unknown>;
    if (Object.keys(src).length !== columns.length) return null;

    const row: Row = {};
    for (const column of columns) {
      const value = parseValue(src[column]);
      if (value === undefined) return null;
      row[column] = value;
    }
    rows.push(row);
  }
  return rows;
}

function parseValue(raw: unknown): SqlValue | undefined {
  if (raw === null) return null;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined;
  if (typeof raw === 'string') return raw.length <= MAX_STRING ? raw : undefined;
  return undefined;
}
