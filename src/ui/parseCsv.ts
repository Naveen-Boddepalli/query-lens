import type { Row, SqlValue, Table } from '../engine/index.ts';

/**
 * plan.md §22.7: paste a block of CSV into the seed-data editor instead of
 * typing 48 rows. Pasted text is untrusted input — the §15.2 rule the URL
 * follows applies here too — so this is bounded and total: it never throws, and
 * a malformed block is rejected whole with a reason rather than half-imported.
 *
 * A small RFC-4180-ish reader: `,` separates fields, `"` quotes a field (with
 * `""` for a literal quote and commas/newlines allowed inside), and a row is a
 * newline. A leading row that matches the column names is treated as a header.
 */

const MAX_ROWS = 500;
const MAX_STRING = 200;

export type CsvParseResult =
  | { ok: true; rows: Row[] }
  | { ok: false; error: string };

/** Tokenise CSV text into rows of raw string fields. */
function readRecords(text: string): string[][] {
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  let i = 0;

  const pushField = () => { record.push(field); field = ''; };
  const pushRecord = () => { pushField(); records.push(record); record = []; };

  while (i < text.length) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') { inQuotes = true; i += 1; continue; }
    if (ch === ',') { pushField(); i += 1; continue; }
    if (ch === '\r') { i += 1; continue; }
    if (ch === '\n') { pushRecord(); i += 1; continue; }
    field += ch;
    i += 1;
  }
  // Trailing field/record with no closing newline.
  if (field !== '' || record.length > 0) pushRecord();

  return records;
}

export function parseSeedCsv(text: string, table: Table): CsvParseResult {
  const columns = table.columns;
  const sample = table.rows[0];

  const records = readRecords(text).filter(
    (r) => r.some((f) => f.trim() !== ''), // drop blank lines
  );
  if (records.length === 0) return { ok: false, error: 'That is empty.' };

  // A leading header row that names the columns (in any order-insensitive
  // case) is skipped; otherwise every record is data.
  const first = records[0]!.map((f) => f.trim().toLowerCase());
  const looksLikeHeader =
    first.length === columns.length &&
    columns.every((c) => first.includes(c.toLowerCase()));
  const dataRows = looksLikeHeader ? records.slice(1) : records;

  if (dataRows.length === 0) return { ok: false, error: 'No data rows — only a header.' };
  if (dataRows.length > MAX_ROWS) {
    return { ok: false, error: `Too many rows (${String(dataRows.length)}; the limit is ${String(MAX_ROWS)}).` };
  }

  const rows: Row[] = [];
  for (const [index, record] of dataRows.entries()) {
    if (record.length !== columns.length) {
      return {
        ok: false,
        error: `Row ${String(index + 1)} has ${String(record.length)} field${
          record.length === 1 ? '' : 's'
        }, expected ${String(columns.length)}.`,
      };
    }
    const row: Row = {};
    for (const [c, column] of columns.entries()) {
      const raw = record[c]!.trim();
      const wantsNumber = typeof sample?.[column] === 'number';
      const value = coerce(raw, wantsNumber);
      if (value === undefined) {
        return { ok: false, error: `Row ${String(index + 1)}, column "${column}": "${raw}" is not a number.` };
      }
      row[column] = value;
    }
    rows.push(row);
  }
  return { ok: true, rows };
}

function coerce(raw: string, wantsNumber: boolean): SqlValue | undefined {
  if (raw === '') return null;
  if (wantsNumber) {
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  }
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return raw.length <= MAX_STRING ? raw : raw.slice(0, MAX_STRING);
}
