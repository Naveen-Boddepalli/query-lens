import { describe, expect, it } from 'vitest';
import {
  buildPlan,
  createJoinDemoDatabase,
  createSeedDatabase,
  DEFAULT_ENGINE_OPTIONS,
  OPTIMIZER_RULES,
  optimize,
  parse,
  REPLACEMENT_POLICY_NAMES,
  runQuery,
  toDisplayTree,
  tokenize,
} from '../../../engine/index.ts';
import type { ASTNode, Plan } from '../../../engine/index.ts';
import { parseReferenceScans, runBufferTrace } from '../../../engine/bufferTrace.ts';
import { GRAMMAR } from '../../../ui/grammar.ts';
import { decodeLockSteps, formatLockStep, parseLockStep, runLockSteps } from '../../../ui/lockScript.ts';
import { heldBy } from '../../../ui/lockSimulation.ts';
import { LESSON_GROUPS } from '../lessonIndex.ts';
import { LESSONS } from '../lessons.tsx';
import { SANDBOX_SCENARIOS, sandboxHref } from '../sandboxScenarios.ts';
import type {
  BufferPoolScenario,
  LocksScenario,
  PlannerScenario,
  SandboxScenario,
} from '../sandboxScenarios.ts';

/**
 * The lessons for the older sandboxes quote what their engines do, and each scenario here is run on that engine and
 * held to the sentence its lesson says. The prose is copy; these are not.
 */

const IDS = ['tokens-and-trees', 'grammar-diagram', 'planner-rules', 'buffer-pool', 'lock-table'] as const;
const lesson = (id: string) => LESSONS.find((l) => l.id === id)!;

function pool(s: BufferPoolScenario, over: Partial<BufferPoolScenario> = {}) {
  const o = { ...s, ...over };
  const { refs, scans } = parseReferenceScans(o.ref);
  const result = runBufferTrace(
    refs,
    { ...DEFAULT_ENGINE_OPTIONS, bufferFrames: o.frames, policy: o.policy as never, readAhead: o.ra, scanRing: o.sr },
    scans,
  );
  const buffer = result.events.filter((e) => e.stage === 'buffer');
  return {
    refs: refs.length,
    hits: buffer.filter((e) => e.action === 'hit').length,
    misses: buffer.filter((e) => e.action === 'miss').length,
  };
}

const operators = (plan: Plan): string[] => {
  const out: string[] = [];
  const walk = (p: Record<string, unknown>) => {
    out.push(String(p.op));
    for (const key of ['child', 'left', 'right']) if (p[key]) walk(p[key] as Record<string, unknown>);
    if (Array.isArray(p.children)) for (const c of p.children) walk(c as Record<string, unknown>);
  };
  walk(plan);
  return out;
};

function planned(s: PlannerScenario) {
  const users = createSeedDatabase().tables.users!;
  const { indexedColumns: _dropped, ...unindexed } = users;
  const table = s.idx ? users : unindexed;
  const parsed = parse(s.q);
  if (!parsed.ok) throw new Error('the planner scenario must parse');
  const canonical = buildPlan(parsed.ast);
  const steps = optimize(canonical, table, DEFAULT_ENGINE_OPTIONS.rowsPerPage, { users: table }, new Set(s.rules));
  const final = steps.at(-1)?.plan ?? canonical;
  return { fired: steps.map((x) => x.rule), canonical: operators(canonical), final: operators(final), plan: final };
}

const displayWhere = (sql: string): ASTNode => {
  const parsed = parse(sql);
  if (!parsed.ok) throw new Error(`must parse: ${sql}`);
  const root = toDisplayTree(parsed.ast);
  return root.children!.find((c) => c.kind === 'Where')!.children![0]!;
};

const locks = (s: LocksScenario) => runLockSteps(s.steps.map((l) => parseLockStep(l)!));

