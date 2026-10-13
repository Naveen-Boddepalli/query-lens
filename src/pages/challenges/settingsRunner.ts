/**
 * Runs a settings challenge: reads the numbers the player chose, checks they are ones the tool accepts, runs the
 * tool's own driver on them and applies the challenge's check — a pure predicate over what the driver made, as the
 * query and script challenges' checks are over what the engine did. Everything here imports the drivers, so this
 * module is loaded only when one of these challenges is opened.
 *
 * Each driver is called the way its tool's page calls it (same demo data, same seed), so the numbers a player reads
 * here are the numbers the tool shows for the same settings; `__tests__/settingsChallenges.test.ts` holds that, and
 * holds every check against its known solution and the near-misses it must reject.
 */

import {
  buildHeap,
  buildPlan,
  costOfOrder,
  createJoinOrderDemoDatabase,
  createSeedDatabase,
  createTree,
  DEFAULT_ENGINE_OPTIONS,
  height,
  insert,
  joinGraphFromAst,
  OPTIMIZER_RULES,
  optimize,
  parse,
  runJoinOrderDP,
  validate,
} from '../../engine/index.ts';
import type { Plan, ReplacementPolicyName } from '../../engine/index.ts';
import { parseReferenceScans, runBufferTrace } from '../../engine/bufferTrace.ts';
import { HERMITAGE_TESTS, runHermitage } from '../../engine/hermitage.ts';
import { demoColumns, planLayout } from '../../ui/columnar.ts';
import type { Layout } from '../../ui/columnar.ts';
import { planExternalSort, shuffledRange } from '../../ui/externalSort.ts';
import { demoKeys, planHashJoin } from '../../ui/hashJoin.ts';
import { demoWrites as hashWrites, planHashIndex } from '../../ui/hashIndex.ts';
import { DEMO_INITIAL_KEYS, demoScripts, planLatchCrabbing } from '../../ui/latchCrabbing.ts';
import { demoWrites as lsmWrites, planLsm } from '../../ui/lsm.ts';
import { layOutPage } from '../../ui/slottedPage.ts';
import {
  buildHnsw,
  buildIvf,
  demoPoints,
  exactTopK,
  hnswSearch,
  ivfSearch,
  queryPoints,
  recallAt,
  VECTOR_LIMITS,
} from '../../ui/vectorIndex.ts';
import { sandboxHref } from '../learn/sandboxScenarios.ts';
import { storageHref } from '../learn/storageScenarios.ts';
import type { ChallengeOutcome, OutcomeTable } from './outcome.ts';
import type { SettingsChallenge } from './settingsChallenges.tsx';

export type SettingsRun = ChallengeOutcome;

/** The seed every one of these runs under, and the tool's own default — so a link opens on the same numbers. */
const SEED = 1;

type Values = Record<string, number | string>;

interface Verdict {
  passed: boolean;
  facts: { label: string; value: string }[];
  tables?: OutcomeTable[];
  toolHref: string;
  /** Set when the settings were fine for the tool but not for the question: nothing to run. */
  problem?: string;
}

const pct = (x: number): string => `${(x * 100).toFixed(0)}%`;
const fixed = (x: number, d = 2): string => x.toFixed(d);
const num = (v: Values, key: string): number => Number(v[key]);
const str = (v: Values, key: string): string => String(v[key]);

// — the join-order demo, as the tool builds it —

const JOIN_ORDER_SQL =
  'SELECT * FROM departments\n' +
  '  JOIN projects ON departments.id = projects.deptId\n' +
  '  JOIN employees ON departments.id = employees.deptId\n' +
  '  JOIN timesheets ON employees.id = timesheets.employeeId';

function joinOrderGraph() {
  const parsed = parse(JOIN_ORDER_SQL);
  if (!parsed.ok) throw new Error('the join-order demo query must parse');
  const db = createJoinOrderDemoDatabase();
  const { nodes, edges } = joinGraphFromAst(parsed.ast, db.tables, DEFAULT_ENGINE_OPTIONS.rowsPerPage);
  return { nodes, edges, optimum: runJoinOrderDP(nodes, edges).winner };
}

/** An order within this factor of the cheapest is "the optimum too", as the tool itself says it. */
const NEAR_OPTIMUM = 1.05;

// — the slotted page's demo, as the page tool builds it —

