/** The planner challenge, run through the same rule pipeline the sandbox shows. */

import { buildPlan, createSeedDatabase, DEFAULT_ENGINE_OPTIONS, OPTIMIZER_RULES, optimize, parse } from '../../../engine/index.ts';
import type { Plan } from '../../../engine/index.ts';
import { sandboxHref } from '../../learn/sandboxScenarios.ts';
import { str } from './shared.ts';
import type { Checkers } from './shared.ts';

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

export const CHECKERS: Checkers = {
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
};
