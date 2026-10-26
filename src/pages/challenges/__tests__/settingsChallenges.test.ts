import { describe, expect, it } from 'vitest';
import { buildHeap, createSeedDatabase, DEFAULT_ENGINE_OPTIONS, OPTIMIZER_RULES, REPLACEMENT_POLICY_LABELS, REPLACEMENT_POLICY_NAMES } from '../../../engine/index.ts';
import { parseReferenceScans, runBufferTrace } from '../../../engine/bufferTrace.ts';
import { HERMITAGE_TESTS } from '../../../engine/hermitage.ts';
import { COLUMNAR_LIMITS, demoColumns, planLayout } from '../../../ui/columnar.ts';
import { planExternalSort, shuffledRange, SORT_LIMITS } from '../../../ui/externalSort.ts';
import { demoKeys, HASH_JOIN_LIMITS, planHashJoin } from '../../../ui/hashJoin.ts';
import { demoWrites as hashWrites, HASH_LIMITS, planHashIndex } from '../../../ui/hashIndex.ts';
import { DEMO_INITIAL_KEYS, demoScripts, LATCH_LIMITS, planLatchCrabbing } from '../../../ui/latchCrabbing.ts';
import { demoWrites as lsmWrites, LSM_LIMITS, planLsm } from '../../../ui/lsm.ts';
import { layOutPage } from '../../../ui/slottedPage.ts';
import { planVectorIndex, VECTOR_LIMITS } from '../../../ui/vectorIndex.ts';
import { CHALLENGES } from '../challenges.tsx';
import { SCRIPT_CHALLENGES } from '../scriptChallenges.tsx';
import { SETTINGS_CHALLENGES, settingsChallengeById } from '../settingsChallenges.tsx';
import type { Control, SettingsChallenge } from '../settingsChallenges.tsx';
import { loadCheckers, readValues, runSettings, runWith, SETTINGS_TOOLS } from '../settingsRunner.ts';

const challenge = (id: string) => settingsChallengeById(id)!;
/** The challenge's starter, with some settings replaced. */
const given = (id: string, over: Record<string, string | number>) => ({
  ...challenge(id).starter,
  ...Object.fromEntries(Object.entries(over).map(([k, v]) => [k, String(v)])),
});

/** Every tool's checks, loaded once — the modules the runner fetches one at a time when a challenge opens. */
const CHECKERS = Object.fromEntries(await Promise.all(SETTINGS_TOOLS.map(async (t) => [t, await loadCheckers(t)] as const)));
/** The run `runSettings` makes after its tool's module has loaded, so a test does not have to wait to read a number. */
const runChallenge = (c: SettingsChallenge, raw: Readonly<Record<string, string>>) => runWith(CHECKERS[c.tool]!, c, raw);
const run = (id: string, over: Record<string, string | number> = {}) => runChallenge(challenge(id), given(id, over));

