import { describe, expect, it } from 'vitest';
import { costOfOrder, joinGraphFromAst, runJoinOrderDP, writtenOrderFromAst } from '../planner/joinOrder.ts';
import type { JoinOrderEdge, JoinOrderNode } from '../planner/joinOrder.ts';
import { createJoinOrderDemoDatabase } from '../seed.ts';
import { parse } from '../parser/index.ts';
import { DEFAULT_ENGINE_OPTIONS } from '../types.ts';

describe('runJoinOrderDP (plan.md §25.4 C4)', () => {
  it('a single table has nothing to order — the winner is just itself', () => {
    const nodes: JoinOrderNode[] = [{ name: 'a', rows: 10, pages: 3 }];
    const result = runJoinOrderDP(nodes, []);
    expect(result.winner.tables).toEqual(['a']);
    expect(result.winner.rows).toBe(10);
    expect(result.winner.pages).toBe(3);
    expect(result.winner.candidates).toEqual([]);
  });

  it('two tables with an edge: the DP tries both starting points and reports both as candidates for the pair', () => {
    // a is tiny, b is huge — starting from a (rescanning the huge table once, tiny-outer) should always win over
    // starting from b (rescanning nothing bigger, but tiny() first vs huge() first still differs only by whether
    // the cheap side's own base-scan cost, `pages`, is paid once free of any multiplier).
    const a: JoinOrderNode = { name: 'a', rows: 5, pages: 2 };
    const b: JoinOrderNode = { name: 'b', rows: 1000, pages: 250 };
    const edges: JoinOrderEdge[] = [{ a: 'a', aColumn: 'id', aNdistinct: 5, b: 'b', bColumn: 'aId', bNdistinct: 5 }];
    const result = runJoinOrderDP([a, b], edges);
    const fullMask = 0b11;
    const plan = result.subsets.get(fullMask)!;
    expect(plan.candidates).toHaveLength(2);
    expect(plan.candidates.every((c) => c.viaEdge)).toBe(true);
    // a(2) + 5*250 = 1252 (a first) vs b(250) + 1000*2 = 2250 (b first) — a first wins.
    expect(result.winner.tables).toEqual(['a', 'b']);
    expect(result.winner.pages).toBe(1252);
  });

  it('no edge between two tables means a cross join, never a forbidden move', () => {
    const a: JoinOrderNode = { name: 'a', rows: 5, pages: 1 };
    const b: JoinOrderNode = { name: 'b', rows: 7, pages: 1 };
    const result = runJoinOrderDP([a, b], []);
    const plan = result.subsets.get(0b11)!;
    expect(plan.candidates.every((c) => !c.viaEdge)).toBe(true);
    // No division by ndistinct — a genuine cross product.
    expect(result.winner.rows).toBe(35);
  });

  it('a star graph correctly considers every table already joined, not just the one added immediately before', () => {
    // hub connects to leaf1 and leaf2; leaf1/leaf2 have no edge to each other. Once {hub, leaf1} is built, adding
    // leaf2 must find the hub↔leaf2 edge even though leaf1 (not hub) was the most recently added table.
    const hub: JoinOrderNode = { name: 'hub', rows: 10, pages: 2 };
    const leaf1: JoinOrderNode = { name: 'leaf1', rows: 100, pages: 25 };
    const leaf2: JoinOrderNode = { name: 'leaf2', rows: 50, pages: 12 };
    const edges: JoinOrderEdge[] = [
      { a: 'hub', aColumn: 'id', aNdistinct: 10, b: 'leaf1', bColumn: 'hubId', bNdistinct: 10 },
      { a: 'hub', aColumn: 'id', aNdistinct: 10, b: 'leaf2', bColumn: 'hubId', bNdistinct: 10 },
    ];
    const result = runJoinOrderDP([hub, leaf1, leaf2], edges);
    const full = result.subsets.get(0b111)!;
    // Every candidate for the full set should have found a real edge (hub is always in scope for either leaf).
    expect(full.candidates.every((c) => c.viaEdge)).toBe(true);
  });

  it('the winning order is internally consistent with its own subset chain', () => {
    const nodes: JoinOrderNode[] = [
      { name: 'a', rows: 5, pages: 1 },
      { name: 'b', rows: 40, pages: 10 },
      { name: 'c', rows: 300, pages: 75 },
    ];
    const edges: JoinOrderEdge[] = [
      { a: 'a', aColumn: 'id', aNdistinct: 5, b: 'b', bColumn: 'aId', bNdistinct: 5 },
      { a: 'b', aColumn: 'id', aNdistinct: 40, b: 'c', bColumn: 'bId', bNdistinct: 40 },
    ];
    const result = runJoinOrderDP(nodes, edges);
    expect(result.winner.tables).toHaveLength(3);
    expect(new Set(result.winner.tables)).toEqual(new Set(['a', 'b', 'c']));
    // Every prefix of the winning order is itself the best plan for that prefix's own subset.
    let mask = 0;
    for (const name of result.winner.tables) {
      const bit = 1 << nodes.findIndex((n) => n.name === name);
      mask |= bit;
      expect(result.subsets.get(mask)!.tables.at(-1)).toBe(name);
    }
  });

  it("finds the cheapest order on the demo dataset's real tree — join the huge table right after its own parent, not before or last", () => {
    const db = createJoinOrderDemoDatabase();
    const sql =
      'SELECT * FROM departments JOIN projects ON departments.id = projects.deptId JOIN employees ON departments.id = employees.deptId JOIN timesheets ON employees.id = timesheets.employeeId';
    const parsed = parse(sql);
    if (!parsed.ok) throw new Error(parsed.error.message);

    const { nodes, edges } = joinGraphFromAst(parsed.ast, db.tables, DEFAULT_ENGINE_OPTIONS.rowsPerPage);
    const result = runJoinOrderDP(nodes, edges);
    expect(result.winner.tables).toEqual(['departments', 'employees', 'timesheets', 'projects']);

    const written = writtenOrderFromAst(parsed.ast);
    expect(written).toEqual(['departments', 'projects', 'employees', 'timesheets']);
    const writtenCost = costOfOrder(nodes, edges, written);
    // The DP-optimal order is at least 4× cheaper than the natural-looking "hub, then each branch" order — the
    // whole point of this dataset (seed.ts's own doc comment names the exact 5× figure this measures).
    expect(writtenCost.pages).toBeGreaterThan(result.winner.pages * 4);
  });
});

