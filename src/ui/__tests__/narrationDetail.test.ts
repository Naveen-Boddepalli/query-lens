/** plan.md §27.5 L2 — the narration at three levels of detail. */

import { describe, expect, it } from 'vitest';
import { eventKey } from '../../engine/eventKey.ts';
import { createTraceProjector, DATASETS, DEFAULT_ENGINE_OPTIONS, runQuery } from '../../engine/index.ts';
import type { DatasetId, EngineOptions, RunResult } from '../../engine/index.ts';
import { openEngineLog } from '../../engine/recovery/engineLogOps.ts';
import { loggedRun } from '../../engine/recovery/engineLog.ts';
import { readDetailParam } from '../detailLevel.ts';
import { expertLine, firstOfEachKind, narrationAt, NOVICE_LINES, noviceLine } from '../narrationDetail.ts';

/** Between them, every kind of step the Playground's engine emits. */
const CORPUS: [DatasetId, string, Partial<EngineOptions>?][] = [
  ['users', 'SELECT * FROM users WHERE id = 5'],
  ['users', 'SELECT * FROM users WHERE id = 999'],
  ['users', 'SELECT name FROM users WHERE age > 30 ORDER BY name LIMIT 3'],
  ['users', 'SELECT * FROM users WHERE age > 1 + 1'],
  ['users', 'SELECT id FROM users WHERE id = 5'],
  ['users', 'SELECT DISTINCT age FROM users'],
  ['users', 'SELECT DISTINCT age FROM users', { aggregateStrategy: 'sort' }],
  ['users', 'SELECT age, COUNT(*) FROM users GROUP BY age HAVING COUNT(*) > 1'],
  ['users', 'SELECT age, COUNT(*) FROM users GROUP BY age', { aggregateStrategy: 'sort' }],
  ['users', 'SELECT * FROM users', { policy: 'clock' }],
  ['users', 'SELECT * FROM users', { readAhead: 4 }],
  ['users', "INSERT INTO users VALUES (100, 'zed', 'z@example.com', 20)"],
  ['users', 'UPDATE users SET age = 40 WHERE id = 3'],
  ['users', 'DELETE FROM users WHERE id = 3'],
  ['transactions', 'SELECT * FROM transactions WHERE id BETWEEN 100 AND 110'],
  ['shop', 'SELECT customers.name, orders.id FROM customers JOIN orders ON customers.id = orders.customerId'],
  ['shop', 'SELECT customers.name, orders.id FROM customers, orders WHERE customers.id = orders.customerId AND orders.qty > 1'],
  ['shop', 'SELECT customers.name FROM customers JOIN orders ON customers.id = orders.customerId WHERE customers.id < orders.qty'],
  ['shop', 'SELECT customerId FROM orders UNION SELECT id FROM customers'],
];

/** A logged write (plan.md §28.5 I2), on a pool small enough that a dirty page is evicted: its log records and flushes. */
const logged = (): { sql: string; options: EngineOptions; result: RunResult } => {
  const sql = 'UPDATE users SET age = age + 1';
  const options = { ...DEFAULT_ENGINE_OPTIONS, bufferFrames: 2 };
  const db = DATASETS.users.make();
  return { sql, options, result: runQuery(sql, db, options, { engineLog: loggedRun(openEngineLog(db, options, { steal: true, force: false })) }) };
};

const runs: { sql: string; options: EngineOptions; result: RunResult }[] = [
  ...CORPUS.map(([dataset, sql, extra]) => {
    const options = { ...DEFAULT_ENGINE_OPTIONS, ...extra };
    return { sql, options, result: runQuery(sql, DATASETS[dataset].make(), options) };
  }),
  logged(),
];