function usersPages() {
  const users = createSeedDatabase().tables.users!;
  return { users, heap: buildHeap(users, DEFAULT_ENGINE_OPTIONS.rowsPerPage) };
}

/** The splits a linear-hashing run made of a bucket other than the one that had just overflowed. */
function splitsOfAnotherBucket(events: readonly { kind: string; bucketsChanged: number[] }[]): number {
  const steps = events.filter((e) => e.kind === 'overflow' || e.kind === 'split');
  let other = 0;
  for (let i = 0; i + 1 < steps.length; i += 1) {
    const [a, b] = [steps[i]!, steps[i + 1]!];
    if (a.kind === 'overflow' && b.kind === 'split' && a.bucketsChanged[0] !== b.bucketsChanged[0]) other += 1;
  }
  return other;
}

/** The average, over the tool's twenty queries, of a vector search's cost and recall — the tool's own averaging. */
function vectorAverage(n: number, k: number, method: 'ivf' | 'hnsw', parameter: number) {
  const points = demoPoints(n, SEED);
  const queries = queryPoints(VECTOR_LIMITS.queries, SEED);
  const truths = queries.map((q) => exactTopK(points, q, k));
  const centroids = Math.max(2, Math.round(Math.sqrt(n)));
  const ivf = method === 'ivf' ? buildIvf(points, centroids, SEED) : null;
  const hnsw = method === 'hnsw' ? buildHnsw(points, SEED) : null;
  let computations = 0;
  let recall = 0;
  queries.forEach((q, i) => {
    const r = ivf ? ivfSearch(points, ivf, q, k, parameter) : hnswSearch(points, hnsw!, q, k, parameter);
    computations += r.computations;
    recall += recallAt(r.ids, truths[i]!);
  });
  return { computations: computations / queries.length, recall: recall / queries.length, centroids };
}

// — the buffer pool sandbox, as the tool runs it —

/** The scan the `scan-keeps-the-hot-set` challenge asks about: a hot set, a 21-page scan, the hot set again. */
const HOT_SET_SCAN = '0 1 2 3 0 1 2 3 0 1 2 3 10-30 0 1 2 3 0 1 2 3';

function bufferRun(ref: string, frames: number, policy: string, scanRing = 0) {
  const { refs, scans } = parseReferenceScans(ref);
  const result = runBufferTrace(
    refs,
    { ...DEFAULT_ENGINE_OPTIONS, bufferFrames: frames, policy: policy as ReplacementPolicyName, readAhead: 0, scanRing },
    scans,
  );
  let hits = 0;
  let misses = 0;
  const victims: number[] = [];
  for (const e of result.events) {
    if (e.stage !== 'buffer') continue;
    if (e.action === 'hit') hits += 1;
    else if (e.action === 'miss') misses += 1;
    else if (e.action === 'evict') victims.push(e.victimPageId);
  }
  return { references: refs.length, hits, misses, victims };
}

/** Every operator of a plan, root first. */
function operatorsOf(plan: Plan): string[] {
  const out: string[] = [];
  const walk = (node: Record<string, unknown>) => {
    out.push(String(node.op));
    for (const key of ['child', 'left', 'right']) if (node[key]) walk(node[key] as Record<string, unknown>);
    if (Array.isArray(node.children)) for (const c of node.children) walk(c as Record<string, unknown>);
  };
  walk(plan);
  return out;
}

const PLANNER_QUERY = 'SELECT name, email\nFROM users\nWHERE id = 5 AND age > 30';

