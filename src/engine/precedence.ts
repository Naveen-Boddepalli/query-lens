/**
 * The precedence graph (plan.md §27.5 T1): the committed transactions of a run as nodes, and an edge from one to
 * another for every pair of conflicting operations, earlier to later. A cycle means no serial order can respect every
 * conflict — the schedule is not *conflict-serializable* — and no cycle means the graph's topological order is one
 * that does.
 *
 * "Earlier" is not simply the order the statements ran in. Under versions a read can see a row as it was before a
 * write that ran first, so the graph is built from what each statement actually *saw* — the multiversion form of the
 * graph, which for a single-version schedule is the textbook one:
 *
 * - **ww** — two committed transactions wrote the same row: the one whose version came first, to the other.
 * - **wr** — a statement saw a version another transaction wrote: the writer, to the reader.
 * - **rw** — a statement saw a version that another transaction later replaced: the reader, to the replacer.
 *
 * A statement reads by predicate, not by row: its `WHERE` over its table (or every row, for a statement with a join or
 * a subquery). A version counts only where it matters to that predicate — it matches, or the version it replaced or
 * that replaced it does — so a row a read never picked out is no conflict, and a row inserted to match a read made
 * earlier (a phantom) is one.
 *
 * Rows are told apart by identity, not by value: the engine shares row objects between the table, its versions and
 * every snapshot, so the version a statement saw is the very object some write produced — or one of the rows the run
 * started with.
 *
 * What the graph cannot see, because it is drawn over committed transactions only: a read of a version no committed
 * transaction kept — written by one that rolled back or never ended (G1a), or overwritten by its own writer before it
 * committed (G1b) — and a table left holding something other than every row's last committed version, which a
 * rollback can do where nothing stops two transactions writing the same row (a dirty write). Those are listed in
 * `unseen`; the replay check (`serialCheck.ts`) sees them.
 */

import { passes } from './exec/evaluate.ts';
import { parseStatement, walkExpr } from './parser/index.ts';
import type { Expr } from './parser/index.ts';
import { entriesOf } from './schedule.ts';
import type { ScheduleResult, ScheduleStepResult } from './schedule.ts';
import { transactionsOf } from './serialCheck.ts';
import type { Database, Row } from './types.ts';

export type ConflictKind = 'ww' | 'wr' | 'rw';

export interface PrecedenceNode {
  /** Unique within the graph: a session can commit more than one transaction. */
  id: string;
  session: string;
  /** `A`, or `A #2` for a session's second committed transaction. */
  label: string;
}

export interface PrecedenceEdge {
  from: string;
  to: string;
  kind: ConflictKind;
  /** The row the two operations conflict on, by its table and first column: `accounts (id = 2)`. */
  item: string;
  /** Where in the run's record the two operations ran, in that order. */
  steps: [number, number];
}

export interface PrecedenceGraph {
  /** The committed transactions, in the order they committed. */
  nodes: PrecedenceNode[];
  /** Every conflict, one edge per (from, to, kind, row). */
  edges: PrecedenceEdge[];
  /** A cycle, when there is one: its nodes in order (the first is not repeated at the end) and the edges joining them. */
  cycle: { nodes: string[]; edges: PrecedenceEdge[] } | null;
  /** With no cycle, a serial order that respects every edge — commit order wherever the edges leave a choice. */
  order: string[] | null;
  /**
   * What a graph of committed transactions cannot account for: a read of a version no committed transaction kept
   * (`uncommitted`, G1a; `intermediate`, G1b), and a row the run left holding something other than its last committed
   * version (`undone`) — a rollback that put back another transaction's uncommitted write, or undid a committed one.
   */
  unseen: { node: string | null; step: number; item: string; why: 'uncommitted' | 'intermediate' | 'undone' }[];
}

/** What a statement reads: a predicate over each table it reads, `true` (every row) for any it cannot narrow down. */
interface Read {
  step: number;
  txn: string;
  saw: Database;
  predicates: { table: string; where: Expr | undefined }[];
}

/** One version of one row: the row itself, or `null` for a row that is not there (not yet inserted, or deleted). */
interface Version {
  row: Row | null;
  /** The transaction that wrote it; `start` for a row as the run found it. */
  writer: string;
  step: number;
}

