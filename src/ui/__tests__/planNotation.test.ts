import { describe, expect, it } from 'vitest';
import { createSeedDatabase, runQuery } from '../../engine/index.ts';
import type { PlanNode } from '../../engine/index.ts';
import { toFlow } from '../panels/planTreeTones.ts';

function finalPlan(sql: string): PlanNode {
  const { events } = runQuery(sql, createSeedDatabase());
  const last = [...events].reverse().find((e) => e.stage === 'optimize' || e.stage === 'plan')!;
  return last.stage === 'optimize' ? last.after : last.stage === 'plan' ? last.planTree : (undefined as never);
}

describe('plan notation (plan.md §25.4 B5)', () => {
  const plan = finalPlan('SELECT name FROM users WHERE id = 5');

  it('by operators, a node is labelled as the engine labels it', () => {
    const flow = toFlow(plan);
    expect(flow.label).toBe('Project');
    expect(flow.detail).toBe('name');
  });

  it('by algebra, the label is the symbol and subscript, and the physical operator moves to the detail', () => {
    const flow = toFlow(plan, 'algebra');
    expect(flow.label).toBe('π name');
    const scan = flow.children![0]!;
    expect(scan.label).toBe('σ id = 5');
    expect(scan.detail).toBe('IndexScan users.id'); // how, beside what
  });

  it('the node kind — which the colours follow — is the operator in both notations, and ids are unchanged', () => {
    const a = toFlow(plan, 'operators');
    const b = toFlow(plan, 'algebra');
    const kinds = (n: typeof a): string[] => [n.kind, ...(n.children ?? []).flatMap(kinds)];
    const ids = (n: typeof a): string[] => [n.id, ...(n.children ?? []).flatMap(ids)];
    expect(kinds(b)).toEqual(kinds(a));
    expect(ids(b)).toEqual(ids(a));
  });

  it('the cost estimate is carried through unchanged', () => {
    const scanA = toFlow(plan).children![0]!;
    const scanB = toFlow(plan, 'algebra').children![0]!;
    expect(scanB.estRows).toBe(scanA.estRows);
    expect(scanB.estBasis).toBe(scanA.estBasis);
  });

  it('a node with no algebra form falls back to its own label', () => {
    const bare: PlanNode = { id: 'x', op: 'Mystery', label: 'Mystery' };
    expect(toFlow(bare, 'algebra').label).toBe('Mystery');
  });
});