describe('the sandbox lessons are wired into the track', () => {
  it('put four lessons after the twelve Playground ones, and the lock table first among the transactions', () => {
    const pipeline = LESSON_GROUPS.find((g) => g.id === 'pipeline')!.lessons.map((l) => l.id);
    // The NULL lesson (plan.md §26 Feature 3), NOT EXISTS (§27.5 S1) and the set operations (S3) run in the Playground
    // too, so they close that run, after errors — each after the one it builds on.
    expect(pipeline.slice(8, 12)).toEqual(['errors', 'nulls', 'not-exists', 'set-operations']);
    expect(pipeline.slice(12, 16)).toEqual(['tokens-and-trees', 'grammar-diagram', 'planner-rules', 'buffer-pool']);
    expect(pipeline.slice(16)).toEqual(['external-sort', 'hash-join', 'join-order']);
    const transactions = LESSON_GROUPS.find((g) => g.id === 'transactions')!.lessons.map((l) => l.id);
    expect(transactions[0]).toBe('lock-table');
  });

  it('every step links a scenario, and every scenario but the named variants has a step', () => {
    const used = new Set<string>();
    for (const id of IDS) {
      expect(lesson(id).steps.length, id).toBeGreaterThanOrEqual(3);
      for (const [i, step] of lesson(id).steps.entries()) {
        expect(step.link, `${id} step ${String(i + 1)}`).toBeDefined();
        used.add(step.link!.href);
      }
    }
    const byHref = new Map(
      Object.entries(SANDBOX_SCENARIOS).map(([name, s]) => [sandboxHref(s as SandboxScenario), name] as const),
    );
    for (const href of used) expect(byHref.has(href), `a lesson links ${href}, which is not a scenario`).toBe(true);
    // Run for a sentence in the prose or a "try this", not a button of its own.
    const variants = ['poolBeladyMore', 'poolScanRing', 'poolScanLruK', 'parserParentheses', 'locksNewest'];
    const unlinked = Object.keys(SANDBOX_SCENARIOS).filter(
      (name) => !used.has(sandboxHref(SANDBOX_SCENARIOS[name as keyof typeof SANDBOX_SCENARIOS] as SandboxScenario)),
    );
    expect(unlinked.sort()).toEqual(variants.sort());
  });

  it('every link names settings its tool accepts as they are', () => {
    for (const s of Object.values(SANDBOX_SCENARIOS) as SandboxScenario[]) {
      const url = new URL(sandboxHref(s), 'https://x');
      expect(url.pathname).toBe(`/tools/${s.tool}`);
      switch (s.tool) {
        case 'buffer-pool':
          expect(s.frames >= 2 && s.frames <= 8).toBe(true);
          expect((REPLACEMENT_POLICY_NAMES as readonly string[]).includes(s.policy)).toBe(true);
          expect(s.ra >= 0 && s.ra <= 4 && s.sr >= 0 && s.sr <= 4).toBe(true);
          expect(url.searchParams.get('ref')).toBe(s.ref);
          expect(parseReferenceScans(s.ref).refs.length).toBeGreaterThan(0);
          break;
        case 'parser':
          expect(s.src.length > 0 && s.src.length <= 2000).toBe(true);
          expect(url.searchParams.get('src')).toBe(s.src);
          break;
        case 'grammar':
          expect(GRAMMAR.some((r) => r.name === s.rule), s.rule).toBe(true);
          expect(url.hash).toBe(`#rule-${s.rule}`);
          break;
        case 'planner':
          expect(s.rules.every((r) => OPTIMIZER_RULES.includes(r))).toBe(true);
          expect(url.searchParams.get('rules')).toBe(s.rules.join(','));
          expect(s.q.length <= 2000).toBe(true);
          break;
        case 'locks':
          expect(decodeLockSteps(url.searchParams.get('s'))?.map(formatLockStep)).toEqual(
            s.steps.map((l) => formatLockStep(parseLockStep(l)!)),
          );
          break;
      }
    }
  });
});