const START = 'start';

/** What a statement reads, from its text: its table and `WHERE`, or every table it can see when that is not enough. */
function predicatesOf(sql: string, saw: Database): Read['predicates'] {
  const parsed = parseStatement(sql);
  const everything = () => Object.keys(saw.tables).map((table) => ({ table, where: undefined }));
  if (!parsed.ok) return [];
  const ast = parsed.ast;
  if (ast.kind === 'insert') return [];
  if (ast.kind === 'analyze') return [{ table: ast.table.name, where: undefined }];
  if (ast.kind === 'update') return [{ table: ast.table.name, where: ast.where }];
  if (ast.kind !== 'select' && ast.kind !== 'delete') return everything();
  if (ast.kind === 'select' && (ast.joins?.length ?? 0) > 0) return everything();
  let opaque = false;
  if (ast.where) {
    walkExpr(ast.where, (e) => {
      if (e.kind === 'exists' || e.kind === 'scalar' || (e.kind === 'in' && e.subquery)) opaque = true;
    });
  }
  return opaque ? everything() : [{ table: ast.from.name, where: ast.where }];
}

/**
 * The precedence graph of `result`. `deferredWrites` is for a protocol whose writes reach the table only when their
 * transaction commits (optimistic control): its versions are ordered by commit, not by the statement that wrote them.
 */
