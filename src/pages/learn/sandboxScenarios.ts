/**
 * The settings the lessons for the older sandboxes hand to a tool — the buffer pool, the parser, the grammar, the
 * planner and the locks. Plain data and a link builder, with no engine import, for the reason `storageScenarios.ts` and
 * `transactionScenarios.ts` have none: `/learn/:id` should not carry a tokenizer to build a URL. Each scenario is run
 * on the tool's own engine in `__tests__/sandboxLessons.test.ts` against the sentence its lesson says about it.
 */

export interface BufferPoolScenario {
  tool: 'buffer-pool';
  ref: string;
  frames: number;
  policy: string;
  /** Read-ahead pages, and the scan ring's size; both off unless a lesson is about them. */
  ra: number;
  sr: number;
}

export interface ParserScenario {
  tool: 'parser';
  src: string;
}

export interface GrammarScenario {
  tool: 'grammar';
  /** The rule the page opens at. */
  rule: string;
}

export interface PlannerScenario {
  tool: 'planner';
  q: string;
  /** Whether `users` has its `id` index. */
  idx: boolean;
  rules: readonly string[];
}

export interface LocksScenario {
  tool: 'locks';
  /** The script, in `lockScript.ts`'s lines. */
  steps: readonly string[];
}

export type SandboxScenario = BufferPoolScenario | ParserScenario | GrammarScenario | PlannerScenario | LocksScenario;

const SCAN = '0 1 2 3 0 1 2 3 0 1 2 3 10-30 0 1 2 3 0 1 2 3';
const BELADY = '1 2 3 4 1 2 5 1 2 3 4 5';
const PLANNER_QUERY = 'SELECT name, email\nFROM users\nWHERE id = 5 AND age > 30';
const ALL_RULES = [
  'constant-folding',
  'predicate-pushdown',
  'join-predicate-pushdown',
  'join-algorithm-selection',
  'index-selection',
  'range-index-selection',
  'index-only-scan',
] as const;

export const SANDBOX_SCENARIOS = {
  // — Replay a page-reference string —
  poolLoop: { tool: 'buffer-pool', ref: '0 1 2 3 4 0 1 2 3 4', frames: 4, policy: 'lru', ra: 0, sr: 0 },
  poolLoopOptimal: { tool: 'buffer-pool', ref: '0 1 2 3 4 0 1 2 3 4', frames: 4, policy: 'optimal', ra: 0, sr: 0 },
  poolBelady: { tool: 'buffer-pool', ref: BELADY, frames: 3, policy: 'fifo', ra: 0, sr: 0 },
  poolBeladyMore: { tool: 'buffer-pool', ref: BELADY, frames: 4, policy: 'fifo', ra: 0, sr: 0 },
  poolScan: { tool: 'buffer-pool', ref: SCAN, frames: 6, policy: 'lru', ra: 0, sr: 0 },
  poolScanRing: { tool: 'buffer-pool', ref: SCAN, frames: 6, policy: 'lru', ra: 0, sr: 2 },
  poolScanLruK: { tool: 'buffer-pool', ref: SCAN, frames: 6, policy: 'lru-k', ra: 0, sr: 0 },

  // — From text to tokens to a tree —
  parserTokens: { tool: 'parser', src: "SELECT name, age FROM users WHERE age > 30 AND name < 'M'" },
  parserPrecedence: { tool: 'parser', src: 'SELECT * FROM users WHERE id = 1 OR id = 2 AND age = 3' },
  parserParentheses: { tool: 'parser', src: 'SELECT * FROM users WHERE (id = 1 OR id = 2) AND age = 3' },
  parserError: { tool: 'parser', src: 'SELECT FROM users' },

  // — Read the grammar diagram —
  grammarSelect: { tool: 'grammar', rule: 'select' },
  grammarExpression: { tool: 'grammar', rule: 'orExpr' },

  // — Rewrite rules compose —
  plannerAll: { tool: 'planner', q: PLANNER_QUERY, idx: true, rules: ALL_RULES },
  plannerIndexOnly: { tool: 'planner', q: PLANNER_QUERY, idx: true, rules: ['index-selection'] },
  plannerNoIndex: { tool: 'planner', q: PLANNER_QUERY, idx: false, rules: ALL_RULES },

  // — The lock table —
  locksShared: { tool: 'locks', steps: ['T1 shared 0', 'T2 shared 0'] },
  locksQueue: { tool: 'locks', steps: ['T1 shared 0', 'T2 exclusive 0', 'T1 release shared 0'] },
  locksDeadlock: { tool: 'locks', steps: ['T1 exclusive 0', 'T2 exclusive 1', 'T1 exclusive 1', 'T2 exclusive 0'] },
  locksNewest: { tool: 'locks', steps: ['T2 exclusive 1', 'T1 exclusive 0', 'T2 exclusive 0', 'T1 exclusive 1'] },
  locksOnePage: { tool: 'locks', steps: ['T1 shared 0', 'T2 shared 0', 'T1 exclusive 0', 'T2 exclusive 0'] },
} as const satisfies Record<string, SandboxScenario>;

export type SandboxScenarioName = keyof typeof SANDBOX_SCENARIOS;

/** `/tools/…?…` for a scenario, in the URL scheme the tool itself writes. */
export function sandboxHref(scenario: SandboxScenario): string {
  const p = new URLSearchParams();
  switch (scenario.tool) {
    case 'buffer-pool':
      p.set('ref', scenario.ref);
      p.set('frames', String(scenario.frames));
      p.set('policy', scenario.policy);
      if (scenario.ra > 0) p.set('ra', String(scenario.ra));
      if (scenario.sr > 0) p.set('sr', String(scenario.sr));
      break;
    case 'parser':
      p.set('src', scenario.src);
      break;
    case 'grammar':
      return `/tools/grammar#rule-${scenario.rule}`;
    case 'planner':
      p.set('q', scenario.q);
      p.set('idx', scenario.idx ? '1' : '0');
      p.set('rules', scenario.rules.join(','));
      break;
    case 'locks':
      p.set('s', JSON.stringify(scenario.steps));
      break;
  }
  return `/tools/${scenario.tool}?${p.toString()}`;
}