describe('lesson: replay a page-reference string', () => {
  const S = SANDBOX_SCENARIOS;

  it('a loop one page bigger than the pool misses every time under LRU', () => {
    expect(pool(S.poolLoop)).toEqual({ refs: 10, hits: 0, misses: 10 });
  });

  it('the optimal policy has four hits in ten, and 2Q one', () => {
    expect(pool(S.poolLoopOptimal).hits).toBe(4);
    expect(pool(S.poolLoop, { policy: 'two-q' }).hits).toBe(1);
  });

  it('Belady: FIFO misses 9 times in three frames and 10 in four; LRU goes from 10 to 8', () => {
    expect(pool(S.poolBelady).misses).toBe(9);
    expect(pool(S.poolBeladyMore).misses).toBe(10);
    expect(pool(S.poolBelady, { policy: 'lru' }).misses).toBe(10);
    expect(pool(S.poolBeladyMore, { policy: 'lru' }).misses).toBe(8);
  });

  it('a scan: 12 hits in 41 under LRU, 16 under LRU-K or with a ring of two, 12 again with a ring of three', () => {
    expect(pool(S.poolScan)).toEqual({ refs: 41, hits: 12, misses: 29 });
    expect(pool(S.poolScanLruK).hits).toBe(16);
    expect(pool(S.poolScanRing).hits).toBe(16);
    expect(pool(S.poolScan, { sr: 3 }).hits).toBe(12);
    expect(parseReferenceScans(S.poolScan.ref).scans).toEqual([{ from: 12, to: 33 }]);
  });
});

describe('lesson: from text to tokens to a tree', () => {
  const S = SANDBOX_SCENARIOS;

  it('the default query is fifteen tokens ending in the end marker', () => {
    const tokens = tokenize(S.parserTokens.src);
    expect(tokens).toHaveLength(15);
    expect(tokens.at(-1)!.type).toBe('eof');
    expect(tokens.filter((t) => t.type === 'number' || t.type === 'string' || t.type === 'operator')).toHaveLength(4);
  });

  it('AND is under OR without parentheses and over it with them', () => {
    const bare = displayWhere(S.parserPrecedence.src);
    expect(bare.kind).toBe('Or');
    expect(bare.children!.map((c) => c.kind)).toEqual(['Compare', 'And']);
    const wrapped = displayWhere(S.parserParentheses.src);
    expect(wrapped.kind).toBe('And');
    expect(wrapped.children!.map((c) => c.kind)).toEqual(['Or', 'Compare']);
  });

  it('a missing column list is an error at FROM, and an unclosed string is the tokenizer’s', () => {
    const r = parse(S.parserError.src);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.message).toBe('Expected a column name or a value, found `FROM`.');
      expect(S.parserError.src.slice(r.error.from, r.error.to)).toBe('FROM');
    }
    expect(() => tokenize("SELECT name FROM users WHERE name = 'ada")).toThrow(/Unterminated string literal/);
  });
});

