/** The join-order challenge, priced by the planner the tool uses. */

import { costOfOrder, createJoinOrderDemoDatabase, DEFAULT_ENGINE_OPTIONS, joinGraphFromAst, parse, runJoinOrderDP } from '../../../engine/index.ts';
import { fixed, str } from './shared.ts';
import type { Checkers } from './shared.ts';

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

export const CHECKERS: Checkers = {
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
};
