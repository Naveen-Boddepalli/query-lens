// @vitest-environment node
/**
 * The oracle must not be vacuous. A differential test that never reaches the
 * code under test passes forever and proves nothing, so this suite samples the
 * generators and *fails the build* if the statements they produce stop
 * exercising what the oracle exists to check: every optimizer rule, every
 * physical join and aggregate strategy, non-empty answers, NULLs, empty tables,
 * and writes that change rows.
 *
 * (Mutation-checked when it was written: an injected `<` → `<=`, a SUM that
 * drops a value, a hash join that indexes NULL keys and a sort-merge join that
 * skips equal keys are each caught by the suites in this directory.)
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { OPTIMIZER_RULES } from '../src/engine/planner/index.ts';
import { runQuery } from '../src/engine/runQuery.ts';
import { optionsArb, sessionArb } from './generate.ts';
import { toDatabase } from './harness.ts';
import { applyWrite } from './harness.ts';
import { isWrite, renderQuery, walkPred } from './model.ts';
import type { TableSpec } from './model.ts';

const N = 1500;
/** Its own seed, not `ORACLE_SEED`: this test asks whether the *generators* still reach everything, which must not vary with the seed a long run happens to pick. */
const COVERAGE_SEED = 20260925;

describe('the generators reach what the oracle is meant to check', () => {
  const sessions = fc.sample(fc.tuple(sessionArb('any'), optionsArb), { seed: COVERAGE_SEED, numRuns: N });

  const stats = {
    reads: 0,
    readsWithRows: 0,
    writes: 0,
    writesChangingRows: 0,
    emptyTables: 0,
    kinds: new Map<string, number>(),
    rules: new Map<string, number>(),
    joins: new Map<string, number>(),
    aggregates: new Map<string, number>(),
    nullsSeen: 0,
    preds: new Map<string, number>(),
  };

  for (const [{ tables: initial, steps }, options] of sessions) {
    let tables: TableSpec[] = [...initial];
    if (tables[0].rows.length === 0) stats.emptyTables += 1;
    if (tables[0].rows.some((r) => Object.values(r).includes(null))) stats.nullsSeen += 1;

    for (const q of steps) {
      stats.kinds.set(q.kind, (stats.kinds.get(q.kind) ?? 0) + 1);
      if ('where' in q) {
        for (const w of [...q.where, ...(q.kind === 'aggregate' && q.having ? [q.having] : [])]) {
          walkPred(w, (p) => {
            const key = p.k === 'between' && p.neg ? 'not-between' : p.k === 'in' && p.neg ? 'not-in' : p.k === 'like' && p.neg ? 'not-like' : p.k === 'isnull' && p.neg ? 'is-not-null' : p.k === 'cmp' && p.op === '<>' ? '<>' : p.k;
            stats.preds.set(key, (stats.preds.get(key) ?? 0) + 1);
          });
        }
      }
      const result = runQuery(renderQuery(q), toDatabase(tables), options);
      if (result.error) continue;
      for (const e of result.events) {
        if (e.stage === 'optimize') stats.rules.set(e.rule, (stats.rules.get(e.rule) ?? 0) + 1);
      }
      if (isWrite(q)) {
        stats.writes += 1;
        if ((result.write?.kind === 'insert' && result.write.insertedCount > 0) ||
            (result.write?.kind === 'delete' && result.write.deletedCount > 0) ||
            (result.write?.kind === 'update' && result.write.updatedCount > 0)) stats.writesChangingRows += 1;
        tables = applyWrite(tables, q, result);
      } else {
        stats.reads += 1;
        if (result.rows.length > 0) stats.readsWithRows += 1;
        if (q.kind === 'join') stats.joins.set(options.joinStrategy ?? 'nested-loop', (stats.joins.get(options.joinStrategy ?? 'nested-loop') ?? 0) + (result.rows.length > 0 ? 1 : 0));
        if (q.kind === 'aggregate' && q.group.length > 0) stats.aggregates.set(options.aggregateStrategy ?? 'hash', (stats.aggregates.get(options.aggregateStrategy ?? 'hash') ?? 0) + (result.rows.length > 0 ? 1 : 0));
      }
    }
  }

  it('produces every kind of statement', () => {
    for (const kind of ['select', 'aggregate', 'join', 'insert', 'update', 'delete']) {
      expect(stats.kinds.get(kind) ?? 0, kind).toBeGreaterThan(N / 40);
    }
  });

  it('fires every optimizer rule', () => {
    for (const rule of OPTIMIZER_RULES) expect(stats.rules.get(rule) ?? 0, `rule ${rule} fired too rarely`).toBeGreaterThan(5);
  });

  it('generates every predicate form, including the negated ones and the NULL-in-list trap', () => {
    for (const form of ['cmp', 'colcmp', 'litcmp', 'between', 'not-between', 'isnull', 'is-not-null', 'in', 'not-in', 'like', 'not-like', 'not', 'and', 'or', '<>', 'acmp', 'ccmp', 'hagg']) {
      expect(stats.preds.get(form) ?? 0, `predicate form ${form}`).toBeGreaterThan(N / 30);
    }
  });

  it('gets non-empty answers a healthy share of the time, not just empty ones', () => {
    // An over-constrained WHERE returns nothing, and comparing two empty answers proves little.
    expect(stats.readsWithRows / stats.reads).toBeGreaterThan(0.35);
    expect(stats.readsWithRows).toBeGreaterThan(N / 3);
  });

  it('runs every join algorithm and both aggregate strategies to a non-empty result', () => {
    for (const algorithm of ['nested-loop', 'hash', 'sort-merge']) expect(stats.joins.get(algorithm) ?? 0, algorithm).toBeGreaterThan(20);
    for (const strategy of ['hash', 'sort']) expect(stats.aggregates.get(strategy) ?? 0, strategy).toBeGreaterThan(20);
  });

  it('includes empty tables, NULLs, and writes that really change rows', () => {
    expect(stats.emptyTables).toBeGreaterThan(N / 100);
    expect(stats.nullsSeen).toBeGreaterThan(N / 4);
    expect(stats.writesChangingRows / stats.writes).toBeGreaterThan(0.5);
  });
});
