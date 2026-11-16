import { useMemo } from 'react';
import { precedenceGraph } from '../engine/precedence.ts';
import type { ConflictKind, PrecedenceEdge, PrecedenceGraph } from '../engine/precedence.ts';
import type { ScheduleResult } from '../engine/schedule.ts';
import { serialCheck } from '../engine/serialCheck.ts';
import type { SerialCheck } from '../engine/serialCheck.ts';
import type { Database } from '../engine/types.ts';
import { card } from './primitives.ts';

/**
 * plan.md §27.5 T1: the precedence graph of a run — its committed transactions, an arrow for every conflict, and a
 * cycle named when there is one — beside the replay check that the schedule tool's sibling pages already use, and
 * what it means when the two disagree.
 */

const KIND_WORDS: Record<ConflictKind, string> = {
  ww: 'wrote it, then the other wrote it again',
  wr: 'wrote it, then the other read that',
  rw: 'read it, then the other overwrote it',
};

/** One arrow per ordered pair of nodes, carrying every conflict between them. */
interface Arrow {
  from: string;
  to: string;
  edges: PrecedenceEdge[];
  inCycle: boolean;
}

function arrowsOf(graph: PrecedenceGraph): Arrow[] {
  const cycle = new Set((graph.cycle?.edges ?? []).map((e) => `${e.from}|${e.to}`));
  const byPair = new Map<string, Arrow>();
  for (const e of graph.edges) {
    const key = `${e.from}|${e.to}`;
    const arrow = byPair.get(key) ?? { from: e.from, to: e.to, edges: [], inCycle: cycle.has(key) };
    arrow.edges.push(e);
    byPair.set(key, arrow);
  }
  return [...byPair.values()];
}

const SIZE = 260;
const CENTER = SIZE / 2;
const NODE = 20;