describe('joinGraphFromAst / writtenOrderFromAst', () => {
  it('extracts every table and edge from a real multi-join AST, in source order', () => {
    const db = createJoinOrderDemoDatabase();
    const sql =
      'SELECT * FROM departments JOIN employees ON departments.id = employees.deptId JOIN timesheets ON employees.id = timesheets.employeeId';
    const parsed = parse(sql);
    if (!parsed.ok) throw new Error(parsed.error.message);

    const { nodes, edges } = joinGraphFromAst(parsed.ast, db.tables, 4);
    expect(nodes.map((n) => n.name)).toEqual(['departments', 'employees', 'timesheets']);
    expect(edges).toHaveLength(2);
    expect(edges[0]).toMatchObject({ a: 'departments', aColumn: 'id', b: 'employees', bColumn: 'deptId' });
    expect(edges[1]).toMatchObject({ a: 'employees', aColumn: 'id', b: 'timesheets', bColumn: 'employeeId' });
    expect(writtenOrderFromAst(parsed.ast)).toEqual(['departments', 'employees', 'timesheets']);
  });

  it('a single-table query (no JOIN) still produces one node and no edges', () => {
    const db = createJoinOrderDemoDatabase();
    const parsed = parse('SELECT * FROM departments');
    if (!parsed.ok) throw new Error(parsed.error.message);
    const { nodes, edges } = joinGraphFromAst(parsed.ast, db.tables, 4);
    expect(nodes).toHaveLength(1);
    expect(edges).toHaveLength(0);
    expect(writtenOrderFromAst(parsed.ast)).toEqual(['departments']);
  });

  it("an ON clause naming an earlier, non-adjacent table still produces the right edge (plan.md §25.4 C3 slice b)", () => {
    const db = createJoinOrderDemoDatabase();
    const sql =
      'SELECT * FROM departments JOIN employees ON departments.id = employees.deptId JOIN projects ON departments.id = projects.deptId';
    const parsed = parse(sql);
    if (!parsed.ok) throw new Error(parsed.error.message);
    const { edges } = joinGraphFromAst(parsed.ast, db.tables, 4);
    // The second edge connects departments (not the immediately preceding `employees`) to projects.
    expect(edges[1]).toMatchObject({ a: 'departments', b: 'projects' });
  });
});
