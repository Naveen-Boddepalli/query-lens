import { describe, expect, it } from 'vitest';
import { createSeedDatabase, runQuery } from '../../engine/index.ts';
import type { ASTNode, PlanNode, StepEvent } from '../../engine/index.ts';
import { astToMermaid, planToMermaid } from '../toMermaid.ts';

const db = createSeedDatabase();

function trees(sql: string): { ast: ASTNode; plan: PlanNode } {
  const { events } = runQuery(sql, db);
  const ast = last(events, (e) => (e.stage === 'parse' ? e.ast : undefined));
  const plan = last(events, (e) => (e.stage === 'plan' ? e.planTree : undefined));
  if (!ast || !plan) throw new Error('expected a parse and a plan event');
  return { ast, plan };
}

function last<T>(events: StepEvent[], pick: (e: StepEvent) => T | undefined): T | undefined {
  let found: T | undefined;
  for (const e of events) {
    const v = pick(e);
    if (v !== undefined) found = v;
  }
  return found;
}

function countNodes(node: { children?: unknown[] }): number {
  return 1 + ((node.children as { children?: unknown[] }[] | undefined) ?? []).reduce(
    (n, c) => n + countNodes(c),
    0,
  );
}

describe('toMermaid', () => {
  const { ast, plan } = trees("SELECT name, id FROM users WHERE id = 5 AND name < 'M';");

  it('wraps a flowchart in a mermaid fence', () => {
    const out = astToMermaid(ast);
    expect(out.startsWith('```mermaid\n')).toBe(true);
    expect(out.trimEnd().endsWith('```')).toBe(true);
    expect(out).toContain('\nflowchart TD\n');
  });

  it('emits one node per tree node and one edge per parent-child link', () => {
    for (const [tree, render] of [
      [ast, astToMermaid(ast)],
      [plan, planToMermaid(plan)],
    ] as const) {
      const nodes = render.match(/^ {2}n\d+\["/gm) ?? [];
      const edges = render.match(/^ {2}n\d+ --> n\d+$/gm) ?? [];
      expect(nodes.length).toBe(countNodes(tree));
      expect(edges.length).toBe(countNodes(tree) - 1);
    }
  });

  it('escapes the characters that would break a Mermaid label', () => {
    // This query's tree carries `<` (the Compare op) and a quoted string literal.
    const out = astToMermaid(ast);
    // No raw double-quote inside a label (it would close the `["..."]`).
    for (const label of out.match(/\["[^\n]*"\]/g) ?? []) {
      expect(label.slice(2, -2)).not.toContain('"');
    }
    expect(out).toContain('&lt;'); // the `<` from `name < 'M'`
  });

  it('is deterministic', () => {
    expect(planToMermaid(plan)).toBe(planToMermaid(plan));
  });

  it('renders a plain SELECT * with no WHERE clause too', () => {
    const { ast: a } = trees('SELECT * FROM users;');
    const out = astToMermaid(a);
    expect(out).toContain('flowchart TD');
    expect((out.match(/-->/g) ?? []).length).toBe(countNodes(a) - 1);
  });
});