/** The graph, drawn: nodes round a circle in commit order, an arrow for each pair, the cycle in the warning colour. */
function GraphPicture({ graph, labelOf }: { graph: PrecedenceGraph; labelOf: (id: string) => string }) {
  const n = graph.nodes.length;
  const radius = n === 1 ? 0 : 84;
  const at = new Map(
    graph.nodes.map((node, i) => {
      const angle = -Math.PI / 2 + (2 * Math.PI * i) / Math.max(n, 1);
      return [node.id, { x: CENTER + radius * Math.cos(angle), y: CENTER + radius * Math.sin(angle) }] as const;
    }),
  );
  const arrows = arrowsOf(graph);
  const pairs = new Set(arrows.map((a) => `${a.from}|${a.to}`));
  const summary = arrows.length === 0
    ? `${String(n)} committed transaction${n === 1 ? '' : 's'}, no conflicts.`
    : arrows.map((a) => `${labelOf(a.from)} to ${labelOf(a.to)} (${a.edges.map((e) => e.kind).join(', ')})`).join('; ');

  return (
    <svg viewBox={`0 0 ${String(SIZE)} ${String(SIZE)}`} className="mx-auto h-auto w-full max-w-xs" role="img" aria-label={`Precedence graph: ${summary}`}>
      {/* A marker's colour is its own, not the line's: one for an ordinary arrow, one for the cycle's. */}
      <defs>
        <marker id="precedence-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto" className="text-ink-dim">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
        </marker>
        <marker id="precedence-arrow-cycle" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto" className="text-evict">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
        </marker>
      </defs>
      {arrows.map((a) => {
        const p = at.get(a.from)!;
        const q = at.get(a.to)!;
        const dx = q.x - p.x;
        const dy = q.y - p.y;
        const length = Math.hypot(dx, dy) || 1;
        const ux = dx / length;
        const uy = dy / length;
        // Two arrows between the same pair bow apart, so both are seen.
        const bow = pairs.has(`${a.to}|${a.from}`) ? 22 : 0;
        const start = { x: p.x + ux * NODE, y: p.y + uy * NODE };
        const end = { x: q.x - ux * (NODE + 2), y: q.y - uy * (NODE + 2) };
        const control = { x: (start.x + end.x) / 2 - uy * bow, y: (start.y + end.y) / 2 + ux * bow };
        const label = { x: (start.x + 2 * control.x + end.x) / 4 - uy * 9, y: (start.y + 2 * control.y + end.y) / 4 + ux * 9 };
        return (
          <g key={`${a.from}|${a.to}`} className={a.inCycle ? 'text-evict' : 'text-ink-dim'}>
            <path
              d={`M ${String(start.x)} ${String(start.y)} Q ${String(control.x)} ${String(control.y)} ${String(end.x)} ${String(end.y)}`}
              fill="none"
              stroke="currentColor"
              strokeWidth={a.inCycle ? 2.4 : 1.4}
              markerEnd={a.inCycle ? 'url(#precedence-arrow-cycle)' : 'url(#precedence-arrow)'}
            />
            <text x={label.x} y={label.y} textAnchor="middle" dominantBaseline="middle" className="fill-current font-mono text-[10px]">
              {[...new Set(a.edges.map((e) => e.kind))].join(' ')}
            </text>
          </g>
        );
      })}
      {graph.nodes.map((node) => {
        const p = at.get(node.id)!;
        const inCycle = graph.cycle?.nodes.includes(node.id) ?? false;
        return (
          <g key={node.id} className={inCycle ? 'text-evict' : 'text-ink'}>
            <circle cx={p.x} cy={p.y} r={NODE} className="fill-surface-3" stroke="currentColor" strokeWidth={inCycle ? 2.4 : 1.4} />
            <text x={p.x} y={p.y} textAnchor="middle" dominantBaseline="middle" className="fill-current font-mono text-[12px] font-semibold">
              {labelOf(node.id)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/** What the graph says, and whether the replay check agrees — or why the two can differ. */
function verdictOf(graph: PrecedenceGraph, check: SerialCheck, labelOf: (id: string) => string): { graph: string; replay: string } {
  const names = (ids: readonly string[]) => ids.map(labelOf).join(', then ');
  if (graph.nodes.length === 0) {
    return { graph: 'No transaction committed, so there is nothing to put in order.', replay: '' };
  }
  const said = graph.cycle
    ? `Cycle: ${[...graph.cycle.nodes, graph.cycle.nodes[0]!].map(labelOf).join(' → ')}. Each transaction on it has to come before the next, so no serial order respects every conflict — the schedule is not conflict-serializable.`
    : `No cycle, so the schedule is conflict-serializable: running ${names(graph.order ?? [])}, one at a time, would put every conflict the same way round.`;
  if (check.serializable && graph.cycle) {
    return {
      graph: said,
      replay: `The two differ. Replaying the committed transactions as ${names(check.found ?? [])} gives every read the same answer and leaves the same table — but only because the values agree: conflict-serializability asks about the operations, and is the stricter test. (The textbook's other way for the two to differ, a view-serializable schedule, needs blind writes; an UPDATE or DELETE always reads the rows it changes, so here it hardly arises.)`,
    };
  }
  if (check.serializable) {
    return {
      graph: said,
      replay: graph.unseen.length > 0
        ? `The replay check finds a serial order anyway (${names(check.found ?? [])}): what the graph cannot see happened not to change any answer.`
        : `The replay check agrees: replayed one at a time as ${names(check.found ?? [])}, they give every read the same answer and leave the same table.`,
    };
  }
  return {
    graph: said,
    replay: check.exhaustive
      ? 'The replay check agrees: no order of the committed transactions, run one at a time, gives the same reads and the same table.'
      : 'The replay check found no serial order before it gave up searching.',
  };
}

const UNSEEN_WORDS: Record<PrecedenceGraph['unseen'][number]['why'], string> = {
  uncommitted: 'read a version no committed transaction wrote (G1a, an aborted read)',
  intermediate: 'read a version its writer replaced before committing (G1b, an intermediate read)',
  undone: 'was left holding something other than its last committed version — a rollback put back another transaction’s write',
};

export function PrecedencePanel({ result, start }: { result: ScheduleResult; start: Database }) {
  const graph = useMemo(() => precedenceGraph(result), [result]);
  const check = useMemo(() => serialCheck(result, 0, 'commit', start), [result, start]);
  const labelOf = (id: string) => graph.nodes.find((n) => n.id === id)?.label ?? id;
  const { graph: graphSays, replay } = verdictOf(graph, check, labelOf);

  return (
    <section className={card} aria-labelledby="precedence-heading">
      <h2 id="precedence-heading" className="mb-1 text-body font-semibold text-ink">
        Precedence graph
      </h2>
      <p className="mb-3 text-label text-ink-dim">
        One node for each transaction that committed, and an arrow from one to another for every pair of operations on the
        same row that conflict, the earlier to the later: <strong className="font-mono">ww</strong> {KIND_WORDS.ww};{' '}
        <strong className="font-mono">wr</strong> {KIND_WORDS.wr}; <strong className="font-mono">rw</strong> {KIND_WORDS.rw}.
        A read counts the rows its WHERE picks out — and a row inserted later that it would have picked out, a phantom.
        Under versions, &ldquo;earlier&rdquo; is the version a statement actually saw, not the order the statements ran in.
      </p>
      {graph.nodes.length > 0 && <GraphPicture graph={graph} labelOf={labelOf} />}
      <p className={`mt-3 text-label ${graph.cycle ? 'text-evict' : 'text-ink'}`} role="status">
        {graphSays}
      </p>
      {graph.unseen.length > 0 && (
        <ul className="mt-2 list-disc pl-5 text-label text-ink-dim">
          {graph.unseen.map((u) => (
            <li key={`${String(u.step)}|${u.item}|${u.why}`}>
              {u.node === null ? `The table's ${u.item}` : `${labelOf(u.node)}, at step ${String(u.step + 1)}, on ${u.item},`} {UNSEEN_WORDS[u.why]}. A graph of committed
              transactions has no node to draw that from.
            </li>
          ))}
        </ul>
      )}
      {replay && <p className="mt-2 text-label text-ink-dim">{replay}</p>}
      {graph.edges.length > 0 && (
        <table className="mt-3 w-full text-left text-label">
          <caption className="sr-only">Every conflict the graph draws</caption>
          <thead className="text-ink-dim">
            <tr>
              <th scope="col" className="py-1 pr-3 font-medium">From</th>
              <th scope="col" className="py-1 pr-3 font-medium">To</th>
              <th scope="col" className="py-1 pr-3 font-medium">Conflict</th>
              <th scope="col" className="py-1 pr-3 font-medium">Row</th>
              <th scope="col" className="py-1 font-medium">Steps</th>
            </tr>
          </thead>
          <tbody className="text-ink">
            {graph.edges.map((e) => (
              <tr key={`${e.from}|${e.to}|${e.kind}|${e.item}`} className="border-t border-edge">
                <td className="py-1 pr-3 font-mono">{labelOf(e.from)}</td>
                <td className="py-1 pr-3 font-mono">{labelOf(e.to)}</td>
                <td className="py-1 pr-3"><span className="font-mono">{e.kind}</span> — {KIND_WORDS[e.kind]}</td>
                <td className="py-1 pr-3 font-mono">{e.item}</td>
                <td className="py-1 font-mono">{e.steps.map((st) => (st < 0 ? 'start' : String(st + 1))).join(' → ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
