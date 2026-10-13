import { describe, expect, it } from 'vitest';
import {
  buildHeap,
  costOfOrder,
  createJoinOrderDemoDatabase,
  createSeedDatabase,
  DEFAULT_ENGINE_OPTIONS,
  joinGraphFromAst,
  parse,
  runJoinOrderDP,
  writtenOrderFromAst,
} from '../../../engine/index.ts';
import {
  bestEncodingFor,
  COLUMNAR_LIMITS,
  demoColumns,
  encodingSize,
  planLayout,
  planMaterialization,
} from '../../../ui/columnar.ts';
import { shuffledRange, planExternalSort, SORT_LIMITS } from '../../../ui/externalSort.ts';
import { demoKeys, HASH_JOIN_LIMITS, planHashJoin } from '../../../ui/hashJoin.ts';
import { demoWrites as hashWrites, HASH_LIMITS, planHashIndex } from '../../../ui/hashIndex.ts';
import { DEMO_INITIAL_KEYS, demoScripts, LATCH_LIMITS, planLatchCrabbing } from '../../../ui/latchCrabbing.ts';
import { demoWrites as lsmWrites, LSM_LIMITS, planLsm } from '../../../ui/lsm.ts';
import { layOutPage } from '../../../ui/slottedPage.ts';
import { planVectorIndex, VECTOR_LIMITS } from '../../../ui/vectorIndex.ts';
import { EXECUTION_LESSONS, STORAGE_LESSONS } from '../storageLessons.tsx';
import { STORAGE_SCENARIOS, storageHref } from '../storageScenarios.ts';
import type {
  HashIndexScenario,
  HashJoinScenario,
  LatchScenario,
  LsmScenario,
  SortScenario,
  StorageScenario,
} from '../storageScenarios.ts';
import { LESSONS, PIPELINE_LESSONS } from '../lessons.tsx';
import { TRANSACTION_LESSONS } from '../transactionLessons.tsx';

/**
 * A lesson quotes numbers, and a number a driver no longer produces is a lesson that has stopped being true. Every
 * scenario here is run on the tool's own driver and held to the figures its lesson states. The prose is copy; these
 * are not.
 */

const lsm = (s: LsmScenario) =>
  planLsm(lsmWrites(s.n, s.seed), {
    compactionStrategy: s.strategy,
    memtableCapacity: s.mem,
    l0CompactionTrigger: s.trigger,
    baseLevelCapacity: s.base,
    levelSizeMultiplier: s.mult,
    bitsPerKey: s.bits,
  });

const latch = (s: LatchScenario, protocol: 'naive' | 'crabbing', fanout = s.fanout) =>
  planLatchCrabbing(DEMO_INITIAL_KEYS, demoScripts(s.threads, s.ops, s.seed), fanout, protocol);

const peak = (p: ReturnType<typeof planLatchCrabbing>) => Math.max(...p.threads.map((t) => t.peakLatches));
const count = <T>(items: readonly T[], test: (item: T) => boolean) => items.filter(test).length;