describe('narration detail levels (plan.md §27.5 L2)', () => {
  it('the corpus runs', () => {
    for (const { sql, result } of runs) expect(result.error, sql).toBeUndefined();
  });

  it('has a novice line of its own for every kind of step the engine emits — none falls back to its stage’s', () => {
    const keys = new Set(runs.flatMap(({ result }) => result.events.map((e) => eventKey(e).key)));
    expect(keys.size).toBeGreaterThan(40);
    for (const key of keys) expect(NOVICE_LINES[key], key).toBeDefined();
    // And no line is kept for a kind of step that never happens.
    for (const key of Object.keys(NOVICE_LINES)) if (key.includes('.')) expect(keys.has(key), key).toBe(true);
  });

  it('standard is the engine’s own label; novice adds a line only on the first step of each kind; expert is built from the event alone', () => {
    for (const { sql, options, result } of runs) {
      const firsts = firstOfEachKind(result.events);
      const projector = createTraceProjector(result.events, options);
      let glosses = 0;
      for (let step = 1; step <= result.events.length; step++) {
        const state = projector.at(step);
        const e = result.events[step - 1]!;
        expect(narrationAt(state, 'standard', sql, firsts)).toEqual({ text: e.label, terse: false });
        const novice = narrationAt(state, 'novice', sql, firsts);
        expect(novice.text).toBe(e.label);
        if (novice.gloss !== undefined) {
          glosses += 1;
          expect(novice.gloss).toBe(NOVICE_LINES[eventKey(e).key]);
        }
        const expert = narrationAt(state, 'expert', sql, firsts);
        expect(expert.terse).toBe(true);
        expect(expert.text, `${sql} @ ${String(step)}`).not.toMatch(/undefined|NaN|\[object/);
        expect(expert.text).not.toBe(e.label);
      }
      expect(glosses, sql).toBe(new Set(result.events.map((e) => eventKey(e).key)).size);
    }
  });

  it('before the first step there is nothing to tell, at any level', () => {
    const { sql, options, result } = runs[0]!;
    const state = createTraceProjector(result.events, options).at(0);
    for (const level of ['novice', 'standard', 'expert'] as const) expect(narrationAt(state, level, sql, firstOfEachKind(result.events))).toEqual({ text: '', terse: false });
  });

  it('expert lines say what the event recorded, tersely', () => {
    const { sql, options, result } = runs[0]!;
    const projector = createTraceProjector(result.events, options);
    const line = (find: (i: number) => boolean) => {
      const i = result.events.findIndex((_, j) => find(j));
      return expertLine(eventKey(result.events[i]!), sql, projector.at(i + 1).bufferStats);
    };
    const kind = (stage: string, action?: string) => (i: number) => {
      const e = result.events[i]! as { stage: string; action?: string };
      return e.stage === stage && (action === undefined || e.action === action);
    };
    expect(line(kind('parse'))).toBe('parse · `*` at 7–8');
    expect(line(kind('buffer', 'miss'))).toBe('miss · page 20');
    expect(line(kind('buffer', 'load'))).toBe('read · page 20 → frame 0');
    expect(line(kind('index', 'open'))).toBe('B+Tree · root n8, height 3');
    expect(line(kind('index', 'traverse'))).toBe('n8 · key 5 → child 0');
    expect(line(kind('lock', 'acquire'))).toBe('S lock · page 20 taken');
    expect(line(kind('result'))).toBe('result · 1 row · 4 misses, 0 hits, 0 evictions');
    expect(line((i) => result.events[i]!.stage === 'optimize' && (result.events[i] as { rule: string }).rule === 'index-selection')).toBe(
      'rewrite index-selection ⇒ Project [*] ← IndexScan users.id [key: id = 5] · est. 1 row · `id` index lookup ~4 pages vs a sequential scan ~12',
    );
  });

  it('a kind of step with no line of its own is told its stage’s; an exclusive lock is an X', () => {
    expect(noviceLine('execute.Mystery')).toBe(NOVICE_LINES.execute);
    expect(noviceLine('buffer.miss')).toBe(NOVICE_LINES['buffer.miss']);
    const stats = { hits: 0, misses: 0, evictions: 0, writes: 0, prefetches: 0 };
    expect(expertLine({ key: 'lock.acquire', params: { page: 3, mode: 'exclusive' } }, '', stats)).toBe('X lock · page 3 taken');
    expect(expertLine({ key: 'lock.release', params: { page: 3, mode: 'shared' } }, '', stats)).toBe('S lock · page 3 released');
  });

  it('reads `?detail=` — novice or expert; standard, or anything else, is the default', () => {
    expect(readDetailParam('?detail=novice')).toBe('novice');
    expect(readDetailParam('?q=1&detail=expert')).toBe('expert');
    expect(readDetailParam('?detail=standard')).toBe('standard');
    expect(readDetailParam('?detail=chatty')).toBeUndefined();
    expect(readDetailParam('')).toBeUndefined();
  });
});