describe('settings challenges', () => {
  it('have ids that are unique across every challenge, and a check each', () => {
    const ids = [...CHALLENGES, ...SCRIPT_CHALLENGES, ...SETTINGS_CHALLENGES].map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    const checked = Object.values(CHECKERS).flatMap((m) => Object.keys(m));
    expect(checked.sort()).toEqual(SETTINGS_CHALLENGES.map((c) => c.id).sort());
  });

  it('keep each check in the module of the tool its challenge is about, and no check in another’s', () => {
    for (const tool of SETTINGS_TOOLS) {
      const own = SETTINGS_CHALLENGES.filter((c) => c.tool === tool).map((c) => c.id);
      expect(Object.keys(CHECKERS[tool]!).sort(), tool).toEqual(own.sort());
      expect(own.length, `${tool} has no challenge`).toBeGreaterThan(0);
    }
  });

  it('load a tool’s checks once, and the lazy path gives the answer the loaded one does', async () => {
    expect(loadCheckers('sort')).toBe(loadCheckers('sort'));
    for (const c of SETTINGS_CHALLENGES) {
      expect(await runSettings(c, c.starter), c.id).toEqual(runChallenge(c, c.starter));
    }
  });

  it('say so in words when a tool’s checks cannot be loaded, and ask again next time', async () => {
    const broken = { ...challenge('one-merge-pass'), tool: 'not-a-tool' } as unknown as SettingsChallenge;
    const r = await runSettings(broken, broken.starter);
    expect(r.passed).toBe(false);
    expect(r.problem).toMatch(/could not be loaded/);
    expect(r.facts).toEqual([]);
    expect((await runSettings(challenge('one-merge-pass'), challenge('one-merge-pass').starter)).problem).toBeNull();
  });

  it('cover every storage and execution tool', () => {
    expect([...new Set(SETTINGS_CHALLENGES.map((c) => c.tool))].sort()).toEqual(
      [
        'btree',
        'buffer-pool',
        'columnar',
        'hash-index',
        'hash-join',
        'isolation',
        'join-order',
        'latch-crabbing',
        'lsm',
        'page',
        'planner',
        'sort',
        'vector-index',
      ].sort(),
    );
    expect(SETTINGS_CHALLENGES.length).toBe(17);
    expect(SETTINGS_CHALLENGES.filter((c) => c.group === 'transactions').map((c) => c.id)).toEqual([
      'same-level-different-promise',
    ]);
  });

  it('every control spans the range its tool accepts, and every starter is inside it', () => {
    const lastPage = buildHeap(createSeedDatabase().tables.users!, DEFAULT_ENGINE_OPTIONS.rowsPerPage).pages.length - 1;
    // `[min, max]` per control key, from the drivers' own limits. A value outside a tool's range opens the tool at its
    // default, not at the nearest edge, so a control must not offer one.
    const ranges: Record<string, Record<string, [number, number]>> = {
      'one-merge-pass': {
        n: [SORT_LIMITS.minRecords, SORT_LIMITS.maxRecords],
        page: [SORT_LIMITS.minPageSize, SORT_LIMITS.maxPageSize],
        mem: [SORT_LIMITS.minMemPages, SORT_LIMITS.maxMemPages],
      },
      'more-memory-more-io': {
        build: [HASH_JOIN_LIMITS.minBuildKeys, HASH_JOIN_LIMITS.maxBuildKeys],
        probe: [HASH_JOIN_LIMITS.minProbeKeys, HASH_JOIN_LIMITS.maxProbeKeys],
        page: [HASH_JOIN_LIMITS.minPageSize, HASH_JOIN_LIMITS.maxPageSize],
        // one more buffer page is also run, so the top of the range is one below the tool's
        mem: [HASH_JOIN_LIMITS.minMemPages, HASH_JOIN_LIMITS.maxMemPages - 1],
      },
      'tightest-page': { page: [0, lastPage], bytes: [128, 16384] },
      'split-the-other-bucket': {
        n: [HASH_LIMITS.minWrites, HASH_LIMITS.maxWrites],
        cap: [HASH_LIMITS.minBucketCapacity, HASH_LIMITS.maxBucketCapacity],
        init: [HASH_LIMITS.minInitialBuckets, HASH_LIMITS.maxInitialBuckets],
      },
      'cheap-writes-cheap-reads': {
        n: [LSM_LIMITS.minWrites, LSM_LIMITS.maxWrites],
        mem: [LSM_LIMITS.minMemtableCapacity, LSM_LIMITS.maxMemtableCapacity],
        trigger: [LSM_LIMITS.minL0Trigger, LSM_LIMITS.maxL0Trigger],
        bits: [LSM_LIMITS.minBitsPerKey, LSM_LIMITS.maxBitsPerKey],
      },
      'write-amp-below-one': {
        n: [LSM_LIMITS.minWrites, LSM_LIMITS.maxWrites],
        mem: [LSM_LIMITS.minMemtableCapacity, LSM_LIMITS.maxMemtableCapacity],
        trigger: [LSM_LIMITS.minL0Trigger, LSM_LIMITS.maxL0Trigger],
      },
      'column-store-saving': {
        n: [COLUMNAR_LIMITS.minRows, COLUMNAR_LIMITS.maxRows],
        page: [COLUMNAR_LIMITS.minPageSize, COLUMNAR_LIMITS.maxPageSize],
      },
      'crabbing-saves-a-fifth': {
        fanout: [LATCH_LIMITS.minFanout, LATCH_LIMITS.maxFanout],
        threads: [LATCH_LIMITS.minThreads, LATCH_LIMITS.maxThreads],
        ops: [LATCH_LIMITS.minOpsPerThread, LATCH_LIMITS.maxOpsPerThread],
      },
      'win-despite-restarts': {
        fanout: [LATCH_LIMITS.minFanout, LATCH_LIMITS.maxFanout],
        threads: [LATCH_LIMITS.minThreads, LATCH_LIMITS.maxThreads],
        ops: [LATCH_LIMITS.minOpsPerThread, LATCH_LIMITS.maxOpsPerThread],
      },
      'recall-for-a-quarter': {
        n: [VECTOR_LIMITS.minPoints, VECTOR_LIMITS.maxPoints],
        k: [VECTOR_LIMITS.minK, VECTOR_LIMITS.maxK],
        parameter: [1, VECTOR_LIMITS.maxPoints],
      },
      // The buffer pool sandbox takes 2 to 8 frames (one more is also run, so the first challenge stops at 7), and a
      // scan ring of 0 to 4; the B+Tree sandbox a fan-out of 3 to 6.
      'bigger-pool-more-misses': { frames: [2, 7] },
      'clock-is-not-lru': { frames: [2, 8] },
      'scan-keeps-the-hot-set': { frames: [2, 8], ring: [0, 4] },
      'third-level': { fanout: [3, 6], keys: [1, 200] },
    };
    for (const c of SETTINGS_CHALLENGES) {
      const want = ranges[c.id] ?? {};
      const numeric = c.controls.filter((x): x is Extract<Control, { kind: 'number' }> => x.kind === 'number');
      expect(numeric.map((x) => x.key).sort(), c.id).toEqual(Object.keys(want).sort());
      for (const control of numeric) {
        expect([control.min, control.max], `${c.id}.${control.key}`).toEqual(want[control.key]);
      }
      // The starter fills every control, with a value the form accepts.
      expect(Object.keys(c.starter).sort(), c.id).toEqual(c.controls.map((x) => x.key).sort());
      const read = readValues(c, c.starter);
      expect(typeof read === 'string' ? read : 'ok', `${c.id} starter`).toBe('ok');
    }
  });

  it('offers exactly the policies, rules and anomalies the tools have', () => {
    const options = (id: string, key: string) => {
      const control = challenge(id).controls.find((c) => c.key === key)!;
      if (control.kind !== 'select' && control.kind !== 'checks') throw new Error(`${id}.${key} has no options`);
      return control.options;
    };
    for (const id of ['bigger-pool-more-misses', 'scan-keeps-the-hot-set']) {
      expect(options(id, 'policy').map((o) => o.value), id).toEqual([...REPLACEMENT_POLICY_NAMES]);
      for (const o of options(id, 'policy')) {
        expect(o.label).toBe(REPLACEMENT_POLICY_LABELS[o.value as keyof typeof REPLACEMENT_POLICY_LABELS]);
      }
    }
    expect(options('index-with-two-rules', 'rules').map((o) => o.value)).toEqual([...OPTIMIZER_RULES]);
    expect(options('same-level-different-promise', 'anomaly').map((o) => o.label)).toEqual(
      HERMITAGE_TESTS.map((t) => `${t.id} ${t.name}`),
    );
    expect(options('same-level-different-promise', 'anomaly').map((o) => o.value)).toEqual(HERMITAGE_TESTS.map((t) => t.id));
  });

  it('start from settings that run and do not pass', () => {
    for (const c of SETTINGS_CHALLENGES) {
      const r = runChallenge(c, c.starter);
      expect(r.problem, `${c.id}: ${r.problem ?? ''}`).toBeNull();
      expect(r.passed, `${c.id} starter should not pass`).toBe(false);
      expect(r.facts.length, c.id).toBeGreaterThan(0);
    }
  });

  // One known solution each, and then the others it should have too.
  const solutions: [string, Record<string, string | number>][] = [
    ['one-merge-pass', { n: 48, page: 4, mem: 4 }],
    ['one-merge-pass', { n: 64, page: 4, mem: 6 }],
    ['more-memory-more-io', { build: 12, probe: 20, page: 2, mem: 3 }],
    ['more-memory-more-io', { build: 10, probe: 6, page: 2, mem: 3 }],
    ['cheapest-order', { first: 'departments', second: 'employees', third: 'timesheets', fourth: 'projects' }],
    ['cheapest-order', { first: 'timesheets', second: 'employees', third: 'departments', fourth: 'projects' }],
    ['tightest-page', { page: 0, bytes: 202 }],
    ['tightest-page', { page: 5, bytes: 200 }],
    ['split-the-other-bucket', { n: 40, strategy: 'linear', cap: 4, init: 2 }],
    ['split-the-other-bucket', { n: 60, strategy: 'linear', cap: 2, init: 1 }],
    ['cheap-writes-cheap-reads', { strategy: 'tiered' }],
    ['cheap-writes-cheap-reads', { strategy: 'leveled', mem: 8, trigger: 6 }],
    ['write-amp-below-one', { n: 20, mem: 8, trigger: 6 }],
    ['write-amp-below-one', { n: 10, mem: 4, trigger: 4 }],
    ['column-store-saving', { n: 500, page: 256, layout: 'PAX' }],
    ['column-store-saving', { n: 200, page: 64, layout: 'PAX' }],
    ['crabbing-saves-a-fifth', { fanout: 3, threads: 3, ops: 6 }],
    ['crabbing-saves-a-fifth', { fanout: 5, threads: 3, ops: 6 }],
    ['win-despite-restarts', { fanout: 6, threads: 4, ops: 6 }],
    ['win-despite-restarts', { fanout: 4, threads: 4, ops: 4 }],
    // Exactly four restarts, the fewest that count.
    ['win-despite-restarts', { fanout: 6, threads: 3, ops: 4 }],
    ['recall-for-a-quarter', { method: 'ivf', parameter: 2 }],
    ['recall-for-a-quarter', { method: 'hnsw', parameter: 20 }],
    ['bigger-pool-more-misses', { policy: 'fifo' }],
    ['bigger-pool-more-misses', { policy: 'second-chance' }],
    ['clock-is-not-lru', { ref: '0 1 2 0 3 0 4 2 3 0 3 2', frames: 3 }],
    ['clock-is-not-lru', { ref: '1 2 3 4 1 2 5 1 2 3 4 5', frames: 3 }],
    ['scan-keeps-the-hot-set', { policy: 'lru-k' }],
    ['scan-keeps-the-hot-set', { policy: 'lru', ring: 2 }],
    ['scan-keeps-the-hot-set', { policy: 'lru', frames: 8, ring: 3 }],
    ['index-with-two-rules', { rules: 'predicate-pushdown,index-selection' }],
    ['third-level', { fanout: 3, keys: 10 }],
    ['third-level', { fanout: 3, keys: 12 }],
    ['same-level-different-promise', { anomaly: 'PMP' }],
    ['same-level-different-promise', { anomaly: 'G2-item' }],
  ];

  it('has a solution wired for every challenge', () => {
    expect([...new Set(solutions.map(([id]) => id))].sort()).toEqual(SETTINGS_CHALLENGES.map((c) => c.id).sort());
  });

  it('accepts the known solutions', () => {
    for (const [id, over] of solutions) {
      const r = run(id, over);
      expect(r.problem, `${id} ${JSON.stringify(over)}`).toBeNull();
      expect(r.passed, `${id} rejected ${JSON.stringify(over)}`).toBe(true);
    }
  });

  describe('reject the near-misses', () => {
    const misses: [string, string, Record<string, string | number>][] = [
      ['one-merge-pass', 'the starter: four merge passes', {}],
      ['one-merge-pass', 'one merge pass over too few records', { n: 40, page: 4, mem: 4 }],
      ['one-merge-pass', 'a sort that fits in memory and never merges', { n: 24, page: 4, mem: 6 }],
      ['one-merge-pass', 'three merge passes', { n: 64, page: 4, mem: 3 }],
      ['more-memory-more-io', 'one more page that makes the join far cheaper', {}],
      ['more-memory-more-io', 'one more page that changes nothing', { build: 12, probe: 20, page: 2, mem: 4 }],
      ['more-memory-more-io', 'a join that fits either way', { build: 12, probe: 20, page: 4, mem: 3 }],
      ['cheapest-order', 'the order as written', {}],
      ['cheapest-order', 'ending on departments', { first: 'employees', second: 'timesheets', third: 'projects', fourth: 'departments' }],
      ['cheapest-order', 'timesheets before the branch that feeds it', { first: 'departments', second: 'timesheets', third: 'employees', fourth: 'projects' }],
      ['tightest-page', 'one byte too few', { page: 0, bytes: 201 }],
      ['tightest-page', 'one byte spare', { page: 0, bytes: 203 }],
      ['tightest-page', 'the size of another page', { page: 0, bytes: 200 }],
      ['split-the-other-bucket', 'extendible hashing, which splits the full bucket', { n: 100, strategy: 'extendible', cap: 2, init: 1 }],
      ['split-the-other-bucket', 'linear, with two such splits', { n: 60, strategy: 'linear', cap: 4, init: 2 }],
      ['split-the-other-bucket', 'linear, with room for everything', { n: 60, strategy: 'linear', cap: 8, init: 4 }],
      ['cheap-writes-cheap-reads', 'leveled compaction: cheap reads, dear writes', {}],
      ['cheap-writes-cheap-reads', 'tiered with a thin filter: cheap writes, dear reads', { strategy: 'tiered', bits: 2 }],
      ['cheap-writes-cheap-reads', 'tiered with a tiny memtable and trigger', { strategy: 'tiered', mem: 2, trigger: 2 }],
      ['cheap-writes-cheap-reads', 'a run too short to count: 30 writes, WA 1.4 and 0.5', { n: 30, strategy: 'tiered', mem: 8, trigger: 3 }],
      ['write-amp-below-one', 'a long run of small memtables', {}],
      ['write-amp-below-one', 'big memtables, but sixty writes of merging', { n: 60, mem: 8, trigger: 6 }],
      ['write-amp-below-one', 'cheap writes, still more than one for each: 1.4', { n: 60, strategy: 'tiered', mem: 8, trigger: 6 }],
      ['column-store-saving', 'the table is a page', {}],
      ['column-store-saving', 'DSM rebuilds a row from four regions', { n: 500, page: 256, layout: 'DSM' }],
      ['column-store-saving', 'NSM cannot skip a column', { n: 500, page: 256, layout: 'NSM' }],
      ['column-store-saving', 'PAX over a table of two pages', { n: 100, page: 1024, layout: 'PAX' }],
      ['column-store-saving', 'PAX over four pages: a quarter, but too small a table', { n: 50, page: 256, layout: 'PAX' }],
      ['crabbing-saves-a-fifth', 'two threads, six keys to a page', {}],
      ['crabbing-saves-a-fifth', 'a busy, wide tree: 17%', { fanout: 6, threads: 4, ops: 6 }],
      ['crabbing-saves-a-fifth', 'a busy tree, a fan-out of four: 17%', { fanout: 4, threads: 4, ops: 4 }],
      ['win-despite-restarts', 'two threads, one insert each: a tie at 10 ticks', {}],
      ['win-despite-restarts', 'two threads on wide pages: a restart costs more than it saves', { fanout: 5, threads: 2, ops: 2 }],
      ['win-despite-restarts', 'faster, but one restart', { fanout: 4, threads: 3, ops: 2 }],
      ['win-despite-restarts', 'faster, but three restarts', { fanout: 5, threads: 3, ops: 6 }],
      ['win-despite-restarts', 'four restarts and not a tick faster: 29 and 29', { fanout: 6, threads: 3, ops: 3 }],
      ['recall-for-a-quarter', 'probing one cluster: cheap and 74% recall', {}],
      ['recall-for-a-quarter', 'probing every cluster: dearer than brute force', { method: 'ivf', parameter: 20 }],
      ['recall-for-a-quarter', 'a beam of 64: complete, and 29% of the work', { method: 'hnsw', parameter: 64 }],
      ['recall-for-a-quarter', 'a small table', { n: 100, k: 10, method: 'ivf', parameter: 2 }],
      ['bigger-pool-more-misses', 'LRU, which never does', {}],
      ['bigger-pool-more-misses', 'FIFO on a string where a fourth frame helps', { policy: 'fifo', ref: '0 1 2 3 4 0 1 2 3 4', frames: 4 }],
      ['bigger-pool-more-misses', 'a pool that already holds every page', { policy: 'fifo', ref: '0 1 2 0 1 2', frames: 3 }],
      ['clock-is-not-lru', 'a loop, where both evict alike', {}],
      ['clock-is-not-lru', 'a string with no evictions at all', { ref: '0 1 2', frames: 4 }],
      ['scan-keeps-the-hot-set', 'LRU with no ring', {}],
      ['scan-keeps-the-hot-set', '2Q, which a one-time scan still floods', { policy: 'two-q' }],
      ['scan-keeps-the-hot-set', 'a ring of three in a pool of six', { policy: 'lru', ring: 3 }],
      ['scan-keeps-the-hot-set', 'midpoint LRU, one hit short', { policy: 'midpoint' }],
      ['index-with-two-rules', 'all seven', {}],
      ['index-with-two-rules', 'the index rule alone', { rules: 'index-selection' }],
      ['index-with-two-rules', 'pushdown alone', { rules: 'predicate-pushdown' }],
      ['index-with-two-rules', 'a lookup, but with three rules on', { rules: 'constant-folding,predicate-pushdown,index-selection' }],
      ['index-with-two-rules', 'no rules at all', { rules: '' }],
      ['third-level', 'fan-out four, twelve keys: two levels', {}],
      ['third-level', 'fan-out three, one key short', { fanout: 3, keys: 9 }],
      ['third-level', 'three levels, but seventeen keys', { fanout: 4, keys: 17 }],
      ['third-level', 'a wide page', { fanout: 6, keys: 12 }],
      ['same-level-different-promise', 'write cycles, prevented by both', { anomaly: 'G0' }],
      ['same-level-different-promise', 'anti-dependency cycles, allowed by both', { anomaly: 'G2' }],
      ['same-level-different-promise', 'aborted reads, prevented by both', { anomaly: 'G1a' }],
    ];
    for (const [id, why, over] of misses) {
      it(`${id} rejects ${why}`, () => {
        const r = run(id, over);
        expect(r.problem).toBeNull();
        expect(r.passed).toBe(false);
      });
    }
  });

  it('says what is wrong with a setting the tool would not accept, and runs nothing', () => {
    const c = challenge('one-merge-pass');
    expect(readValues(c, { ...c.starter, n: '' })).toMatch(/^Records must be a whole number from 6 to 64/);
    expect(readValues(c, { ...c.starter, mem: '2' })).toMatch(/^Buffer pages must be a whole number from 3 to 6/);
    expect(readValues(c, { ...c.starter, page: '2.5' })).toMatch(/whole number/);
    expect(readValues(challenge('column-store-saving'), { ...challenge('column-store-saving').starter, layout: 'XYZ' })).toMatch(
      /^Choose a value for Layout/,
    );
    const r = run('one-merge-pass', { n: 99 });
    expect(r.problem).not.toBeNull();
    expect([r.passed, r.facts, r.tables, r.toolHref]).toEqual([false, [], [], null]);
  });

  it('asks for each table once in an order, and says so', () => {
    const r = run('cheapest-order', { first: 'departments', second: 'departments' });
    expect(r.problem).toMatch(/each of the four tables exactly once/i);
    expect(r.passed).toBe(false);
  });

  it('keeps the vector index’s parameters inside what the method has', () => {
    expect(run('recall-for-a-quarter', { method: 'ivf', parameter: 25 }).problem).toMatch(/20 clusters: probe from 1 to 20/);
    expect(run('recall-for-a-quarter', { n: 100, method: 'hnsw', parameter: 101 }).problem).toMatch(/from 1 to 100/);
    expect(run('recall-for-a-quarter', { method: 'hnsw', parameter: 400 }).problem).toBeNull();
  });

  it('hands over a link that opens the tool on the settings that were run', () => {
    const params = (href: string) => new URL(href, 'https://x');
    const expectations: [string, Record<string, string | number>, string, Record<string, string>][] = [
      ['one-merge-pass', { n: 48, page: 4, mem: 4 }, '/tools/sort', { n: '48', page: '4', mem: '4', seed: '1' }],
      ['more-memory-more-io', { build: 12, probe: 20, page: 2, mem: 3 }, '/tools/hash-join', { build: '12', probe: '20', page: '2', mem: '3' }],
      ['cheapest-order', {}, '/tools/join-order', {}],
      ['tightest-page', { page: 0, bytes: 202 }, '/tools/page', { page: '0', bytes: '202' }],
      ['split-the-other-bucket', { n: 40, strategy: 'linear', cap: 4, init: 2 }, '/tools/hash-index', { n: '40', strategy: 'linear', cap: '4', init: '2' }],
      ['cheap-writes-cheap-reads', { strategy: 'tiered' }, '/tools/lsm', { n: '60', strategy: 'tiered', mem: '4', trigger: '3', bits: '8', base: '8', mult: '2' }],
      ['write-amp-below-one', { n: 20, mem: 8, trigger: 6 }, '/tools/lsm', { n: '20', mem: '8', trigger: '6' }],
      ['column-store-saving', { n: 500, page: 256, layout: 'PAX' }, '/tools/columnar', { n: '500', page: '256', layout: 'PAX' }],
      ['crabbing-saves-a-fifth', { fanout: 3, threads: 3, ops: 6 }, '/tools/latch-crabbing', { fanout: '3', threads: '3', ops: '6' }],
      ['win-despite-restarts', { fanout: 6, threads: 4, ops: 6 }, '/tools/latch-crabbing', { fanout: '6', threads: '4', ops: '6', timeline: 'optimistic' }],
      ['recall-for-a-quarter', { method: 'ivf', parameter: 2 }, '/tools/vector-index', { n: '400', k: '20' }],
      ['bigger-pool-more-misses', { policy: 'fifo' }, '/tools/buffer-pool', { frames: '3', policy: 'fifo', ref: '1 2 3 4 1 2 5 1 2 3 4 5' }],
      ['clock-is-not-lru', { ref: '0 1 2 0 3 0 4 2 3 0 3 2', frames: 3 }, '/tools/buffer-pool', { policy: 'clock', frames: '3' }],
      ['scan-keeps-the-hot-set', { policy: 'lru', ring: 2 }, '/tools/buffer-pool', { policy: 'lru', frames: '6', sr: '2' }],
      ['index-with-two-rules', { rules: 'predicate-pushdown,index-selection' }, '/tools/planner', { idx: '1', rules: 'predicate-pushdown,index-selection' }],
      ['third-level', { fanout: 3, keys: 10 }, '/tools/btree', { fanout: '3', keys: '1,2,3,4,5,6,7,8,9,10' }],
      ['same-level-different-promise', { anomaly: 'PMP' }, '/tools/isolation', { c: 'locks.PMP.repeatable-read' }],
    ];
    for (const [id, over, path, want] of expectations) {
      const url = params(run(id, over).toolHref!);
      expect(url.pathname, id).toBe(path);
      for (const [key, value] of Object.entries(want)) expect(url.searchParams.get(key), `${id} ${key}`).toBe(value);
    }
  });
});