describe('the storage and execution lessons are wired into the track', () => {
  it('sit after the pipeline lessons and before the transactions, with unique ids', () => {
    expect(LESSONS).toEqual([...PIPELINE_LESSONS, ...EXECUTION_LESSONS, ...STORAGE_LESSONS, ...TRANSACTION_LESSONS]);
    const ids = LESSONS.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(EXECUTION_LESSONS.map((l) => l.id)).toEqual(['external-sort', 'hash-join', 'join-order']);
    expect(STORAGE_LESSONS.map((l) => l.id)).toEqual([
      'slotted-page',
      'hash-index',
      'lsm-tree',
      'row-vs-column',
      'latch-crabbing',
      'vector-index',
    ]);
  });

  it('every step links a scenario, and every scenario but the named variants has a step', () => {
    const used = new Set<string>();
    for (const lesson of [...EXECUTION_LESSONS, ...STORAGE_LESSONS]) {
      expect(lesson.steps.length, lesson.id).toBeGreaterThanOrEqual(3);
      for (const [i, step] of lesson.steps.entries()) {
        expect(step.link, `${lesson.id} step ${String(i + 1)} has no tool link`).toBeDefined();
        used.add(step.link!.href);
      }
    }
    const hrefs = new Map(
      Object.entries(STORAGE_SCENARIOS).map(([name, s]) => [storageHref(s as StorageScenario), name] as const),
    );
    for (const href of used) expect(hrefs.has(href), `a lesson links ${href}, which is not a scenario`).toBe(true);
    // Run for a sentence in a "try this", not a button of its own.
    const variants = ['columnarPax', 'pageOverflow', 'sortFits'];
    const unlinked = Object.keys(STORAGE_SCENARIOS).filter(
      (name) => !used.has(storageHref(STORAGE_SCENARIOS[name as keyof typeof STORAGE_SCENARIOS] as StorageScenario)),
    );
    expect(unlinked.sort()).toEqual(variants.sort());
  });

  it('every link names settings its tool accepts as they are, rather than clamping them', () => {
    const within = (v: number, lo: number, hi: number) => v >= lo && v <= hi;
    for (const s of Object.values(STORAGE_SCENARIOS) as StorageScenario[]) {
      const url = new URL(storageHref(s), 'https://x');
      expect(url.pathname).toBe(`/tools/${s.tool}`);
      switch (s.tool) {
        case 'lsm':
          expect(within(s.n, LSM_LIMITS.minWrites, LSM_LIMITS.maxWrites)).toBe(true);
          expect(within(s.mem, LSM_LIMITS.minMemtableCapacity, LSM_LIMITS.maxMemtableCapacity)).toBe(true);
          expect(within(s.trigger, LSM_LIMITS.minL0Trigger, LSM_LIMITS.maxL0Trigger)).toBe(true);
          expect(within(s.mult, LSM_LIMITS.minLevelSizeMultiplier, LSM_LIMITS.maxLevelSizeMultiplier)).toBe(true);
          expect(within(s.bits, LSM_LIMITS.minBitsPerKey, LSM_LIMITS.maxBitsPerKey)).toBe(true);
          expect(within(s.base, 2, 32)).toBe(true);
          expect(url.searchParams.get('strategy')).toBe(s.strategy);
          break;
        case 'hash-index':
          expect(within(s.n, HASH_LIMITS.minWrites, HASH_LIMITS.maxWrites)).toBe(true);
          expect(within(s.cap, HASH_LIMITS.minBucketCapacity, HASH_LIMITS.maxBucketCapacity)).toBe(true);
          expect(within(s.init, HASH_LIMITS.minInitialBuckets, HASH_LIMITS.maxInitialBuckets)).toBe(true);
          expect(url.searchParams.get('strategy')).toBe(s.strategy);
          break;
        case 'columnar':
          expect(within(s.n, COLUMNAR_LIMITS.minRows, COLUMNAR_LIMITS.maxRows)).toBe(true);
          expect(within(s.page, COLUMNAR_LIMITS.minPageSize, COLUMNAR_LIMITS.maxPageSize)).toBe(true);
          expect(url.searchParams.get('layout')).toBe(s.layout);
          break;
        case 'latch-crabbing':
          expect(within(s.fanout, LATCH_LIMITS.minFanout, LATCH_LIMITS.maxFanout)).toBe(true);
          expect(within(s.threads, LATCH_LIMITS.minThreads, LATCH_LIMITS.maxThreads)).toBe(true);
          expect(within(s.ops, LATCH_LIMITS.minOpsPerThread, LATCH_LIMITS.maxOpsPerThread)).toBe(true);
          break;
        case 'vector-index':
          expect(within(s.n, VECTOR_LIMITS.minPoints, VECTOR_LIMITS.maxPoints)).toBe(true);
          expect(within(s.k, VECTOR_LIMITS.minK, VECTOR_LIMITS.maxK)).toBe(true);
          break;
        case 'page':
          expect(Number.isInteger(s.page) && s.page >= 0).toBe(true);
          expect(within(s.bytes, 128, 16384)).toBe(true);
          break;
        case 'sort':
          expect(within(s.n, SORT_LIMITS.minRecords, SORT_LIMITS.maxRecords)).toBe(true);
          expect(within(s.page, SORT_LIMITS.minPageSize, SORT_LIMITS.maxPageSize)).toBe(true);
          expect(within(s.mem, SORT_LIMITS.minMemPages, SORT_LIMITS.maxMemPages)).toBe(true);
          break;
        case 'hash-join':
          expect(within(s.build, HASH_JOIN_LIMITS.minBuildKeys, HASH_JOIN_LIMITS.maxBuildKeys)).toBe(true);
          expect(within(s.probe, HASH_JOIN_LIMITS.minProbeKeys, HASH_JOIN_LIMITS.maxProbeKeys)).toBe(true);
          expect(within(s.page, HASH_JOIN_LIMITS.minPageSize, HASH_JOIN_LIMITS.maxPageSize)).toBe(true);
          expect(within(s.mem, HASH_JOIN_LIMITS.minMemPages, HASH_JOIN_LIMITS.maxMemPages)).toBe(true);
          break;
        case 'join-order':
          expect(url.search).toBe('');
          break;
      }
    }
  });
});

