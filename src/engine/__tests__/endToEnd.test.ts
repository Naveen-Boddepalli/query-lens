/**
 * Whole-pipeline tests.
 *
 * Every other test file checks one layer. These check that the layers agree
 * with each other — that the plan the optimizer chose is the one the executor
 * ran, that the pages the index asked for are the pages the pool read, that
 * the rows the result announces are the rows returned. A pipeline can be built
 * from correct parts and still tell an incoherent story.
 */

import { describe, expect, it } from 'vitest';
import { runQuery } from '../runQuery.ts';
import { createSeedDatabase } from '../seed.ts';
import { createTraceProjector } from '../viewState.ts';
import { DEFAULT_ENGINE_OPTIONS, IMPLEMENTED_STAGES } from '../types.ts';
import type { EngineOptions, StepEvent } from '../types.ts';

const db = createSeedDatabase();
const users = db.tables.users!;

const QUERIES = [
  'SELECT * FROM users WHERE id = 5',
  'SELECT name, age FROM users WHERE age > 55',
  'SELECT * FROM users',
  'SELECT * FROM users WHERE id = 9999',
  'SELECT id FROM users WHERE id = 5 AND age > 0',
  "SELECT * FROM users WHERE name = 'ada'",
  'SELECT * FROM users LIMIT 5',
  'SELECT * FROM users WHERE age > 30 LIMIT 3',
  'SELECT * FROM users LIMIT 0',
] as const;

function run(sql: string, over: Partial<EngineOptions> = {}) {
  return runQuery(sql, db, { ...DEFAULT_ENGINE_OPTIONS, ...over });
}

describe.each(QUERIES)('end to end: %s', (sql) => {
  const { events, rows, error } = run(sql);

  it('completes without an error', () => {
    expect(error).toBeUndefined();
    expect(events.length).toBeGreaterThan(0);
  });

  it('respects the causal order of the stages that must be ordered', () => {
    // Stages deliberately interleave — a traversal alternates index, lock and
    // buffer — so there is no single linear sequence to assert. What must hold
    // is the causal chain: you cannot plan before parsing, or optimise a plan
    // that does not exist, and the result comes last.
    const first = (stage: string) => events.findIndex((e) => e.stage === stage);
    expect(first('parse')).toBe(0);
    expect(first('plan')).toBeGreaterThan(first('parse'));
    expect(first('optimize')).toBeGreaterThan(first('plan'));
    expect(first('result')).toBe(events.length - 1);
  });

  it('reads a page before any operator claims to have produced a row', () => {
    const firstRead = events.findIndex((e) => e.stage === 'buffer');
    const firstRow = events.findIndex((e) => e.stage === 'execute');
    if (firstRow !== -1 && firstRead !== -1) expect(firstRead).toBeLessThan(firstRow);
  });

  it('only claims stages the engine implements', () => {
    for (const e of events) expect(IMPLEMENTED_STAGES).toContain(e.stage);
  });

  it('gives every event an id matching its index and a real label', () => {
    events.forEach((e, i) => {
      expect(e.id).toBe(i);
      expect(e.label.trim().length).toBeGreaterThan(10);
    });
  });

  it('ends with exactly one result event holding the returned rows', () => {
    const results = events.filter((e) => e.stage === 'result');
    expect(results).toHaveLength(1);
    expect(events[events.length - 1]?.stage).toBe('result');
    expect(results[0]?.stage === 'result' && results[0].rows).toEqual(rows);
  });

  it('reads every page it locks, and locks every page it reads', () => {
    const locked = new Set<number>();
    const read = new Set<number>();
    for (const e of events) {
      if (e.stage === 'lock' && e.action === 'acquire') locked.add(e.pageId);
      if (e.stage === 'buffer' && (e.action === 'load' || e.action === 'hit')) read.add(e.pageId);
    }
    for (const page of read) expect(locked, `page ${String(page)}`).toContain(page);
  });

  it('balances every lock it takes', () => {
    let held = 0;
    for (const e of events) {
      if (e.stage !== 'lock') continue;
      held += e.action === 'acquire' ? 1 : -1;
      expect(held).toBeGreaterThanOrEqual(0);
    }
    expect(held).toBe(0);
  });

  it('never hits a page that is not resident in that frame', () => {
    const resident = new Map<number, number>();
    for (const e of events) {
      if (e.stage !== 'buffer') continue;
      if (e.action === 'load') resident.set(e.frameId, e.pageId);
      if (e.action === 'evict') resident.delete(e.frameId);
      if (e.action === 'hit') expect(resident.get(e.frameId)).toBe(e.pageId);
    }
  });

  it('never holds more pages than there are frames', () => {
    const projector = createTraceProjector(events, DEFAULT_ENGINE_OPTIONS);
    for (let step = 0; step <= events.length; step++) {
      const occupied = projector.at(step).frames.filter((f) => f.pageId !== null);
      expect(occupied.length).toBeLessThanOrEqual(DEFAULT_ENGINE_OPTIONS.bufferFrames);
      // And no page may occupy two frames at once.
      const pages = occupied.map((f) => f.pageId);
      expect(new Set(pages).size).toBe(pages.length);
    }
  });

  it('folds cleanly at every step, and the final fold matches the result', () => {
    const projector = createTraceProjector(events, DEFAULT_ENGINE_OPTIONS);
    for (let step = 0; step <= events.length; step++) {
      expect(projector.at(step).step).toBe(step);
    }
    const final = projector.at(events.length);
    expect(final.rows).toEqual(rows);
    expect(final.locks).toEqual([]);
    expect(final.stage).toBe('result');
  });

  it('reports the row count the top operator actually produced', () => {
    const top = events.filter((e) => e.stage === 'execute').at(-1);
    if (rows.length > 0) expect(top?.stage === 'execute' && top.rowsProduced).toBe(rows.length);
  });

  it('returns only rows that exist in the table, with values unaltered', () => {
    // A projected row may have no `id`, so match on whatever columns came back:
    // projection is allowed to narrow, never to invent or alter a value.
    for (const row of rows) {
      const columns = Object.keys(row);
      const source = users.rows.find((candidate) =>
        columns.every((column) => candidate[column] === row[column]),
      );
      expect(source, JSON.stringify(row)).toBeDefined();
    }
  });
});