const HANDLERS: Record<string, (v: Values) => Verdict> = {
  'one-merge-pass': (v) => {
    const n = num(v, 'n');
    const p = planExternalSort(shuffledRange(n, SEED), { pageSize: num(v, 'page'), memPages: num(v, 'mem') });
    return {
      passed: n >= 48 && p.mergePassCount === 1,
      facts: [
        { label: 'records', value: String(n) },
        { label: 'pages of data', value: String(p.pageCount) },
        { label: 'runs after pass 0', value: String(p.initialRunCount) },
        { label: 'runs merged at once', value: String(p.fanIn) },
        { label: 'merge passes', value: String(p.mergePassCount) },
        { label: 'page I/Os', value: String(p.totalIO) },
      ],
      toolHref: storageHref({ tool: 'sort', n, page: num(v, 'page'), mem: num(v, 'mem'), seed: SEED }),
    };
  },

  'more-memory-more-io': (v) => {
    const [build, probe, page, mem] = [num(v, 'build'), num(v, 'probe'), num(v, 'page'), num(v, 'mem')];
    const { buildKeys, probeKeys } = demoKeys(build, probe, SEED);
    const at = (memPages: number) => planHashJoin(buildKeys, probeKeys, { pageSize: page, memPages });
    const [less, more] = [at(mem), at(mem + 1)];
    const row = (memPages: number, p: ReturnType<typeof at>): string[] => [
      String(memPages),
      p.fitsInMemory ? 'none — it fits' : String(p.numPartitions),
      String(p.partitionIO),
      String(p.buildProbeIO),
      String(p.totalIO),
    ];
    return {
      passed: more.totalIO > less.totalIO,
      facts: [
        { label: `page I/Os with ${String(mem)} buffer pages`, value: String(less.totalIO) },
        { label: `with ${String(mem + 1)}`, value: String(more.totalIO) },
        { label: 'difference', value: `${more.totalIO >= less.totalIO ? '+' : ''}${String(more.totalIO - less.totalIO)}` },
      ],
      tables: [
        {
          caption: 'The same join, one buffer page apart',
          columns: ['Buffer pages', 'Partitions', 'Partitioning I/O', 'Build and probe I/O', 'Total I/O'],
          rows: [row(mem, less), row(mem + 1, more)],
        },
      ],
      toolHref: storageHref({ tool: 'hash-join', build, probe, page, mem, seed: SEED }),
    };
  },

  'cheapest-order': (v) => {
    const order = ['first', 'second', 'third', 'fourth'].map((key) => str(v, key));
    const { nodes, edges, optimum } = joinOrderGraph();
    const names = nodes.map((node) => node.name);
    if (new Set(order).size !== order.length || !order.every((t) => names.includes(t))) {
      return {
        passed: false,
        facts: [],
        problem: `Use each of the four tables exactly once — now it reads ${order.join(', ')}.`,
        toolHref: '/tools/join-order',
      };
    }
    const cost = costOfOrder(nodes, edges, order);
    return {
      passed: cost.pages <= optimum.pages * NEAR_OPTIMUM,
      facts: [
        { label: 'estimated pages', value: cost.pages.toLocaleString('en-US') },
        { label: 'cheapest found', value: optimum.pages.toLocaleString('en-US') },
        { label: 'against the cheapest', value: `${fixed(cost.pages / optimum.pages, 1)}×` },
        { label: 'rows out (estimated)', value: cost.rows.toLocaleString('en-US') },
      ],
      toolHref: '/tools/join-order',
    };
  },

  'tightest-page': (v) => {
    const { users, heap } = usersPages();
    const [pageId, bytes] = [num(v, 'page'), num(v, 'bytes')];
    const page = heap.pages[pageId];
    if (!page) {
      return { passed: false, facts: [], problem: `There is no heap page ${String(pageId)}.`, toolHref: '/tools/page' };
    }
    const l = layOutPage(page.rows, users.columns, { pageBytes: bytes });
    const data = l.tuples.reduce((n, t) => n + t.fields.reduce((m, f) => m + f.bytes, 0), 0);
    return {
      passed: !l.overflow && l.freeBytes === 0,
      facts: [
        { label: 'rows', value: String(page.rows.length) },
        { label: 'bytes the rows need', value: String(l.usedBytes) },
        { label: 'of which the rows’ own data', value: String(data) },
        { label: 'page size', value: String(bytes) },
        { label: 'free', value: l.overflow ? 'overflow' : String(l.freeBytes) },
      ],
      toolHref: storageHref({ tool: 'page', page: pageId, bytes }),
    };
  },

  'split-the-other-bucket': (v) => {
    const strategy = str(v, 'strategy') === 'linear' ? 'linear' : 'extendible';
    const [n, cap, init] = [num(v, 'n'), num(v, 'cap'), num(v, 'init')];
    const p = planHashIndex(hashWrites(n, SEED), { strategy, bucketCapacity: cap, initialBuckets: init });
    const other = splitsOfAnotherBucket(p.events);
    const count = (kind: string) => p.events.filter((e) => e.kind === kind).length;
    return {
      passed: other >= 3,
      facts: [
        { label: 'inserts that overflowed a bucket', value: String(count('overflow')) },
        { label: 'splits', value: String(count('split')) },
        { label: 'splits of another bucket', value: String(other) },
        { label: 'buckets', value: String(p.bucketCount) },
        { label: 'longest chain', value: String(p.maxChainLength) },
      ],
      toolHref: storageHref({ tool: 'hash-index', n, strategy, cap, init, seed: SEED }),
    };
  },

  'bigger-pool-more-misses': (v) => {
    const [ref, frames, policy] = [str(v, 'ref'), num(v, 'frames'), str(v, 'policy')];
    const href = sandboxHref({ tool: 'buffer-pool', ref, frames, policy, ra: 0, sr: 0 });
    const less = bufferRun(ref, frames, policy);
    if (less.references === 0) {
      return { passed: false, facts: [], problem: 'Write at least one page number.', toolHref: href };
    }
    const more = bufferRun(ref, frames + 1, policy);
    return {
      passed: more.misses > less.misses,
      facts: [
        { label: 'references', value: String(less.references) },
        { label: `misses in ${String(frames)} frames`, value: String(less.misses) },
        { label: `in ${String(frames + 1)}`, value: String(more.misses) },
        { label: 'difference', value: `${more.misses >= less.misses ? '+' : ''}${String(more.misses - less.misses)}` },
      ],
      toolHref: href,
    };
  },

  'clock-is-not-lru': (v) => {
    const [ref, frames] = [str(v, 'ref'), num(v, 'frames')];
    const href = sandboxHref({ tool: 'buffer-pool', ref, frames, policy: 'clock', ra: 0, sr: 0 });
    const lru = bufferRun(ref, frames, 'lru');
    if (lru.references === 0) return { passed: false, facts: [], problem: 'Write at least one page number.', toolHref: href };
    const clock = bufferRun(ref, frames, 'clock');
    const differ = JSON.stringify(lru.victims) !== JSON.stringify(clock.victims);
    const at = lru.victims.findIndex((x, i) => x !== clock.victims[i]);
    const list = (xs: number[]) => (xs.length === 0 ? 'none' : xs.join(', '));
    return {
      passed: differ,
      facts: [
        { label: 'references', value: String(lru.references) },
        { label: 'misses, LRU / clock', value: `${String(lru.misses)} / ${String(clock.misses)}` },
        { label: 'first different eviction', value: differ ? `the ${String(Math.max(at, 0) + 1)}th` : 'none' },
      ],
      tables: [
        {
          caption: 'The pages each policy evicted, in order',
          columns: ['Policy', 'Evicted'],
          rows: [
            ['LRU', list(lru.victims)],
            ['Clock sweep', list(clock.victims)],
          ],
        },
      ],
      toolHref: href,
    };
  },

  'scan-keeps-the-hot-set': (v) => {
    const [policy, frames, ring] = [str(v, 'policy'), num(v, 'frames'), num(v, 'ring')];
    const r = bufferRun(HOT_SET_SCAN, frames, policy, ring);
    return {
      passed: r.hits >= 16,
      facts: [
        { label: 'references', value: String(r.references) },
        { label: 'hits', value: String(r.hits) },
        { label: 'misses', value: String(r.misses) },
        { label: 'pages evicted', value: String(r.victims.length) },
      ],
      toolHref: sandboxHref({ tool: 'buffer-pool', ref: HOT_SET_SCAN, frames, policy, ra: 0, sr: ring }),
    };
  },

  'index-with-two-rules': (v) => {
    const rules = str(v, 'rules') === '' ? [] : str(v, 'rules').split(',');
    const users = createSeedDatabase().tables.users!;
    const parsed = parse(PLANNER_QUERY);
    if (!parsed.ok) throw new Error('the planner challenge query must parse');
    const canonical = buildPlan(parsed.ast);
    const steps = optimize(
      canonical,
      users,
      DEFAULT_ENGINE_OPTIONS.rowsPerPage,
      { users },
      new Set(rules.filter((r) => OPTIMIZER_RULES.includes(r))),
    );
    const final = steps.at(-1)?.plan ?? canonical;
    const ops = operatorsOf(final);
    return {
      passed: ops.includes('IndexScan') && rules.length <= 2,
      facts: [
        { label: 'rules on', value: String(rules.length) },
        { label: 'rules that fired', value: steps.length === 0 ? 'none' : steps.map((x) => x.rule).join(', ') },
        { label: 'plan', value: ops.join(' → ') },
      ],
      toolHref: sandboxHref({ tool: 'planner', q: PLANNER_QUERY, idx: true, rules }),
    };
  },

  'third-level': (v) => {
    const [fanout, keys] = [num(v, 'fanout'), num(v, 'keys')];
    const tree = createTree(fanout, 0);
    for (let k = 1; k <= keys; k += 1) insert(tree, k, { pageId: Math.abs(k) >> 2, slot: Math.abs(k) & 3 });
    const levels = height(tree);
    const problems = validate(tree);
    return {
      passed: levels >= 3 && keys <= 12 && problems.length === 0,
      facts: [
        { label: 'keys', value: String(keys) },
        { label: 'levels', value: String(levels) },
        { label: 'pages', value: String(Object.keys(tree.nodes).length) },
        { label: 'invariants', value: problems.length === 0 ? 'hold' : `${String(problems.length)} broken` },
      ],
      toolHref: `/tools/btree?keys=${Array.from({ length: keys }, (_, i) => i + 1).join(',')}&fanout=${String(fanout)}`,
    };
  },

  'same-level-different-promise': (v) => {
    const id = str(v, 'anomaly');
    const test = HERMITAGE_TESTS.find((t) => t.id === id)!;
    const locks = runHermitage(test, 'repeatable-read', 'locks').occurred;
    const snapshots = runHermitage(test, 'repeatable-read', 'mvcc').occurred;
    const word = (happens: boolean) => (happens ? 'happens' : 'prevented');
    return {
      passed: locks !== snapshots,
      facts: [
        { label: 'anomaly', value: `${test.id} ${test.name}` },
        { label: 'with locks', value: word(locks) },
        { label: 'with snapshots', value: word(snapshots) },
      ],
      toolHref: `/tools/isolation?c=locks.${test.id}.repeatable-read`,
    };
  },

  'cheap-writes-cheap-reads': (v) => lsmVerdict(v, (p, n) => n >= 40 && p.writeAmplification <= 2.5 && p.readAmplificationAverage <= 0.6),

  'write-amp-below-one': (v) => lsmVerdict(v, (p) => p.writeAmplification < 1),

  'column-store-saving': (v) => {
    const [n, page] = [num(v, 'n'), num(v, 'page')];
    const layout = str(v, 'layout') as Layout;
    const plan = planLayout(layout, demoColumns(n, SEED), page);
    const one = Math.max(...Object.values(plan.pagesForSingleColumnScan));
    const full = plan.pagesForFullScan;
    return {
      passed: full >= 8 && one <= full * 0.3 && plan.regionsToReconstructOneRow === 1,
      facts: [
        { label: 'pages in a full scan', value: String(full) },
        { label: 'pages in a one-column scan', value: String(one) },
        { label: 'share of the full scan', value: pct(one / full) },
        { label: 'regions to rebuild a row', value: String(plan.regionsToReconstructOneRow) },
      ],
      toolHref: storageHref({ tool: 'columnar', n, page, layout, seed: SEED }),
    };
  },

  'crabbing-saves-a-fifth': (v) => {
    const [fanout, threads, ops] = [num(v, 'fanout'), num(v, 'threads'), num(v, 'ops')];
    const scripts = demoScripts(threads, ops, SEED);
    const naive = planLatchCrabbing(DEMO_INITIAL_KEYS, scripts, fanout, 'naive');
    const crab = planLatchCrabbing(DEMO_INITIAL_KEYS, scripts, fanout, 'crabbing');
    return {
      passed: crab.ticks * 5 <= naive.ticks * 4,
      facts: [
        { label: 'ticks, naive', value: String(naive.ticks) },
        { label: 'ticks, crabbing', value: String(crab.ticks) },
        { label: 'saved', value: pct(1 - crab.ticks / naive.ticks) },
        { label: 'blocked ticks, naive → crabbing', value: `${String(naive.totalBlockedTicks)} → ${String(crab.totalBlockedTicks)}` },
      ],
      toolHref: storageHref({ tool: 'latch-crabbing', fanout, threads, ops, seed: SEED }),
    };
  },

  'recall-for-a-quarter': (v) => {
    const [n, k, parameter] = [num(v, 'n'), num(v, 'k'), num(v, 'parameter')];
    const method = str(v, 'method') === 'hnsw' ? 'hnsw' : 'ivf';
    const toolHref = storageHref({ tool: 'vector-index', n, k, seed: SEED });
    const centroids = Math.max(2, Math.round(Math.sqrt(n)));
    const most = method === 'ivf' ? centroids : n;
    if (parameter > most) {
      return {
        passed: false,
        facts: [],
        problem:
          method === 'ivf'
            ? `With ${String(n)} points there are ${String(centroids)} clusters: probe from 1 to ${String(centroids)}.`
            : `A beam is at most as wide as the table: from 1 to ${String(n)}.`,
        toolHref,
      };
    }
    const a = vectorAverage(n, k, method, parameter);
    return {
      passed: a.recall >= 0.95 - 1e-9 && a.computations <= 0.25 * n,
      facts: [
        { label: 'distance computations', value: fixed(a.computations, 1) },
        { label: 'of brute force’s', value: pct(a.computations / n) },
        { label: `recall of the true ${String(k)}`, value: pct(a.recall) },
      ],
      toolHref,
    };
  },
};