export function precedenceGraph(result: ScheduleResult, deferredWrites = false): PrecedenceGraph {
  const txns = transactionsOf(result);
  const committed = txns.filter((t) => t.fate === 'committed').sort((a, b) => a.ended - b.ended);

  // Ids and labels: a session's committed transactions numbered in commit order when it has more than one.
  const idOf = new Map<(typeof txns)[number], string>();
  txns.forEach((t, i) => idOf.set(t, `${t.session}@${String(t.began)}#${String(i)}`));
  const perSession = new Map<string, number>();
  for (const t of committed) perSession.set(t.session, (perSession.get(t.session) ?? 0) + 1);
  const seenSession = new Map<string, number>();
  const nodes: PrecedenceNode[] = committed.map((t) => {
    const n = (seenSession.get(t.session) ?? 0) + 1;
    seenSession.set(t.session, n);
    return { id: idOf.get(t)!, session: t.session, label: (perSession.get(t.session) ?? 0) > 1 ? `${t.session} #${String(n)}` : t.session };
  });
  const isCommitted = new Set(nodes.map((n) => n.id));
  const commitStep = new Map(committed.map((t) => [idOf.get(t)!, t.ended]));

  // Which transaction each statement belongs to.
  const txnAt = new Map<number, string>();
  for (const t of txns) for (const s of t.statements) txnAt.set(s.at, idOf.get(t)!);

  // Row identity: a row the run started with is its own row; an update's new row is the row it replaced; an insert is
  // a new row. Each row's versions, in the order they were written.
  const rid = new Map<Row, number>();
  const tableOf = new Map<number, string>();
  const chains = new Map<number, Version[]>();
  let nextRid = 0;
  const know = (row: Row, table: string): number => {
    let id = rid.get(row);
    if (id === undefined) {
      id = nextRid;
      nextRid += 1;
      rid.set(row, id);
      tableOf.set(id, table);
      chains.set(id, [{ row, writer: START, step: -1 }]);
    }
    return id;
  };
  const label = new Map<number, string>();
  const describe = (id: number, row: Row): void => {
    if (label.has(id)) return;
    const table = tableOf.get(id) ?? '';
    const [first] = Object.keys(row);
    label.set(id, first === undefined ? table : `${table} (${first} = ${String(row[first] ?? 'NULL')})`);
  };

  /** The versions one write produced, appended to their rows' chains. */
  const record = (step: ScheduleStepResult, at: number, txn: string, saw: Database): void => {
    const write = step.run?.write;
    if (!write) return;
    const before = saw.tables[write.table]?.rows ?? [];
    const order = deferredWrites ? (commitStep.get(txn) ?? at) : at;
    for (const entry of entriesOf(write.kind, write.table, before, write.rows, (row) => know(row, write.table))) {
      if (entry.kind === 'insert') {
        const id = nextRid;
        nextRid += 1;
        rid.set(entry.row, id);
        tableOf.set(id, write.table);
        describe(id, entry.row);
        chains.set(id, [{ row: null, writer: START, step: -1 }, { row: entry.row, writer: txn, step: order }]);
      } else if (entry.kind === 'update') {
        const id = know(entry.before, write.table);
        rid.set(entry.after, id);
        chains.get(id)!.push({ row: entry.after, writer: txn, step: order });
      } else {
        const id = know(entry.row, write.table);
        chains.get(id)!.push({ row: null, writer: txn, step: order });
      }
    }
  };

  // Every statement that ran, in order: the rows it saw (known from here on), what it read, and what it wrote.
  const reads: Read[] = [];
  result.steps.forEach((step, at) => {
    const txn = txnAt.get(at);
    if (step.kind !== 'statement' || step.run === undefined || step.error !== undefined || !step.saw || txn === undefined) return;
    for (const [table, t] of Object.entries(step.saw.tables)) for (const row of t.rows) describe(know(row, table), row);
    reads.push({ step: at, txn, saw: step.saw, predicates: predicatesOf(step.sql, step.saw) });
    record(step, at, txn, step.saw);
  });

  // The committed history of each row: its first version, then every version a committed transaction wrote — only the
  // last of each writer's run of versions, since what it wrote in between no one else should have seen.
  const committedChain = new Map<number, Version[]>();
  for (const [id, chain] of chains) {
    const ordered = [chain[0]!, ...chain.slice(1).filter((v) => isCommitted.has(v.writer)).sort((a, b) => a.step - b.step)];
    const kept = ordered.filter((v, i) => v.writer === START || ordered[i + 1]?.writer !== v.writer);
    committedChain.set(id, kept);
  }

  const edges = new Map<string, PrecedenceEdge>();
  const add = (from: string, to: string, kind: ConflictKind, id: number, steps: [number, number]): void => {
    if (from === to || from === START || !isCommitted.has(from) || !isCommitted.has(to)) return;
    const key = `${from}|${to}|${kind}|${String(id)}`;
    if (!edges.has(key)) edges.set(key, { from, to, kind, item: label.get(id) ?? String(id), steps });
  };

  // ww: consecutive committed versions of a row.
  for (const [id, chain] of committedChain) {
    for (let i = 1; i + 1 < chain.length; i += 1) add(chain[i]!.writer, chain[i + 1]!.writer, 'ww', id, [chain[i]!.step, chain[i + 1]!.step]);
  }

  // wr and rw: what each committed transaction's statements saw, row by row, as far as each statement's predicate goes.
  const unseen: PrecedenceGraph['unseen'] = [];
  const matches = (where: Expr | undefined, row: Row | null | undefined): boolean => row != null && passes(where, row);
  for (const read of reads) {
    if (!isCommitted.has(read.txn)) continue;
    for (const { table, where } of read.predicates) {
      const visible = new Map<number, Row>();
      for (const row of read.saw.tables[table]?.rows ?? []) {
        const id = rid.get(row);
        if (id !== undefined) visible.set(id, row);
      }
      for (const [id, chain] of committedChain) {
        if (tableOf.get(id) !== table) continue;
        const saw = visible.get(id) ?? null;
        let at: number;
        if (saw !== null) {
          at = chain.findIndex((v) => v.row === saw);
          if (at < 0) {
            // Not in the committed history: a version its own transaction wrote (no conflict), one a transaction that
            // never committed wrote, or one its committed writer later replaced itself.
            const all = chains.get(id)!;
            const v = all.find((x) => x.row === saw);
            // It matters to this read if it matches — or hides a committed version that would have.
            if (v === undefined || v.writer === read.txn) continue;
            if (!matches(where, saw) && !chain.some((c) => matches(where, c.row))) continue;
            unseen.push({ node: read.txn, step: read.step, item: label.get(id) ?? String(id), why: isCommitted.has(v.writer) ? 'intermediate' : 'uncommitted' });
            continue;
          }
        } else {
          // Not there: the newest absence written before this statement ran, or the row as the run found it.
          at = -1;
          chain.forEach((v, i) => {
            if (v.row === null && v.step <= read.step) at = i;
          });
          if (at < 0) {
            // A row no committed history removed by then: a deletion that never committed hid it (G1a).
            const hidden = chains.get(id)!.find((v) => v.row === null && v.writer !== read.txn && !isCommitted.has(v.writer) && v.step <= read.step);
            if (hidden && matches(where, chain[0]?.row)) {
              unseen.push({ node: read.txn, step: read.step, item: label.get(id) ?? String(id), why: 'uncommitted' });
            }
            continue;
          }
        }
        // Whether each version of the row is one this read picks out. A read depends on the version whose data it read
        // (one it picks out), and on the last write that changed whether the row is picked out at all; and it comes
        // before the next write to data it read, or — for a row it did not pick out — the first later write that would
        // have put it in its answer.
        const picked = (i: number): boolean => matches(where, chain[i]?.row);
        const wr = (i: number) => add(chain[i]!.writer, read.txn, 'wr', id, [chain[i]!.step, read.step]);
        const rw = (i: number) => add(read.txn, chain[i]!.writer, 'rw', id, [read.step, chain[i]!.step]);
        if (picked(at)) wr(at);
        for (let j = at; j >= 1; j -= 1) {
          if (picked(j) !== picked(j - 1)) {
            wr(j);
            break;
          }
        }
        if (picked(at)) {
          if (at + 1 < chain.length) rw(at + 1);
        } else {
          for (let k = at + 1; k < chain.length; k += 1) {
            if (picked(k)) {
              rw(k);
              break;
            }
          }
        }
      }
    }
  }

  // What survived: each row as the run left it should be its last committed version, or gone if that is a deletion.
  for (const [id, chain] of committedChain) {
    const table = tableOf.get(id) ?? '';
    const last = chain.at(-1)!;
    const left = result.committed.tables[table]?.rows.find((row) => rid.get(row) === id) ?? null;
    const unknown = (result.committed.tables[table]?.rows ?? []).some((row) => !rid.has(row));
    if (left !== last.row && !unknown) unseen.push({ node: null, step: result.steps.length - 1, item: label.get(id) ?? String(id), why: 'undone' });
  }

  const all = [...edges.values()];
  return { nodes, edges: all, cycle: findCycle(nodes, all), order: topologicalOrder(nodes, all), unseen };
}