describe('lesson: read the grammar diagram', () => {
  const rule = (name: string) => GRAMMAR.find((r) => r.name === name)!;
  const words = (parts: (typeof GRAMMAR)[number]['parts']): string[] =>
    parts.flatMap((p): string[] =>
      p.kind === 'literal' ? [p.text] : p.kind === 'optional' ? words(p.parts) : p.kind === 'repeat' ? words(p.parts) : [],
    );

  it('the select rule lists its clauses in the order the lesson says', () => {
    const w = words(rule('select').parts);
    const order = ['SELECT', 'DISTINCT', 'FROM', 'WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'OFFSET'];
    expect(order.map((x) => w.indexOf(x))).toEqual([...order.map((x) => w.indexOf(x))].sort((a, b) => a - b));
    expect(order.every((x) => w.includes(x))).toBe(true);
  });

  it('a WHERE after an ORDER BY is refused by the parser, naming the late clause', () => {
    const r = parse('SELECT * FROM users ORDER BY age WHERE age > 1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toBe('Unexpected `WHERE` after the end of the query.');
  });

  it('precedence is nesting: orExpr calls andExpr, andExpr calls notExpr', () => {
    const calls = (name: string) =>
      JSON.stringify(rule(name).parts).match(/"name":"(\w+)"/g)?.map((m) => m.slice(8, -1)) ?? [];
    expect(calls('orExpr')).toContain('andExpr');
    expect(calls('andExpr')).toContain('notExpr');
    expect(calls('expr')).toEqual(['orExpr']);
  });

  it('all eight optional parts run together; what the diagram cannot say — groups, table names, DISTINCT — is refused', () => {
    const db = createSeedDatabase();
    const msg = (sql: string, database = db) => runQuery(sql, database, DEFAULT_ENGINE_OPTIONS).error?.message;
    const demo = createJoinDemoDatabase();
    const eight =
      'SELECT DISTINCT authors.name, COUNT(*) FROM authors JOIN posts ON authors.id = posts.authorId WHERE posts.id > 0 GROUP BY authors.name HAVING COUNT(*) > 0 ORDER BY authors.name LIMIT 3 OFFSET 1';
    expect(msg(eight, demo)).toBeUndefined();
    expect(msg('SELECT name, age FROM users GROUP BY age')).toMatch(/`name` is not aggregated/);
    expect(msg('SELECT authors.name FROM authors JOIN posts ON authors.id = posts.authorId GROUP BY name', demo)).toMatch(/needs a table name/);
    expect(msg('SELECT DISTINCT name FROM users ORDER BY age')).toMatch(/must appear in the select list/);
  });
});

describe('lesson: rewrite rules need each other', () => {
  const S = SANDBOX_SCENARIOS;

  it('there are seven rules, and with all on pushdown then index selection make an IndexScan with age left to check', () => {
    expect(OPTIMIZER_RULES).toHaveLength(7);
    const p = planned(S.plannerAll);
    expect(p.canonical).toEqual(['Project', 'Filter', 'SeqScan']);
    expect(p.fired).toEqual(['predicate-pushdown', 'index-selection']);
    expect(p.final).toEqual(['Project', 'IndexScan']);
    const scan = JSON.stringify(p.plan);
    expect(scan).toContain('"residual"');
  });

  it('index selection alone fires nothing, and these two are the only pair that gives the lookup', () => {
    const alone = planned(S.plannerIndexOnly);
    expect(alone.fired).toEqual([]);
    expect(alone.final).toEqual(alone.canonical);
    const pairs: string[] = [];
    for (const a of OPTIMIZER_RULES) {
      for (const b of OPTIMIZER_RULES) {
        if (a < b && planned({ ...S.plannerAll, rules: [a, b] }).final.includes('IndexScan')) pairs.push(`${a}+${b}`);
      }
      expect(planned({ ...S.plannerAll, rules: [a] }).final.includes('IndexScan'), a).toBe(false);
    }
    expect(pairs).toEqual(['index-selection+predicate-pushdown']);
  });

  it('with the index off, pushdown still fires and the scan stays a SeqScan', () => {
    const p = planned(S.plannerNoIndex);
    expect(p.fired).toEqual(['predicate-pushdown']);
    expect(p.final).toEqual(['Project', 'SeqScan']);
  });
});

describe('lesson: the lock table', () => {
  const S = SANDBOX_SCENARIOS;

  it('readers share a page', () => {
    expect(locks(S.locksShared).entries.map((e) => e.kind)).toEqual(['granted', 'granted']);
  });

  it('a writer waits behind a reader and is promoted in the same step the reader lets go', () => {
    const run = locks(S.locksQueue);
    expect(run.entries.map((e) => e.kind)).toEqual(['granted', 'blocked', 'released']);
    expect(run.entries[2]!.lines.join(' ')).toMatch(/T2 is promoted from waiting to holding an exclusive lock/);
    expect(heldBy(run.state, 'T2')).toEqual([{ resource: 0, mode: 'exclusive' }]);
  });

  it('a circle of waits: T2 is the victim because it asked later, and T1 is promoted', () => {
    const run = locks(S.locksDeadlock);
    const last = run.entries.at(-1)!;
    expect([last.kind, last.victim]).toEqual(['deadlock', 'T2']);
    expect(heldBy(run.state, 'T1').map((h) => h.resource).sort()).toEqual([0, 1]);
  });

  it('with T2 asking first, T1 is the one aborted', () => {
    const last = locks(S.locksNewest).entries.at(-1)!;
    expect([last.kind, last.victim]).toEqual(['deadlock', 'T1']);
  });

  it('one page is enough: two shared holders who both upgrade', () => {
    const run = locks(S.locksOnePage);
    expect(new Set(run.entries.map((e) => e.step.page))).toEqual(new Set([0]));
    expect(run.entries.map((e) => e.kind)).toEqual(['granted', 'granted', 'blocked', 'deadlock']);
  });
});