describe('lesson: sort more than fits in memory', () => {
  const sort = (s: SortScenario) =>
    planExternalSort(shuffledRange(s.n, s.seed), { pageSize: s.page, memPages: s.mem });

  it('three buffer pages: 16 pages make six runs, merged two at a time in three passes, 128 I/Os', () => {
    const p = sort(STORAGE_SCENARIOS.sortTight);
    expect([p.pageCount, p.initialRunCount, p.fanIn, p.mergePassCount, p.totalIO]).toEqual([16, 6, 2, 3, 128]);
    expect(p.passes.map((pass) => pass.runs.length)).toEqual([6, 3, 2, 1]);
    expect(p.ioPerPass).toBe(32);
  });

  it('six buffer pages: three runs, one merge pass of fan-in five, 64 I/Os — half', () => {
    const p = sort(STORAGE_SCENARIOS.sortRoomy);
    expect([p.initialRunCount, p.fanIn, p.mergePassCount, p.totalIO]).toEqual([3, 5, 1, 64]);
  });

  it('eight records fit: one run, no merge, one read and one write of each page', () => {
    const p = sort(STORAGE_SCENARIOS.sortFits);
    expect([p.pageCount, p.fitsInMemory, p.initialRunCount, p.mergePassCount, p.totalIO]).toEqual([4, true, 1, 0, 8]);
  });
});

describe('lesson: Grace hash join', () => {
  const join = (s: HashJoinScenario) => {
    const { buildKeys, probeKeys } = demoKeys(s.build, s.probe, s.seed);
    return planHashJoin(buildKeys, probeKeys, { pageSize: s.page, memPages: s.mem });
  };
  const misses = (p: ReturnType<typeof join>) => p.leaves.reduce((n, l) => n + l.leaf!.misses.length, 0);

  it('six buffer pages: no partitioning, 16 I/Os, 16 of the 20 probe keys match and 4 miss', () => {
    const p = join(STORAGE_SCENARIOS.hashJoinFits);
    expect([p.fitsInMemory, p.partitionIO, p.buildProbeIO, p.totalIO, p.matches.length, misses(p)]).toEqual([
      true, 0, 16, 16, 16, 4,
    ]);
  });

  it('four buffer pages: three partitions, 32 + 18 = 50 I/Os, about three times the cost, the same 16 matches', () => {
    const p = join(STORAGE_SCENARIOS.hashJoinSpills);
    expect([p.fitsInMemory, p.numPartitions, p.partitionIO, p.buildProbeIO, p.totalIO, p.matches.length]).toEqual([
      false, 3, 32, 18, 50, 16,
    ]);
    expect(p.totalIO / join(STORAGE_SCENARIOS.hashJoinFits).totalIO).toBeGreaterThan(3);
    expect(p.totalIO / join(STORAGE_SCENARIOS.hashJoinFits).totalIO).toBeLessThan(3.5);
  });

  it('the big one goes two levels deep, 114 of 147 I/Os spent partitioning, 26 matches, and has colliding buckets', () => {
    const p = join(STORAGE_SCENARIOS.hashJoinDeep);
    expect([p.numPartitions, p.maxDepth, p.partitionIO, p.totalIO, p.matches.length]).toEqual([2, 2, 114, 147, 26]);
    const collisions = p.leaves.reduce((n, l) => n + count(l.leaf!.buckets, (b) => b.hasCollision), 0);
    expect(collisions).toBeGreaterThan(0);
  });
});