/** A cycle in the graph, if there is one — found by depth-first search from each node in commit order. */
function findCycle(nodes: readonly PrecedenceNode[], edges: readonly PrecedenceEdge[]): PrecedenceGraph['cycle'] {
  const out = new Map<string, PrecedenceEdge[]>();
  for (const e of edges) out.set(e.from, [...(out.get(e.from) ?? []), e]);
  const state = new Map<string, 'open' | 'done'>();
  const path: PrecedenceEdge[] = [];
  const visit = (node: string, trail: string[]): PrecedenceGraph['cycle'] => {
    state.set(node, 'open');
    for (const e of out.get(node) ?? []) {
      if (state.get(e.to) === 'open') {
        const start = trail.indexOf(e.to);
        const cycleEdges = [...path.slice(start), e];
        return { nodes: trail.slice(start), edges: cycleEdges };
      }
      if (state.get(e.to) === 'done') continue;
      path.push(e);
      const found = visit(e.to, [...trail, e.to]);
      if (found) return found;
      path.pop();
    }
    state.set(node, 'done');
    return null;
  };
  for (const n of nodes) {
    if (state.has(n.id)) continue;
    const found = visit(n.id, [n.id]);
    if (found) return found;
  }
  return null;
}

/** A serial order that respects every edge — commit order wherever the edges allow a choice — or null with a cycle. */
function topologicalOrder(nodes: readonly PrecedenceNode[], edges: readonly PrecedenceEdge[]): string[] | null {
  const incoming = new Map(nodes.map((n) => [n.id, 0]));
  for (const e of edges) incoming.set(e.to, (incoming.get(e.to) ?? 0) + 1);
  const order: string[] = [];
  const left = [...nodes];
  while (left.length > 0) {
    const next = left.findIndex((n) => (incoming.get(n.id) ?? 0) === 0);
    if (next < 0) return null;
    const [n] = left.splice(next, 1);
    order.push(n!.id);
    for (const e of edges) if (e.from === n!.id) incoming.set(e.to, (incoming.get(e.to) ?? 0) - 1);
  }
  return order;
}