function lsmVerdict(
  v: Values,
  test: (p: ReturnType<typeof planLsm>, writes: number) => boolean,
): Verdict {
  const strategy = str(v, 'strategy') === 'tiered' ? 'tiered' : 'leveled';
  // The challenges expose only the dials that matter; the rest are the tool's own defaults.
  const s = {
    n: num(v, 'n'),
    mem: num(v, 'mem'),
    trigger: num(v, 'trigger'),
    base: 8,
    mult: 2,
    bits: v.bits === undefined ? 8 : num(v, 'bits'),
  };
  const p = planLsm(lsmWrites(s.n, SEED), {
    compactionStrategy: strategy,
    memtableCapacity: s.mem,
    l0CompactionTrigger: s.trigger,
    baseLevelCapacity: s.base,
    levelSizeMultiplier: s.mult,
    bitsPerKey: s.bits,
  });
  return {
    passed: test(p, s.n),
    facts: [
      { label: 'writes', value: String(s.n) },
      { label: 'write amplification', value: fixed(p.writeAmplification) },
      { label: 'read amplification, measured', value: fixed(p.readAmplificationAverage) },
      { label: 'read amplification, worst case', value: String(p.readAmplificationWorstCase) },
      { label: 'space amplification', value: fixed(p.spaceAmplification) },
    ],
    toolHref: storageHref({ tool: 'lsm', ...s, strategy, seed: SEED }),
  };
}

