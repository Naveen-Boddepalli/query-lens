import { describe, expect, it } from 'vitest';
import {
  createSeedDatabase,
  createTraceProjector,
  DEFAULT_ENGINE_OPTIONS,
  runQuery,
} from '../../engine/index.ts';
import type { ASTNode, IndexNode, PlanNode, StepEvent } from '../../engine/index.ts';
import { astToText, explainToText, indexTreeToText, planToText } from '../toText.ts';

const db = createSeedDatabase();

function last<T>(events: StepEvent[], pick: (e: StepEvent) => T | undefined): T | undefined {
  let found: T | undefined;
  for (const e of events) {
    const v = pick(e);
    if (v !== undefined) found = v;
  }
  return found;
}

function pieces(sql: string): { ast: ASTNode; plan: PlanNode; tree: IndexNode } {
  const { events } = runQuery(sql, db);
  const ast = last(events, (e) => (e.stage === 'parse' ? e.ast : undefined));
  const plan = last(events, (e) => (e.stage === 'plan' ? e.planTree : undefined));
  const tree = last(events, (e) =>
    e.stage === 'index' && e.action === 'open' ? e.tree : undefined,
  );
  if (!ast || !plan || !tree) throw new Error('expected parse, plan and index events');
  return { ast, plan, tree };
}

function countNodes(node: { children?: unknown[] }): number {
  return (
    1 +
    ((node.children as { children?: unknown[] }[] | undefined) ?? []).reduce(
      (n, c) => n + countNodes(c),
      0,
    )
  );
}

/** The tree body between the two ``` fences. */
function body(out: string): string[] {
  const lines = out.split('\n');
  expect(lines[0]).toBe('```');
  const close = lines.lastIndexOf('```');
  expect(close).toBeGreaterThan(0);
  return lines.slice(1, close);
}

describe('toText', () => {
  const { ast, plan, tree } = pieces(
    "SELECT name, id FROM users WHERE id = 5 AND name < 'M';",
  );

  it('wraps the tree in a bare (non-mermaid) fence', () => {
    const out = astToText(ast);
    expect(out.startsWith('```\n')).toBe(true);
    expect(out.trimEnd().endsWith('```')).toBe(true);
    expect(out).not.toContain('```mermaid');
    expect(out.endsWith('\n')).toBe(true);
  });

  it('emits exactly one line per tree node', () => {
    for (const [node, out] of [
      [ast, astToText(ast)],
      [plan, planToText(plan)],
      [tree, indexTreeToText(tree)],
    ] as const) {
      expect(body(out).length).toBe(countNodes(node));
    }
  });

  it('draws tree(1)-style connectors, and the root carries none', () => {
    const rows = body(planToText(plan));
    expect(rows[0]).not.toMatch(/[├└│]/); // root is flush-left
    expect(rows.slice(1).some((l) => l.startsWith('├─ ') || l.startsWith('└─ '))).toBe(true);
    // The last child of any parent uses └─, and nothing sits under a └─'s spine.
    expect(rows.some((l) => l.includes('└─ '))).toBe(true);
  });

  it('indents a grandchild deeper than its parent', () => {
    // The plan-stage tree is Project → Filter → SeqScan, three levels deep.
    const rows = body(planToText(plan));
    expect(rows.length).toBeGreaterThanOrEqual(3);
    const depthOf = (l: string) => l.length - l.replace(/^[ │]+/, '').length;
    expect(depthOf(rows[0]!)).toBe(0); // root, flush-left
    expect(depthOf(rows[1]!)).toBe(0); // its child: connector only, no carried spine
    expect(depthOf(rows[2]!)).toBeGreaterThan(0); // the grandchild is carried in
  });

  it('folds the B+Tree kind and page id into each line', () => {
    const out = indexTreeToText(tree);
    expect(out).toMatch(/(internal|leaf), page \d+/);
  });

  it('flattens a newline in a label so alignment cannot break', () => {
    const gnarly: PlanNode = {
      id: 'x',
      op: 'Scan',
      label: 'line one\nline two',
      detail: 'a\r\nb',
      children: [],
    };
    const rows = body(planToText(gnarly));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toBe('line one line two  a b');
  });

  it('is deterministic', () => {
    expect(planToText(plan)).toBe(planToText(plan));
  });

  it('renders a plain SELECT * with no WHERE clause', () => {
    const { ast: a } = pieces('SELECT * FROM users WHERE id = 1;');
    const out = astToText(a);
    expect(out).toContain('```\n');
    expect(body(out).length).toBe(countNodes(a));
  });
});

/** The final plan tree and each operator's actual row count, as the result-stage panel sees them. */
function explainInputs(sql: string): { plan: PlanNode; actual: Map<string, number> } {
  const { events } = runQuery(sql, db);
  const projector = createTraceProjector(events, DEFAULT_ENGINE_OPTIONS);
  const state = projector.at(events.length);
  if (!state.plan) throw new Error('expected a final plan');
  return { plan: state.plan, actual: new Map(state.operators.map((o) => [o.op, o.rowsProduced])) };
}

describe('explainToText — in-app EXPLAIN (plan.md §22.2)', () => {
  it('wraps in the same bare fence as the other exports', () => {
    const { plan, actual } = explainInputs('SELECT * FROM users WHERE id = 5;');
    const out = explainToText(plan, actual);
    expect(out.startsWith('```\n')).toBe(true);
    expect(out.trimEnd().endsWith('```')).toBe(true);
  });

  it('puts the estimate and the actual count on every operator, and they agree for an exact lookup', () => {
    const { plan, actual } = explainInputs('SELECT * FROM users WHERE id = 5;');
    const rows = body(explainToText(plan, actual));
    expect(rows.length).toBe(countNodes(plan));
    for (const row of rows) {
      expect(row).toMatch(/est ~\d+ rows/);
      expect(row).toMatch(/actual \d+ rows/);
    }
    expect(rows.every((row) => /est ~1 rows/.test(row) && /actual 1 rows/.test(row))).toBe(true);
  });

  it('shows the heuristic missing the actual for an open range — the honest divergence', () => {
    const { plan, actual } = explainInputs('SELECT * FROM users WHERE age > 30;');
    const root = body(explainToText(plan, actual))[0]!;
    const est = Number(/est ~(\d+) rows/.exec(root)?.[1]);
    const real = Number(/actual (\d+) rows/.exec(root)?.[1]);
    expect(real).toBe(35);
    expect(est).not.toBe(real);
    expect(Math.abs(est - real)).toBeLessThanOrEqual(4);
  });

  it('keeps the original detail alongside the cost, for a node that has one', () => {
    const { plan, actual } = explainInputs("SELECT * FROM users WHERE id = 5 AND age > 30;");
    const out = explainToText(plan, actual);
    expect(out).toContain('recheck: age > 30');
  });

  it('omits the cost suffix entirely for a node with neither an estimate nor an actual', () => {
    const bare: PlanNode = { id: 'x', op: 'Mystery', label: 'Mystery' };
    expect(body(explainToText(bare, new Map()))).toEqual(['Mystery']);
  });

  it('adds only the estimate when no actual is recorded for that operator', () => {
    const node: PlanNode = { id: 'x', op: 'SeqScan', label: 'SeqScan users', estRows: 12 };
    expect(body(explainToText(node, new Map()))).toEqual(['SeqScan users  est ~12 rows']);
  });

  it('is deterministic', () => {
    const { plan, actual } = explainInputs('SELECT * FROM users WHERE id = 5;');
    expect(explainToText(plan, actual)).toBe(explainToText(plan, actual));
  });
});