describe('lesson: join order', () => {
  const SQL =
    'SELECT * FROM departments\n  JOIN projects ON departments.id = projects.deptId\n  JOIN employees ON departments.id = employees.deptId\n  JOIN timesheets ON employees.id = timesheets.employeeId';
  const parsed = parse(SQL);
  if (!parsed.ok) throw new Error('the join-order demo query must parse');
  const db = createJoinOrderDemoDatabase();
  const { nodes, edges } = joinGraphFromAst(parsed.ast, db.tables, DEFAULT_ENGINE_OPTIONS.rowsPerPage);
  const written = costOfOrder(nodes, edges, writtenOrderFromAst(parsed.ast));
  const dp = runJoinOrderDP(nodes, edges);

  it('the order as written is projects before employees and costs 1,501,542 estimated pages for 30,000 rows', () => {
    expect(writtenOrderFromAst(parsed.ast)).toEqual(['departments', 'projects', 'employees', 'timesheets']);
    expect(written).toEqual({ rows: 30000, pages: 1501542 });
  });

  it('four tables have fifteen subsets, and every subset past a single table lists what ending on each would cost', () => {
    expect(dp.subsets.size).toBe(15);
    for (const subset of dp.subsets.values()) {
      expect(subset.candidates.length).toBe(subset.tables.length === 1 ? 0 : subset.tables.length);
    }
  });

  it('the winner ends on projects at 290,252 pages, about five times less; ending on any other table costs more', () => {
    expect(dp.winner.tables).toEqual(['departments', 'employees', 'timesheets', 'projects']);
    expect(dp.winner.pages).toBe(290252);
    expect(written.pages / dp.winner.pages).toBeGreaterThan(5.1);
    expect(written.pages / dp.winner.pages).toBeLessThan(5.3);
    const last = Object.fromEntries(dp.winner.candidates.map((c) => [c.addedTable, c.pages]));
    expect(last).toEqual({ projects: 290252, departments: 590050, timesheets: 1501542, employees: 7537542 });
  });
});

describe('lesson: where a row lives on a page', () => {
  const users = createSeedDatabase().tables.users!;
  const page0 = buildHeap(users, DEFAULT_ENGINE_OPTIONS.rowsPerPage).pages[0]!;
  const at = (bytes: number) => layOutPage(page0.rows, users.columns, { pageBytes: bytes });

  it('four rows at 4,096 bytes: 24 + 16 + 162 = 202 used, 3,894 free, 87 more rows fit', () => {
    const l = at(STORAGE_SCENARIOS.pageRoomy.bytes);
    expect(page0.rows).toHaveLength(4);
    expect([l.headerBytes, l.slotArrayBytes, l.usedBytes, l.freeBytes, l.moreRowsFit]).toEqual([24, 16, 202, 3894, 87]);
    expect(l.tuples.map((t) => t.length)).toEqual([36, 38, 44, 44]);
    expect(l.tuples.reduce((n, t) => n + t.length, 0)).toBe(162);
  });

  it('tuples are packed from the far end: offsets 4,060, 4,022, 3,978, 3,934', () => {
    expect(at(4096).tuples.map((t) => t.offset)).toEqual([4060, 4022, 3978, 3934]);
  });

  it('at 256 bytes 54 are free and one more fits; at 192 the rows overflow and the last tuple lands inside the slot array', () => {
    const tight = at(STORAGE_SCENARIOS.pageTight.bytes);
    expect([tight.freeBytes, tight.moreRowsFit, tight.overflow]).toEqual([54, 1, false]);
    const over = at(STORAGE_SCENARIOS.pageOverflow.bytes);
    expect(over.overflow).toBe(true);
    expect(over.tuples.at(-1)!.offset).toBeLessThan(over.headerBytes + over.slotArrayBytes);
  });
});

