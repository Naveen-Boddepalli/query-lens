/**
 * The settings the storage and execution lessons hand to a tool. Plain data and a link builder with no driver import,
 * for the reason `transactionScenarios.ts` has none: `/learn/:id` should not carry six drivers to build a URL. Each
 * scenario here is run on the real driver in `__tests__/storageLessons.test.ts` against the sentence its lesson says
 * about it, and that test fails if a scenario is not used by a lesson or a lesson's link is not a scenario.
 *
 * Every parameter is written out, defaults included, so that a lesson's link names the whole experiment and a change
 * to a tool's default does not quietly change what a lesson is about.
 */

export interface LsmScenario {
  tool: 'lsm';
  n: number;
  strategy: 'leveled' | 'tiered';
  mem: number;
  trigger: number;
  base: number;
  mult: number;
  bits: number;
  seed: number;
}

export interface HashIndexScenario {
  tool: 'hash-index';
  n: number;
  strategy: 'extendible' | 'linear';
  cap: number;
  init: number;
  seed: number;
}

export interface ColumnarScenario {
  tool: 'columnar';
  n: number;
  page: number;
  layout: 'NSM' | 'DSM' | 'PAX';
  seed: number;
}

export interface LatchScenario {
  tool: 'latch-crabbing';
  fanout: number;
  threads: number;
  ops: number;
  seed: number;
}

export interface VectorScenario {
  tool: 'vector-index';
  n: number;
  k: number;
  seed: number;
}

export interface PageScenario {
  tool: 'page';
  page: number;
  bytes: number;
}

export interface SortScenario {
  tool: 'sort';
  n: number;
  page: number;
  mem: number;
  seed: number;
}

export interface HashJoinScenario {
  tool: 'hash-join';
  build: number;
  probe: number;
  page: number;
  mem: number;
  seed: number;
}

/** The join-order demo has no parameters: one four-table query, always. */
export interface JoinOrderScenario {
  tool: 'join-order';
}

export type StorageScenario =
  | LsmScenario
  | HashIndexScenario
  | ColumnarScenario
  | LatchScenario
  | VectorScenario
  | PageScenario
  | SortScenario
  | HashJoinScenario
  | JoinOrderScenario;

const LSM = { tool: 'lsm', n: 60, mem: 4, trigger: 3, base: 8, mult: 2, seed: 1 } as const;
const HASH = { tool: 'hash-index', n: 60, cap: 4, init: 2, seed: 1 } as const;
const COLUMNAR = { tool: 'columnar', n: 500, page: 256, seed: 1 } as const;

export const STORAGE_SCENARIOS = {
  // — Where a row lives on a page —
  pageRoomy: { tool: 'page', page: 0, bytes: 4096 },
  pageTight: { tool: 'page', page: 0, bytes: 256 },
  pageOverflow: { tool: 'page', page: 0, bytes: 192 },

  // — A hash index —
  hashExtendible: { ...HASH, strategy: 'extendible' },
  hashLinear: { ...HASH, strategy: 'linear' },

  // — The LSM tree —
  lsmLeveled: { ...LSM, strategy: 'leveled', bits: 8 },
  lsmTiered: { ...LSM, strategy: 'tiered', bits: 8 },
  lsmTieredTwoBits: { ...LSM, strategy: 'tiered', bits: 2 },

  // — Rows or columns —
  columnarNsm: { ...COLUMNAR, layout: 'NSM' },
  columnarDsm: { ...COLUMNAR, layout: 'DSM' },
  columnarPax: { ...COLUMNAR, layout: 'PAX' },

  // — Latch crabbing —
  latchCrowded: { tool: 'latch-crabbing', fanout: 4, threads: 4, ops: 6, seed: 1 },
  latchWide: { tool: 'latch-crabbing', fanout: 6, threads: 4, ops: 6, seed: 1 },

  // — Nearest neighbours —
  vectorBig: { tool: 'vector-index', n: 400, k: 20, seed: 1 },

  // — External merge sort —
  sortTight: { tool: 'sort', n: 32, page: 2, mem: 3, seed: 1 },
  sortRoomy: { tool: 'sort', n: 32, page: 2, mem: 6, seed: 1 },
  sortFits: { tool: 'sort', n: 8, page: 2, mem: 6, seed: 1 },

  // — Grace hash join —
  hashJoinFits: { tool: 'hash-join', build: 12, probe: 20, page: 2, mem: 6, seed: 1 },
  hashJoinSpills: { tool: 'hash-join', build: 12, probe: 20, page: 2, mem: 4, seed: 1 },
  hashJoinDeep: { tool: 'hash-join', build: 24, probe: 32, page: 2, mem: 3, seed: 1 },

  // — Join order —
  joinOrder: { tool: 'join-order' },
} as const satisfies Record<string, StorageScenario>;

export type StorageScenarioName = keyof typeof STORAGE_SCENARIOS;

/** `/tools/…?…` for a scenario, in the URL scheme the tool itself writes. */
export function storageHref(scenario: StorageScenario): string {
  const p = new URLSearchParams();
  switch (scenario.tool) {
    case 'lsm':
      p.set('n', String(scenario.n));
      p.set('strategy', scenario.strategy);
      p.set('mem', String(scenario.mem));
      p.set('trigger', String(scenario.trigger));
      p.set('base', String(scenario.base));
      p.set('mult', String(scenario.mult));
      p.set('bits', String(scenario.bits));
      p.set('seed', String(scenario.seed));
      break;
    case 'hash-index':
      p.set('n', String(scenario.n));
      p.set('strategy', scenario.strategy);
      p.set('cap', String(scenario.cap));
      p.set('init', String(scenario.init));
      p.set('seed', String(scenario.seed));
      break;
    case 'columnar':
      p.set('n', String(scenario.n));
      p.set('page', String(scenario.page));
      p.set('layout', scenario.layout);
      p.set('seed', String(scenario.seed));
      break;
    case 'latch-crabbing':
      p.set('fanout', String(scenario.fanout));
      p.set('threads', String(scenario.threads));
      p.set('ops', String(scenario.ops));
      p.set('seed', String(scenario.seed));
      break;
    case 'vector-index':
      p.set('n', String(scenario.n));
      p.set('k', String(scenario.k));
      p.set('seed', String(scenario.seed));
      break;
    case 'page':
      p.set('page', String(scenario.page));
      p.set('bytes', String(scenario.bytes));
      break;
    case 'sort':
      p.set('n', String(scenario.n));
      p.set('page', String(scenario.page));
      p.set('mem', String(scenario.mem));
      p.set('seed', String(scenario.seed));
      break;
    case 'hash-join':
      p.set('build', String(scenario.build));
      p.set('probe', String(scenario.probe));
      p.set('page', String(scenario.page));
      p.set('mem', String(scenario.mem));
      p.set('seed', String(scenario.seed));
      break;
    case 'join-order':
      break;
  }
  const query = p.toString();
  return `/tools/${scenario.tool}${query ? `?${query}` : ''}`;
}
