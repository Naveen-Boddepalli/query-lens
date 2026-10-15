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

const N = 3000;
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
    distincts: new Map<string, number>(),
    preds: new Map<string, number>(),
    /** An equality answered from an index that returned two or more rows — only a non-unique index can. */
    repeatedIndexReads: 0,
    repeatedIndexWrites: 0,
    /** An UPDATE that sets an indexed column, so the write moves an index entry. */
    reindexingUpdates: 0,
    /** JOINs that really probed an inner index (an `IndexProbe` in the plan), and ones that asked to but had no index and fell back. */
    indexJoins: 0,
    indexJoinFallbacks: 0,
    /** Index joins where one outer row's probe found two or more inner entries. */
    indexJoinsWithRepeats: 0,
    /** Composite indexes (plan.md §25.4 B3b): entered by a leftmost prefix, covering a query, refused for lack of one, written through, probed by a join. */
    compositeScans: 0,
    compositeCovering: 0,
    compositeRefused: 0,
    compositeWrites: 0,
    compositeProbes: 0,
    /** An equality prefix plus a range on the next column, walking the run — and writes that find their rows by a range scan. */
    prefixRanges: 0,
    rangeWrites: 0,
    /** Writes that consulted a UNIQUE index (and found the key free). */
    uniqueChecks: 0,
    /** Joins with a LEFT step, and chains of two steps, that returned rows (plan.md §25.4 C3 slices a and b). */
    leftJoins: 0,
    chains: 0,
    /** Statements with an `IN (subquery)` whose subquery found nothing — where `NULL NOT IN (∅)` is TRUE. */
    emptySubqueries: 0,
    /** Aggregate queries with an ORDER BY that returned two or more groups, by aggregate strategy (plan.md §26 F1a). */
    orderedGroups: new Map<string, number>(),
  };

  for (const [{ tables: initial, steps }, options] of sessions) {
    let tables: TableSpec[] = [...initial];
    if (tables[0].rows.length === 0) stats.emptyTables += 1;
    if (tables[0].rows.some((r) => Object.values(r).includes(null))) stats.nullsSeen += 1;

    for (const q of steps) {
      stats.kinds.set(q.kind, (stats.kinds.get(q.kind) ?? 0) + 1);
      if ('distinct' in q && q.distinct) {
        const key = `${q.kind}:${options.aggregateStrategy ?? 'hash'}`;
        stats.distincts.set(key, (stats.distincts.get(key) ?? 0) + 1);
      }
      if ('where' in q) {
        for (const w of [...q.where, ...(q.kind === 'aggregate' && q.having ? [q.having] : [])]) {
          walkPred(w, (p) => {
            const key = p.k === 'between' && p.neg ? 'not-between' : p.k === 'in' && p.neg ? 'not-in' : p.k === 'insub' && p.neg ? 'not-insub' : p.k === 'like' && p.neg ? 'not-like' : p.k === 'isnull' && p.neg ? 'is-not-null' : p.k === 'cmp' && p.op === '<>' ? '<>' : p.k;
            stats.preds.set(key, (stats.preds.get(key) ?? 0) + 1);
          });
        }
      }
      const result = runQuery(renderQuery(q), toDatabase(tables), options);
      if (result.error) continue;
      for (const e of result.events) {
        if (e.stage === 'optimize') stats.rules.set(e.rule, (stats.rules.get(e.rule) ?? 0) + 1);
      }
      const repeated = result.events.some(
        (e) => e.stage === 'execute' && (e.op === 'IndexScan' || e.op === 'IndexOnlyScan') && e.rowsProduced >= 2,
      );
      if (repeated) stats[isWrite(q) ? 'repeatedIndexWrites' : 'repeatedIndexReads'] += 1;
      if (q.kind === 'update' && q.set.some((a) => tables[0].indexed.includes(a.col))) stats.reindexingUpdates += 1;
      if (q.kind === 'join' && options.joinStrategy === 'index-nested-loop') {
        const probed = result.events.some((e) => e.stage === 'plan' && JSON.stringify(e.planTree).includes('"op":"IndexProbe"'));
        if (probed) {
          stats.indexJoins += result.rows.length > 0 ? 1 : 0;
          if (result.events.some((e) => / of [2-9]\d* its probe found/.test(e.label))) stats.indexJoinsWithRepeats += 1;
        } else stats.indexJoinFallbacks += 1;
      }
      const planned = result.events.map((e) => (e.stage === 'optimize' ? JSON.stringify(e.after) : e.stage === 'plan' ? JSON.stringify(e.planTree) : '')).join('\n');
      if (planned.includes('"op":"IndexScan","label":"IndexScan t.(') || planned.includes('"op":"IndexScan","label":"IndexScan u.(')) stats[isWrite(q) ? 'compositeWrites' : 'compositeScans'] += 1;
      if (planned.includes('"op":"IndexOnlyScan","label":"IndexOnlyScan t.(')) stats.compositeCovering += 1;
      if (/"op":"IndexRangeScan","label":"IndexRangeScan [tu]\.\([^"]*\)","detail":"range: [a-z_]+ = /.test(planned)) stats.prefixRanges += 1;
      if (isWrite(q) && planned.includes('"op":"IndexRangeScan"')) stats.rangeWrites += 1;
      if (isWrite(q) && result.events.some((e) => e.label.includes('so the key is free'))) stats.uniqueChecks += 1;
      if (result.events.some((e) => e.label.includes('finding no values at all'))) stats.emptySubqueries += 1;
      if (q.kind === 'join' && result.rows.length > 0) {
        if (q.joins.some((j) => j.type === 'left')) stats.leftJoins += 1;
        if (q.joins.length > 1) stats.chains += 1;
      }
      if (planned.includes('"op":"IndexProbe","label":"IndexProbe u.(')) stats.compositeProbes += 1;
      if (result.events.some((e) => e.label.includes('cannot help: the predicate constrains'))) stats.compositeRefused += 1;
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
        if (q.kind === 'aggregate' && q.order && result.rows.length > 1) {
          const key = `${options.aggregateStrategy ?? 'hash'}:${q.order.by.k}`;
          stats.orderedGroups.set(key, (stats.orderedGroups.get(key) ?? 0) + 1);
        }
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
    for (const form of ['cmp', 'colcmp', 'litcmp', 'between', 'not-between', 'isnull', 'is-not-null', 'in', 'not-in', 'insub', 'not-insub', 'pnull', 'like', 'not-like', 'not', 'and', 'or', '<>', 'acmp', 'ccmp', 'hagg']) {
      expect(stats.preds.get(form) ?? 0, `predicate form ${form}`).toBeGreaterThan(N / 30);
    }
  });

  it('generates DISTINCT for every kind of read, under both strategies', () => {
    for (const key of ['select:hash', 'select:sort', 'aggregate:hash', 'aggregate:sort', 'join:hash', 'join:sort']) {
      expect(stats.distincts.get(key) ?? 0, `DISTINCT ${key}`).toBeGreaterThan(5);
    }
  });

  it('gets non-empty answers a healthy share of the time, not just empty ones', () => {
    // An over-constrained WHERE returns nothing, and comparing two empty answers proves little.
    expect(stats.readsWithRows / stats.reads).toBeGreaterThan(0.35);
    expect(stats.readsWithRows).toBeGreaterThan(N / 3);
  });

  it('runs every join algorithm and both aggregate strategies to a non-empty result', () => {
    for (const algorithm of ['nested-loop', 'hash', 'sort-merge', 'index-nested-loop']) expect(stats.joins.get(algorithm) ?? 0, algorithm).toBeGreaterThan(20);
    for (const strategy of ['hash', 'sort']) expect(stats.aggregates.get(strategy) ?? 0, strategy).toBeGreaterThan(20);
  });

  it('indexes columns that repeat, looks them up, and writes through them (plan.md §25.4 B3)', () => {
    // Lower than repeatedIndexWrites' own threshold (plan.md §25.4 C5): the honest cost gate now declines a
    // non-unique equality lookup on the generator's typically small random tables more often than it accepts one,
    // so fewer generated reads reach a real repeated-entry index scan — measured at 7 with the fixed seed above,
    // still comfortably non-zero, which is what this suite exists to guarantee.
    expect(stats.repeatedIndexReads, 'equality lookups returning several rows from an index').toBeGreaterThan(5);
    expect(stats.repeatedIndexWrites, 'UPDATE/DELETE finding several rows through an index').toBeGreaterThan(5);
    expect(stats.reindexingUpdates, 'UPDATEs that move an index entry').toBeGreaterThan(30);
  });

  it('runs an index nested-loop join to a non-empty answer, repeats included, and exercises the fallback (plan.md §25.4 B4)', () => {
    // Lower than before `joinStrategy` gained a fifth, `undefined` value (plan.md §25.4 C5 slice 2, cost-chosen):
    // each explicit algorithm, this one included, is now requested by only a fifth of sessions instead of a
    // quarter — measured at 14 with the fixed seed above, still comfortably enough to prove the fallback works.
    expect(stats.indexJoins, 'index joins with rows').toBeGreaterThan(10);
    expect(stats.indexJoinsWithRepeats, 'index joins whose probe found several entries').toBeGreaterThan(2);
    expect(stats.indexJoinFallbacks, 'index joins with no index to probe').toBeGreaterThan(20);
  });

  it('enters composite indexes by a leftmost prefix, covers queries with them, and declines them without one (plan.md §25.4 B3b)', () => {
    // Lower than 30 since the generators gained a third table, `IN (subquery)` and `(P) IS NULL` (plan.md §25.4 C3,
    // 2026-10-15): the fixed seed now draws a different sample, and the new predicate forms dilute the plain ones the
    // composite lookups are built from — measured at 28.
    expect(stats.compositeScans, 'lookups through a composite index').toBeGreaterThan(20);
    expect(stats.compositeCovering, 'queries a composite index covers').toBeGreaterThan(5);
    expect(stats.compositeRefused, 'composite indexes refused for lack of a leading column').toBeGreaterThan(10);
    expect(stats.compositeWrites, 'writes finding rows through a composite index').toBeGreaterThan(10);
    expect(stats.compositeProbes, 'joins probing a composite index').toBeGreaterThan(3);
    expect(stats.prefixRanges, 'an equality prefix plus a range on the next column').toBeGreaterThan(10);
    expect(stats.rangeWrites, 'writes finding their rows by a range scan').toBeGreaterThan(10);
  });

  it('runs LEFT JOINs and two-step chains to a non-empty answer, and empty subqueries (plan.md §25.4 C3)', () => {
    expect(stats.leftJoins, 'joins with a LEFT step that returned rows').toBeGreaterThan(N / 30);
    // A second step joins a third, smaller table and must find partners in both, so fewer chains return rows than
    // single joins do — measured at 83 with the fixed seed above.
    expect(stats.chains, 'two-step join chains that returned rows').toBeGreaterThan(50);
    expect(stats.emptySubqueries, 'statements whose IN subquery found nothing').toBeGreaterThan(N / 30);
  });

  it('sorts groups by a grouped column and by an aggregate, under both aggregate strategies (plan.md §26 F1a)', () => {
    for (const key of ['hash:col', 'hash:agg', 'sort:col', 'sort:agg']) {
      expect(stats.orderedGroups.get(key) ?? 0, `ordered groups ${key}`).toBeGreaterThan(20);
    }
  });

  it('writes through UNIQUE indexes without tripping them (plan.md §25.4 B3c)', () => {
    expect(stats.uniqueChecks, 'writes that checked a unique index').toBeGreaterThan(20);
  });

  it('includes empty tables, NULLs, and writes that really change rows', () => {
    expect(stats.emptyTables).toBeGreaterThan(N / 100);
    expect(stats.nullsSeen).toBeGreaterThan(N / 4);
    expect(stats.writesChangingRows / stats.writes).toBeGreaterThan(0.5);
  });
});
