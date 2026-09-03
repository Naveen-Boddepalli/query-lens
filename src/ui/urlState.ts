import type { ReplacementPolicyName, Row, SqlValue, Table } from '../engine/index.ts';

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
  /** Present only when the rows differ from the seed set. */
  rows?: Row[];
}

const PARAM = {
  sql: 'q',
  policy: 'p',
  predict: 'x',
  step: 's',
  rows: 'd',
} as const;

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

/** Reads a shared moment out of a query string. Unknown fields are ignored. */
export function readShareState(
  search: string,
  columns: readonly string[],
): Partial<ShareState> {
  const params = new URLSearchParams(search);
  const state: Partial<ShareState> = {};

  const sql = params.get(PARAM.sql);
  if (sql !== null && sql.length > 0 && sql.length <= MAX_SQL) state.sql = sql;

  const policy = params.get(PARAM.policy);
  if (policy === 'lru' || policy === 'clock') state.policy = policy;

  const predict = params.get(PARAM.predict);
  if (predict === '0' || predict === '1') state.predictOn = predict === '1';

  const step = clampStep(params.get(PARAM.step));
  if (step !== undefined) state.step = step;

  const rows = params.get(PARAM.rows);
  if (rows !== null) {
    const decoded = decodeRows(rows, columns);
    // A dataset that does not match the schema is dropped, not patched: a
    // half-restored table would produce a trace that is a lie.
    if (decoded !== undefined) state.rows = decoded;
  }

  return state;
}

/** The query string for a moment, without the leading `?`. */
export function encodeShareState(state: ShareState, table: Table | undefined): string {
  const params = new URLSearchParams();
  params.set(PARAM.sql, state.sql);
  params.set(PARAM.policy, state.policy);
  params.set(PARAM.predict, state.predictOn ? '1' : '0');
  params.set(PARAM.step, String(state.step));
  // Only when customised (plan.md §15.2). The seed set is 48 rows and is
  // reproducible from the code, so putting it in every link would be 2 kB of
  // URL saying "unchanged".
  if (state.rows && table) params.set(PARAM.rows, encodeRows({ ...table, rows: state.rows }));
  return params.toString();
}

/**
 * Writes the moment into the address bar.
 *
 * `replaceState`, never `pushState`: stepping a 33-event trace would otherwise
 * bury the previous page under 33 history entries and make Back useless.
 */
export function writeShareState(query: string): void {
  if (typeof history === 'undefined') return;
  const next = `${location.pathname}${query ? `?${query}` : ''}${location.hash}`;
  if (next === `${location.pathname}${location.search}${location.hash}`) return;
  history.replaceState(history.state, '', next);
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