describe('lesson: a hash index', () => {
  const plan = (s: HashIndexScenario) =>
    planHashIndex(hashWrites(s.n, s.seed), { strategy: s.strategy, bucketCapacity: s.cap, initialBuckets: s.init });

  it('extendible: 31 keys, four directory doublings to 16 slots, 10 buckets, several slots sharing one', () => {
    const p = plan(STORAGE_SCENARIOS.hashExtendible);
    expect(p.distinctKeysWritten).toBe(31);
    expect(count(p.events, (e) => e.kind === 'directory-double')).toBe(4);
    expect([p.globalDepth, p.directory.length, p.bucketCount, new Set(p.directory).size]).toEqual([4, 16, 10, 10]);
    expect(Object.values(p.buckets).some((b) => b.localDepth < p.globalDepth)).toBe(true);
  });

  it('linear: seven overflows and seven splits, two of which split a bucket other than the one that overflowed, longest chain two', () => {
    const p = plan(STORAGE_SCENARIOS.hashLinear);
    const events = p.events.filter((e) => e.kind === 'overflow' || e.kind === 'split');
    expect(count(events, (e) => e.kind === 'overflow')).toBe(7);
    expect(count(events, (e) => e.kind === 'split')).toBe(7);
    let different = 0;
    for (let i = 0; i + 1 < events.length; i += 1) {
      const [a, b] = [events[i]!, events[i + 1]!];
      if (a.kind === 'overflow' && b.kind === 'split' && a.bucketsChanged[0] !== b.bucketsChanged[0]) different += 1;
    }
    expect(different).toBe(2);
    expect(p.maxChainLength).toBe(2);
  });

  it('keys 43 to 52 scatter to buckets 0, 3, 0, 2, 5, 6, 5, 5, 3, 3', () => {
    const p = plan(STORAGE_SCENARIOS.hashExtendible);
    expect(p.scatter.map((s) => s.key)).toEqual([43, 44, 45, 46, 47, 48, 49, 50, 51, 52]);
    expect(p.scatter.map((s) => s.bucketId)).toEqual([0, 3, 0, 2, 5, 6, 5, 5, 3, 3]);
  });
});

