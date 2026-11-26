import { DEFAULT_DATASET, isDatasetId } from '../engine/index.ts';
import { isReplacementPolicyName } from '../engine/types.ts';
import type { Database, DatasetId, ReplacementPolicyName, Row, SqlValue, Table } from '../engine/index.ts';

/**
 * The address bar as the app's only persistence layer (plan.md §8, §15.2).
 *
 * A link reproduces a *moment*, not a home page: §9's study needs every
 * participant to start identically, §13's course packaging wants "predict what
 * happens at step 13" to be something you can set as homework, and until this
 * existed a refresh threw away an edited dataset with no warning.
 *
 * Everything here treats the URL as untrusted input. It is the one value in
 * this app that arrives from a stranger — someone opens a link another person
 * wrote — so every field is parsed defensively and anything unrecognised falls
 * back to the default rather than throwing.
 */
export interface ShareState {
  sql: string;
  policy: ReplacementPolicyName;
  predictOn: boolean;
  step: number;
  /** The preset dataset (plan.md §22.7); absent means the default (`users`). */
  dataset?: DatasetId;
  /** Present only when the rows differ from the seed set — the dataset's main table's (`d`). */
  rows?: Row[];
  /**
   * A multi-table preset's other tables whose rows differ from the seed (plan.md §27.5 S2), by name — each its own
   * `d.<table>` parameter, so a link to `shop` after a `DELETE FROM orders` still reproduces it.
   */
  otherRows?: Record<string, Row[]>;
  /**
   * Assignment mode (plan.md §20.5): the playhead cannot move past the
   * prediction at the landing step until it is answered, and the prompt has no
   * "skip". Set only by `/assignments/new`; absent on an ordinary link.
   */
  lockReveal?: boolean;
}

const PARAM = {
  sql: 'q',
  policy: 'p',
  predict: 'x',
  step: 's',
  rows: 'd',
  lock: 'l',
  dataset: 't',
} as const;

/**
 * The preset dataset a link names, or the default. Read on its own — before
 * `readShareState` — because the dataset decides which columns the `d` (rows)
 * blob is validated against.
 */
export function readDatasetParam(search: string): DatasetId {
  const raw = new URLSearchParams(search).get(PARAM.dataset);
  return isDatasetId(raw) ? raw : DEFAULT_DATASET;
}

// Caps, because the input is a link somebody else wrote. None of these is a
// security boundary — the engine is pure and there is nothing to inject — they
// just stop a hostile or corrupt link from hanging the tab.
const MAX_SQL = 2000;
const MAX_ROWS = 500;
const MAX_STRING = 200;
const MAX_STEP = 100_000;

function clampStep(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > MAX_STEP) return undefined;
  return n;
}

function parseValue(raw: unknown): SqlValue | undefined {
  if (raw === null) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') return raw.length <= MAX_STRING ? raw : undefined;
  return undefined;
}

/**
 * Rows travel as arrays of values, not objects: the column names are already
 * known from the table schema, and repeating them 48 times triples the link.
 */
function encodeRows(table: Table): string {
  return JSON.stringify(table.rows.map((row) => table.columns.map((c) => row[c] ?? null)));
}