describe('the numbers a player reads are the numbers the tool shows', () => {
  const fact = (id: string, over: Record<string, string | number>, label: string) =>
    run(id, over).facts.find((f) => f.label === label)?.value;

  it('sort: pages, runs, merge passes and I/O are the plan’s', () => {
    const p = planExternalSort(shuffledRange(48, 1), { pageSize: 4, memPages: 4 });
    const over = { n: 48, page: 4, mem: 4 };
    expect(fact('one-merge-pass', over, 'pages of data')).toBe(String(p.pageCount));
    expect(fact('one-merge-pass', over, 'runs after pass 0')).toBe(String(p.initialRunCount));
    expect(fact('one-merge-pass', over, 'merge passes')).toBe(String(p.mergePassCount));
    expect(fact('one-merge-pass', over, 'page I/Os')).toBe(String(p.totalIO));
  });

  it('hash join: the two costs are the plan’s, and the partitioning cost is the same while the reading back is not', () => {
    const { buildKeys, probeKeys } = demoKeys(12, 20, 1);
    const [a, b] = [3, 4].map((m) => planHashJoin(buildKeys, probeKeys, { pageSize: 2, memPages: m }));
    const over = { build: 12, probe: 20, page: 2, mem: 3 };
    expect(fact('more-memory-more-io', over, 'page I/Os with 3 buffer pages')).toBe(String(a!.totalIO));
    expect(fact('more-memory-more-io', over, 'with 4')).toBe(String(b!.totalIO));
    expect(a!.partitionIO).toBe(b!.partitionIO);
    expect(b!.buildProbeIO).toBeGreaterThan(a!.buildProbeIO);
  });

  it('page: a third of every page is not the rows — header, slots and tuple headers', () => {
    const users = createSeedDatabase().tables.users!;
    const heap = buildHeap(users, DEFAULT_ENGINE_OPTIONS.rowsPerPage);
    for (const page of heap.pages) {
      const l = layOutPage(page.rows, users.columns, { pageBytes: 16384 });
      const data = l.tuples.reduce((n, t) => n + t.fields.reduce((m, f) => m + f.bytes, 0), 0);
      const overhead = (l.usedBytes - data) / l.usedBytes;
      expect(overhead, `page ${String(page.pageId)}`).toBeGreaterThan(0.3);
      expect(overhead, `page ${String(page.pageId)}`).toBeLessThan(0.4);
      expect(l.usedBytes).toBeGreaterThanOrEqual(128);
    }
  });

  it('hash index: the count of splits of another bucket is the tool’s three-and-two', () => {
    const [n, cap, init] = [40, 4, 2];
    const p = planHashIndex(hashWrites(n, 1), { strategy: 'linear', bucketCapacity: cap, initialBuckets: init });
    expect(fact('split-the-other-bucket', { n, strategy: 'linear', cap, init }, 'splits of another bucket')).toBe('3');
    expect(fact('split-the-other-bucket', { n, strategy: 'linear', cap, init }, 'buckets')).toBe(String(p.bucketCount));
    expect(fact('split-the-other-bucket', { n: 60, strategy: 'linear', cap: 4, init: 2 }, 'splits of another bucket')).toBe('2');
  });

  it('lsm: the amplification figures are the plan’s', () => {
    const p = planLsm(lsmWrites(60, 1), {
      compactionStrategy: 'tiered',
      memtableCapacity: 4,
      l0CompactionTrigger: 3,
      baseLevelCapacity: 8,
      levelSizeMultiplier: 2,
      bitsPerKey: 8,
    });
    expect(fact('cheap-writes-cheap-reads', { strategy: 'tiered' }, 'write amplification')).toBe(p.writeAmplification.toFixed(2));
    expect(fact('cheap-writes-cheap-reads', { strategy: 'tiered' }, 'read amplification, measured')).toBe(
      p.readAmplificationAverage.toFixed(2),
    );
  });

  it('lsm: a write amplification below 1 comes from repeated keys meeting in the memtable', () => {
    const p = planLsm(lsmWrites(20, 1), {
      compactionStrategy: 'leveled',
      memtableCapacity: 8,
      l0CompactionTrigger: 6,
      baseLevelCapacity: 8,
      levelSizeMultiplier: 2,
      bitsPerKey: 8,
    });
    expect(p.writeAmplification).toBeLessThan(1);
    expect(p.events.every((e) => e.kind === 'flush')).toBe(true); // nothing was merged: the saving is the memtable's
    expect(p.totalEntriesEverWritten).toBeLessThan(p.writes.length);
    expect(p.distinctKeysWritten).toBeLessThan(p.writes.length);
  });

  it('columnar: below a few pages a one-column scan reads a page or two whatever the layout', () => {
    for (const layout of ['NSM', 'DSM', 'PAX'] as const) {
      const plan = planLayout(layout, demoColumns(50, 1), 1024);
      expect(Math.max(...Object.values(plan.pagesForSingleColumnScan)), layout).toBeLessThanOrEqual(2);
    }
  });

  it('latch: the saving is larger in a narrow tree than a wide one, on average over the workloads', () => {
    const saving = (fanout: number) => {
      const shares: number[] = [];
      for (const threads of [3, 4]) {
        for (const ops of [2, 4, 6]) {
          const scripts = demoScripts(threads, ops, 1);
          const n = planLatchCrabbing(DEMO_INITIAL_KEYS, scripts, fanout, 'naive').ticks;
          const c = planLatchCrabbing(DEMO_INITIAL_KEYS, scripts, fanout, 'crabbing').ticks;
          shares.push(1 - c / n);
        }
      }
      return shares.reduce((a, b) => a + b, 0) / shares.length;
    };
    expect(saving(3)).toBeGreaterThan(saving(6));
  });

  it('vector: the averages are the tool’s curve for the same settings', () => {
    const plan = planVectorIndex(400, 20, 1);
    const ivf2 = plan.curve.find((c) => c.method === 'ivf' && c.parameter === 2)!;
    const r = run('recall-for-a-quarter', { method: 'ivf', parameter: 2 });
    expect(r.facts.find((f) => f.label === 'distance computations')!.value).toBe(ivf2.avgComputations.toFixed(1));
    expect(r.facts.find((f) => f.label === 'recall of the true 20')!.value).toBe(`${(ivf2.avgRecall * 100).toFixed(0)}%`);
  });

  it('buffer pool: the misses are the sandbox trace’s, and FIFO’s fourth frame costs one more', () => {
    const misses = (ref: string, frames: number, policy: string) => {
      const { refs, scans } = parseReferenceScans(ref);
      const result = runBufferTrace(refs, { ...DEFAULT_ENGINE_OPTIONS, bufferFrames: frames, policy: policy as never }, scans);
      return result.events.filter((e) => e.stage === 'buffer' && e.action === 'miss').length;
    };
    expect(misses('1 2 3 4 1 2 5 1 2 3 4 5', 3, 'fifo')).toBe(9);
    expect(misses('1 2 3 4 1 2 5 1 2 3 4 5', 4, 'fifo')).toBe(10);
    const r = run('bigger-pool-more-misses', { policy: 'fifo' });
    expect(r.facts.find((f) => f.label === 'misses in 3 frames')!.value).toBe('9');
    expect(r.facts.find((f) => f.label === 'in 4')!.value).toBe('10');
    expect(r.facts.find((f) => f.label === 'difference')!.value).toBe('+1');
  });

  it('buffer pool: LRU and clock differ on the same string, and the table lists both victim sequences', () => {
    const r = run('clock-is-not-lru', { ref: '0 1 2 0 3 0 4 2 3 0 3 2', frames: 3 });
    expect(r.tables[0]!.rows).toEqual([
      ['LRU', '1, 2, 3, 0, 4'],
      ['Clock sweep', '1, 2, 0, 4'],
    ]);
    expect(r.facts.find((f) => f.label === 'misses, LRU / clock')!.value).toBe('8 / 7');
  });

  it('planner: two rules are the least that make the lookup, and no one rule does', () => {
    const rules = [...OPTIMIZER_RULES];
    for (const a of rules) {
      expect(run('index-with-two-rules', { rules: a }).passed, a).toBe(false);
      for (const b of rules) {
        if (a >= b) continue;
        const passed = run('index-with-two-rules', { rules: `${a},${b}` }).passed;
        expect(passed, `${a}+${b}`).toBe(a === 'index-selection' && b === 'predicate-pushdown');
      }
    }
  });

  it('b+tree: the third level comes at 10, 17, 21 and 31 keys for fan-outs of 3 to 6, below what full pages would hold', () => {
    const firstThird = (fanout: number) => {
      for (let keys = 1; keys <= 200; keys += 1) {
        const r = runChallenge(challenge('third-level'), { fanout: String(fanout), keys: String(keys) });
        if (r.facts.find((f) => f.label === 'levels')!.value === '3') return keys;
      }
      return -1;
    };
    expect([3, 4, 5, 6].map(firstThird)).toEqual([10, 17, 21, 31]);
    // A full two-level tree holds (fan-out + 1) pages of fan-out keys: 12, 20, 30 and 42.
    expect([3, 4, 5, 6].map((f) => (f + 1) * f)).toEqual([12, 20, 30, 42]);
  });

  it('isolation: at REPEATABLE READ the engines disagree on exactly the phantom and write skew', () => {
    const differing = HERMITAGE_TESTS.filter((t) => run('same-level-different-promise', { anomaly: t.id }).passed).map((t) => t.id);
    expect(differing).toEqual(['PMP', 'G2-item']);
    const facts = run('same-level-different-promise', { anomaly: 'PMP' }).facts;
    expect(facts.find((f) => f.label === 'with locks')!.value).toBe('happens');
    expect(facts.find((f) => f.label === 'with snapshots')!.value).toBe('prevented');
  });

  it('vector: on 100 points no setting reaches the bar, for k of 10 or 20', () => {
    for (const k of [10, 20]) {
      const hits: string[] = [];
      for (let p = 1; p <= 10; p += 1) if (run('recall-for-a-quarter', { n: 100, k, method: 'ivf', parameter: p }).passed) hits.push(`ivf ${String(p)}`);
      for (let p = 1; p <= 100; p += 3) if (run('recall-for-a-quarter', { n: 100, k, method: 'hnsw', parameter: p }).passed) hits.push(`hnsw ${String(p)}`);
      expect(hits, `k ${String(k)}`).toEqual([]);
    }
  });
});