describe('lesson: the LSM tree', () => {
  it('leveled: 60 writes are 31 keys, 15 flushes and 12 compactions, written 3.9 times each, 39 entries for 31 keys', () => {
    const p = lsm(STORAGE_SCENARIOS.lsmLeveled);
    expect(p.writes).toHaveLength(60);
    expect(p.distinctKeysWritten).toBe(31);
    expect(count(p.events, (e) => e.kind === 'flush')).toBe(15);
    expect(count(p.events, (e) => e.kind === 'compaction')).toBe(12);
    expect(p.writeAmplification.toFixed(1)).toBe('3.9');
    expect([p.totalEntriesOnDisk, p.spaceAmplification.toFixed(2), p.readAmplificationWorstCase]).toEqual([39, '1.26', 2]);
  });

  it('tiered: 2.3 per write, worst-case read of 3 tables, 45 entries for the same 31 keys', () => {
    const t = lsm(STORAGE_SCENARIOS.lsmTiered);
    const l = lsm(STORAGE_SCENARIOS.lsmLeveled);
    expect(t.writeAmplification.toFixed(1)).toBe('2.3');
    expect(t.writeAmplification).toBeLessThan(l.writeAmplification);
    expect(t.readAmplificationWorstCase).toBe(3);
    expect(t.readAmplificationWorstCase).toBeGreaterThan(l.readAmplificationWorstCase);
    expect([t.totalEntriesOnDisk, t.distinctKeysWritten]).toEqual([45, 31]);
  });

  it('bloom: two bits say maybe to 64% and cost 1.4 tables; eight bits 6% and 0.5, close to leveled; sixteen, none', () => {
    const one = lsm(STORAGE_SCENARIOS.lsmTieredTwoBits);
    expect(Math.round(one.measuredFalsePositiveRate * 100)).toBe(64);
    expect(one.readAmplificationAverage.toFixed(1)).toBe('1.4');

    const eight = lsm(STORAGE_SCENARIOS.lsmTiered);
    expect(Math.round(eight.measuredFalsePositiveRate * 100)).toBe(6);
    expect(eight.readAmplificationAverage.toFixed(1)).toBe('0.5');
    const leveled = lsm(STORAGE_SCENARIOS.lsmLeveled);
    expect(Math.abs(eight.readAmplificationAverage - leveled.readAmplificationAverage)).toBeLessThan(0.05);

    const sixteen = lsm({ ...STORAGE_SCENARIOS.lsmTiered, bits: 16 });
    expect(sixteen.measuredFalsePositiveRate).toBeLessThan(0.01);
  });
});

describe('lesson: rows, columns, or both', () => {
  const s = STORAGE_SCENARIOS.columnarDsm;
  const columns = demoColumns(s.n, s.seed);
  const layout = (name: 'NSM' | 'DSM' | 'PAX') => planLayout(name, columns, s.page);
  const column = (name: string) => columns.find((c) => c.name === name)!.values;

  it('one column of four: 32 pages in a row store, 8 in DSM and PAX; a row needs 1 region, 4 in DSM, 1 in PAX', () => {
    const [nsm, dsm, pax] = [layout('NSM'), layout('DSM'), layout('PAX')];
    expect(nsm.pagesForFullScan).toBe(32);
    expect(Object.values(nsm.pagesForSingleColumnScan)).toEqual([32, 32, 32, 32]);
    expect(Object.values(dsm.pagesForSingleColumnScan)).toEqual([8, 8, 8, 8]);
    expect(Object.values(pax.pagesForSingleColumnScan)).toEqual([8, 8, 8, 8]);
    expect([nsm.regionsToReconstructOneRow, dsm.regionsToReconstructOneRow, pax.regionsToReconstructOneRow]).toEqual([1, 4, 1]);
    expect(columns).toHaveLength(4);
  });

  it('each column’s best encoding, and RLE on the shuffled status is bigger than not compressing', () => {
    expect(encodingSize(column('id'), 'none')).toBe(2000);
    expect([bestEncodingFor(column('id')), encodingSize(column('id'), 'delta')]).toEqual(['delta', 129]);
    expect([bestEncodingFor(column('status_grouped')), encodingSize(column('status_grouped'), 'rle')]).toEqual(['rle', 24]);
    expect(encodingSize(column('status_shuffled'), 'rle')).toBe(2166);
    expect(encodingSize(column('status_shuffled'), 'rle')).toBeGreaterThan(2000);
    expect([bestEncodingFor(column('status_shuffled')), encodingSize(column('status_shuffled'), 'bitpack')]).toEqual(['bitpack', 125]);
    const amount = column('amount');
    expect(bestEncodingFor(amount)).toBe('bitpack');
    expect(Math.round((1 - encodingSize(amount, 'bitpack') / 2000) * 100)).toBe(3);
  });

  it('filter on amount at 80% of its range, return id: 8,000 bytes early, 2,412 late, 103 rows matched', () => {
    const amount = column('amount');
    const lo = Math.min(...amount);
    const hi = Math.max(...amount);
    const m = planMaterialization(columns, 'amount', lo + (hi - lo) * 0.8, 'id');
    expect([m.earlyBytesTouched, m.lateBytesTouched, m.matchingRows]).toEqual([8000, 2412, 103]);
  });
});

