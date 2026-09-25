// @vitest-environment node
/**
 * Every entry in the divergence ledger is *executed*, on both engines. See
 * `ledger.ts` for why: a difference is documented, pinned, and self-expiring.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runQuery } from '../src/engine/runQuery.ts';
import { DEFAULT_ENGINE_OPTIONS } from '../src/engine/types.ts';
import { toDatabase } from './harness.ts';
import { LEDGER } from './ledger.ts';
import type { Outcome, Raw } from './ledger.ts';
import { sqliteWith } from './sqlite.ts';

function queryLens(entry: (typeof LEDGER)[number]): Outcome {
  let tables = entry.tables;
  const last = entry.steps.length - 1;
  for (const [i, sql] of entry.steps.entries()) {
    const result = runQuery(sql, toDatabase(tables), DEFAULT_ENGINE_OPTIONS);
    if (result.error) return { error: result.error.message };
    if (i === last) return { rows: result.rows.map((r) => entry.columns.map((c) => r[c] ?? null)) };
    if (result.write) tables = tables.map((t) => (t.name === result.write!.table ? { ...t, rows: result.write!.rows } : t));
  }
  throw new Error(`ledger entry ${entry.id} has no steps`);
}

function sqlite(entry: (typeof LEDGER)[number]): Outcome {
  const db = sqliteWith(entry.tables);
  try {
    let rows: Raw[][] = [];
    for (const [i, sql] of entry.steps.entries()) {
      const statement = db.prepare(sql);
      if (i === entry.steps.length - 1) {
        statement.setReturnArrays(true);
        rows = statement.all() as unknown as Raw[][];
      } else {
        statement.run();
      }
    }
    return { rows };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  } finally {
    db.close();
  }
}

/** An expected error is matched by substring — the exact wording is not the contract. */
function matches(actual: Outcome, expected: Outcome): boolean {
  if ('error' in expected) return 'error' in actual && actual.error.includes(expected.error);
  return 'rows' in actual && JSON.stringify(actual.rows) === JSON.stringify(expected.rows);
}

describe('divergence ledger', () => {
  it('has unique ids', () => {
    expect(new Set(LEDGER.map((d) => d.id)).size).toBe(LEDGER.length);
  });

  for (const entry of LEDGER) {
    describe(entry.id, () => {
      const ql = queryLens(entry);
      const lite = sqlite(entry);

      it('QueryLens still answers as recorded', () => {
        expect(matches(ql, entry.expect.querylens), JSON.stringify(ql)).toBe(true);
      });

      it('SQLite still answers as recorded', () => {
        expect(matches(lite, entry.expect.sqlite), JSON.stringify(lite)).toBe(true);
      });

      it('and the two still differ — otherwise this entry is stale: delete it', () => {
        expect(JSON.stringify(ql)).not.toBe(JSON.stringify(lite));
      });
    });
  }
});

describe('the docs page carries the ledger', () => {
  // `answers.mdx` is the human-readable form; every id must appear in it, so the page cannot drift from the list.
  const page = readFileSync('src/pages/DocsContent/reference/answers.mdx', 'utf-8');
  for (const entry of LEDGER) {
    it(`mentions ${entry.id}`, () => {
      expect(page).toContain(entry.id);
    });
  }
});