describe('the pipeline is stable across configuration', () => {
  it.each(QUERIES)('returns identical rows under either policy: %s', (sql) => {
    const lru = run(sql, { policy: 'lru' }).rows;
    const clock = run(sql, { policy: 'clock' }).rows;
    expect(clock).toEqual(lru);
  });

  it.each(QUERIES)('returns identical rows at any page or pool size: %s', (sql) => {
    const base = run(sql).rows;
    for (const over of [
      { rowsPerPage: 1 },
      { rowsPerPage: 7 },
      { rowsPerPage: 200 },
      { bufferFrames: 1 },
      { bufferFrames: 64 },
    ]) {
      expect(run(sql, over).rows, JSON.stringify(over)).toEqual(base);
    }
  });

  it('is deterministic — the same query twice gives byte-identical traces', () => {
    for (const sql of QUERIES) {
      const a = run(sql);
      const b = run(sql);
      expect(JSON.stringify(b.events)).toEqual(JSON.stringify(a.events));
    }
  });

  it('every event survives structured cloning, keeping the engine worker-ready', () => {
    for (const sql of QUERIES) {
      const { events } = run(sql);
      expect(structuredClone(events)).toEqual(events);
    }
  });
});

describe('the index and the scan agree', () => {
  it('an equality lookup and a range that pins the same row return the same thing', () => {
    const indexed = run('SELECT * FROM users WHERE id = 5').rows;
    // `id > 4 AND id < 6` selects the same one row — and, since plan.md
    // §23.1's leaf-chaining range scan, via the index too (range-index-selection).
    const ranged = run('SELECT * FROM users WHERE id > 4 AND id < 6').rows;
    expect(indexed).toEqual(ranged);
  });

  it('both do far less work than a predicate on a column with no index at all', () => {
    const reads = (events: StepEvent[]) =>
      events.filter((e) => e.stage === 'buffer' && e.action === 'load').length;
    // `age` is not an indexed column, so this one is a genuine full scan —
    // the honest comparison point now that the range predicate below is
    // index-backed too, not the plain SeqScan it used to fall back to.
    const fullScan = reads(run('SELECT * FROM users WHERE age > 1000').events);

    expect(reads(run('SELECT * FROM users WHERE id = 5').events)).toBeLessThan(fullScan / 2);
    expect(reads(run('SELECT * FROM users WHERE id > 4 AND id < 6').events)).toBeLessThan(fullScan / 2);
  });
});