describe('lesson: latch crabbing', () => {
  it('four threads, six inserts, fan-out 4: 104 ticks and 224 blocked naive, 82 and 148 crabbing, 3 against 5 latches at once', () => {
    const s = STORAGE_SCENARIOS.latchCrowded;
    const [n, c] = [latch(s, 'naive'), latch(s, 'crabbing')];
    expect([n.ticks, n.totalBlockedTicks, n.maxConcurrentLatches]).toEqual([104, 224, 3]);
    expect([c.ticks, c.totalBlockedTicks, c.maxConcurrentLatches]).toEqual([82, 148, 5]);
    expect(count(n.timeline, (a) => a.kind === 'write')).toBe(24);
  });

  it('both protocols build the same tree, and the engine validator passes it', () => {
    const s = STORAGE_SCENARIOS.latchCrowded;
    const [n, c] = [latch(s, 'naive'), latch(s, 'crabbing')];
    expect([c.finalHeight, c.finalKeyCount]).toEqual([n.finalHeight, n.finalKeyCount]);
    expect(n.treeProblems).toEqual([]);
    expect(c.treeProblems).toEqual([]);
  });

  it('fan-out 6: a crabbing thread holds at most 2 latches where a naive one holds 3; the saving is 15, 22, 27 ticks at 6, 4, 3', () => {
    const s = STORAGE_SCENARIOS.latchWide;
    expect([peak(latch(s, 'naive')), peak(latch(s, 'crabbing'))]).toEqual([3, 2]);
    const saved = (fanout: number) => latch(s, 'naive', fanout).ticks - latch(s, 'crabbing', fanout).ticks;
    expect([saved(6), saved(4), saved(3)]).toEqual([15, 22, 27]);
    expect(peak(latch(s, 'crabbing', 3))).toBe(3);
  });
});

describe('lesson: nearest neighbours', () => {
  const s = STORAGE_SCENARIOS.vectorBig;
  const plan = planVectorIndex(s.n, s.k, s.seed);
  const at = (method: 'brute' | 'ivf' | 'hnsw', parameter: number) =>
    plan.curve.find((c) => c.method === method && c.parameter === parameter)!;

  it('brute force computes 400 distances and is exact', () => {
    expect(at('brute', 400)).toMatchObject({ avgComputations: 400, avgRecall: 1 });
  });

  it('IVF over 20 centroids: 1 cluster ≈ 43 computations and 74%, 2 ≈ 63 and 98%, all 20 cost 420 — more than brute force', () => {
    expect(plan.centroidCount).toBe(20);
    expect([Math.round(at('ivf', 1).avgComputations), at('ivf', 1).avgRecall.toFixed(2)]).toEqual([43, '0.74']);
    expect([Math.round(at('ivf', 2).avgComputations), at('ivf', 2).avgRecall.toFixed(2)]).toEqual([63, '0.98']);
    expect(at('ivf', 20).avgComputations).toBe(420);
    expect(at('ivf', 20).avgComputations).toBeGreaterThan(400);
  });

  it('HNSW: layers of 400, 65, 7, 1 points; beam 20 ≈ 75 computations and 95%, beam 64 ≈ 117 and everything', () => {
    expect(plan.hnswLevelCounts).toEqual([400, 65, 7, 1]);
    expect([Math.round(at('hnsw', 20).avgComputations), at('hnsw', 20).avgRecall.toFixed(2)]).toEqual([75, '0.95']);
    expect([Math.round(at('hnsw', 64).avgComputations), at('hnsw', 64).avgRecall]).toEqual([117, 1]);
  });
});