/** The checks, by challenge id — what the tests hold against the list in `settingsChallenges.tsx`. */
export const CHECKED_SETTINGS: readonly string[] = Object.keys(HANDLERS);

function problemWith(message: string): SettingsRun {
  return { problem: message, passed: false, facts: [], tables: [], toolHref: null };
}

/** Reads the form's text into numbers and options, or says which one is not something the tool accepts. */
export function readValues(challenge: SettingsChallenge, raw: Readonly<Record<string, string>>): Values | string {
  const out: Values = {};
  for (const control of challenge.controls) {
    const text = (raw[control.key] ?? '').trim();
    if (control.kind === 'select') {
      if (!control.options.some((o) => o.value === text)) return `Choose a value for ${control.label}.`;
      out[control.key] = text;
      continue;
    }
    if (control.kind === 'text') {
      if (text === '') return `${control.label} cannot be empty.`;
      if (text.length > control.max) return `${control.label} is at most ${String(control.max)} characters.`;
      out[control.key] = text;
      continue;
    }
    if (control.kind === 'checks') {
      const picked = text === '' ? [] : text.split(',');
      if (!picked.every((p) => control.options.some((o) => o.value === p))) return `Choose ${control.label} from the list.`;
      out[control.key] = picked.join(',');
      continue;
    }
    const value = Number(text);
    if (text === '' || !Number.isInteger(value) || value < control.min || value > control.max) {
      return `${control.label} must be a whole number from ${String(control.min)} to ${String(control.max)}.`;
    }
    out[control.key] = value;
  }
  return out;
}

export function runSettings(challenge: SettingsChallenge, raw: Readonly<Record<string, string>>): SettingsRun {
  const handler = HANDLERS[challenge.id];
  if (!handler) throw new Error(`settings challenge ${challenge.id} has no check`);
  const values = readValues(challenge, raw);
  if (typeof values === 'string') return problemWith(values);
  const verdict = handler(values);
  if (verdict.problem !== undefined) {
    return { problem: verdict.problem, passed: false, facts: [], tables: [], toolHref: null };
  }
  return {
    problem: null,
    passed: verdict.passed,
    facts: verdict.facts,
    tables: verdict.tables ?? [],
    toolHref: verdict.toolHref,
  };
}