function decodeRows(raw: string, columns: readonly string[]): Row[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || parsed.length > MAX_ROWS) return undefined;

  const rows: Row[] = [];
  for (const entry of parsed) {
    if (!Array.isArray(entry) || entry.length !== columns.length) return undefined;
    const row: Row = {};
    for (const [i, column] of columns.entries()) {
      const value = parseValue(entry[i]);
      if (value === undefined) return undefined;
      row[column] = value;
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Reads a shared moment out of a query string. Unknown fields are ignored. `columns` are the main table's; `others`,
 * a multi-table preset's other tables' columns by name (plan.md §27.5 S2) — a `d.<table>` naming none of them is ignored.
 */
export function readShareState(
  search: string,
  columns: readonly string[],
  others: Readonly<Record<string, readonly string[]>> = {},
): Partial<ShareState> {
  const params = new URLSearchParams(search);
  const state: Partial<ShareState> = {};

  const sql = params.get(PARAM.sql);
  if (sql !== null && sql.length > 0 && sql.length <= MAX_SQL) state.sql = sql;

  const policy = params.get(PARAM.policy);
  if (isReplacementPolicyName(policy)) state.policy = policy;

  const predict = params.get(PARAM.predict);
  if (predict === '0' || predict === '1') state.predictOn = predict === '1';

  const dataset = params.get(PARAM.dataset);
  if (isDatasetId(dataset)) state.dataset = dataset;

  // An assignment link forces prediction on regardless of `x` — the lock is
  // meaningless without it.
  if (params.get(PARAM.lock) === '1') {
    state.lockReveal = true;
    state.predictOn = true;
  }

  const step = clampStep(params.get(PARAM.step));
  if (step !== undefined) state.step = step;

  const rows = params.get(PARAM.rows);
  if (rows !== null) {
    const decoded = decodeRows(rows, columns);
    // A dataset that does not match the schema is dropped, not patched: a
    // half-restored table would produce a trace that is a lie.
    if (decoded !== undefined) state.rows = decoded;
  }

  for (const [name, tableColumns] of Object.entries(others)) {
    const raw = params.get(`${PARAM.rows}.${name}`);
    if (raw === null) continue;
    const decoded = decodeRows(raw, tableColumns);
    if (decoded !== undefined) state.otherRows = { ...state.otherRows, [name]: decoded };
  }

  return state;
}

/**
 * The query string for a moment, without the leading `?`. `table` is the main table, whose columns `rows` are encoded
 * by; `tables` holds the others (plan.md §27.5 S2), each of `otherRows` encoded by its own columns, in name order.
 */
export function encodeShareState(
  state: ShareState,
  table: Table | undefined,
  tables: Readonly<Record<string, Table>> = {},
): string {
  const params = new URLSearchParams();
  params.set(PARAM.sql, state.sql);
  params.set(PARAM.policy, state.policy);
  params.set(PARAM.predict, state.predictOn ? '1' : '0');
  params.set(PARAM.step, String(state.step));
  if (state.lockReveal) params.set(PARAM.lock, '1');
  // The default dataset is reproducible from code, like the seed rows — only a
  // non-default one goes in the link.
  if (state.dataset && state.dataset !== DEFAULT_DATASET) {
    params.set(PARAM.dataset, state.dataset);
  }
  // Only when customised (plan.md §15.2). The seed set is 48 rows and is
  // reproducible from the code, so putting it in every link would be 2 kB of
  // URL saying "unchanged".
  if (state.rows && table) params.set(PARAM.rows, encodeRows({ ...table, rows: state.rows }));
  for (const name of Object.keys(state.otherRows ?? {}).sort()) {
    const other = tables[name];
    const rows = state.otherRows?.[name];
    if (other && rows) params.set(`${PARAM.rows}.${name}`, encodeRows({ ...other, rows }));
  }
  return params.toString();
}

/** A preset's tables other than `main`, by name, with their columns — what `readShareState` checks `d.<table>` against (plan.md §27.5 S2). */
export function otherColumnsOf(seed: Database, main: string): Record<string, readonly string[]> {
  return Object.fromEntries(Object.entries(seed.tables).filter(([name]) => name !== main).map(([name, t]) => [name, t.columns]));
}

/**
 * A preset's seed database with edited rows put back — `main`'s from `rows`, and each other table's from `otherRows`
 * (plan.md §27.5 S2). How a link and a trace file restore the data they carry; a table with no edit keeps its seed.
 */
export function presetWithRows(
  seed: Database,
  main: string,
  rows: readonly Row[] | null | undefined,
  otherRows: Readonly<Record<string, Row[]>> = {},
): Database {
  const tables = { ...seed.tables };
  const edits: [string, readonly Row[] | null | undefined][] = [[main, rows], ...Object.entries(otherRows)];
  for (const [name, edited] of edits) {
    const table = tables[name];
    if (table && edited) tables[name] = { ...table, rows: [...edited] };
  }
  return { tables };
}

/**
 * Prompts before the restored step count as skipped.
 *
 * Opening a link at step 13 means the questions at steps 0–12 were never put to
 * this reader, so leaving their gates armed would freeze playback on a question
 * about something they have not seen. The prompt *at* the restored step stays
 * pending — that is the moment the link is pointing at.
 */
export function skippedAnswersBefore(
  events: readonly { id: number; predictable?: unknown }[],
  step: number,
): Record<number, string> {
  const answers: Record<number, string> = {};
  for (const event of events.slice(0, step)) {
    if (event.predictable !== undefined) answers[event.id] = '';
  }
  return answers;
}
